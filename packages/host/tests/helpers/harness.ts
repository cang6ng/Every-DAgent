/**
 * Fixtures for driving a real host over a real frame boundary.
 *
 * Everything a test sends is built, validated and encoded by the protocol
 * package, and everything it reads is decoded and validated the same way — the
 * frames cross as strings through the loopback channel, so no test can pass by
 * handing a DTO object to the host directly.
 */

import type {
  ContextBuilder,
  ModelClient,
  ModelEvent,
  ModelRequest,
  RuntimeContext,
  Tool,
} from "@every-dagent/agent-core";
import type { Plugin, PluginContext, PluginPermission } from "@every-dagent/plugin-system";
import type {
  DecodedEnvelope,
  HostEvent,
  HostRequest,
  HostResponse,
  JsonValue,
  OperationMap,
  OperationName,
  ProtocolChannel,
  ProtocolError,
  ProtocolErrorCode,
} from "@every-dagent/protocol";
import { decodeFrame, encodeFrame, validateMessage } from "@every-dagent/protocol";

import { createHost, type Host } from "../../src/index.js";
import { createMemoryChannelPair } from "./memory-channel.js";

// ---------------------------------------------------------------------------
// Time and sequencing.
// ---------------------------------------------------------------------------

/** Lets every pending microtask and timer callback of this tick run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

/** A one-shot latch: the deferred tool, activation and stream in the tests. */
export function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

let sequence = 0;

/** A fresh id for the tests' own request and submission ids. */
export function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

// ---------------------------------------------------------------------------
// The host under test.
// ---------------------------------------------------------------------------

export interface TestHostOptions {
  readonly modelClient: ModelClient;
  readonly plugins?: readonly Plugin[];
  readonly contextBuilder?: ContextBuilder;
  readonly grants?: Readonly<Record<string, readonly PluginPermission[]>>;
}

export function testHost(options: TestHostOptions): Host {
  return createHost({
    modelClient: options.modelClient,
    plugins: options.plugins ?? [],
    ...(options.contextBuilder === undefined ? {} : { contextBuilder: options.contextBuilder }),
    ...(options.grants === undefined ? {} : { grants: options.grants }),
  });
}

// ---------------------------------------------------------------------------
// A frame-level client.
// ---------------------------------------------------------------------------

export interface CallOptions {
  /** Reuse a request id, to test what the host does with a duplicate. */
  readonly requestId?: string;
  /** Send a request that names a different host instance. */
  readonly hostInstanceId?: string;
  /** Send a business request before `host.describe`. */
  readonly withoutDescribe?: boolean;
}

export interface TestClient {
  readonly channel: ProtocolChannel;
  /** Every frame this client received, in arrival order. */
  readonly frames: readonly string[];
  /** Every host event that validated, in arrival order. */
  readonly events: readonly HostEvent[];
  /** True once the host closed this connection. */
  readonly isClosed: boolean;
  /** The host instance this connection described, once it has. */
  readonly hostInstanceId: string | undefined;
  describe(options?: CallOptions): Promise<HostResponse<"host.describe">>;
  call<M extends OperationName>(
    method: M,
    params: OperationMap[M]["params"],
    options?: CallOptions,
  ): Promise<HostResponse<M>>;
  /** Sends a frame the fixture did not build, e.g. malformed JSON. */
  sendRaw(frame: string): void;
  /** Resolves with the first (or next) event of this type that matches. */
  waitForEvent<T extends HostEvent["type"]>(
    type: T,
    match?: (event: Extract<HostEvent, { type: T }>) => boolean,
  ): Promise<Extract<HostEvent, { type: T }>>;
  /** Ends this logical connection without cancelling anything. */
  detach(): void;
}

/** Answers one `host-request` the host sent this fixture. */
export interface ReverseAnswer {
  /** Sends the success body; the frame is validated and encoded by the protocol. */
  respond(result: JsonValue): void;
  /** Sends a safe error body. */
  fail(code: ProtocolErrorCode): void;
  /** Sends nothing at all — the request stays pending until its scope ends. */
  ignore(): void;
}

export interface ConnectOptions {
  /**
   * Wraps the channel the host is given, so a test can make closing the
   * connection do something of its own — including calling back into the host.
   */
  readonly wrapHostChannel?: (channel: ProtocolChannel) => ProtocolChannel;
  /** What this client declares for the reverse capability (default: false). */
  readonly reverseRequests?: boolean;
  /** Called for every reverse request this client receives. */
  readonly onReverse?: (request: HostRequest, answer: ReverseAnswer) => void;
}

export function connect(host: Host, options: ConnectOptions = {}): TestClient {
  const { clientSide, hostSide } = createMemoryChannelPair();
  const frames: string[] = [];
  const events: HostEvent[] = [];
  const waiters: {
    readonly match: (event: HostEvent) => boolean;
    readonly resolve: (event: HostEvent) => void;
  }[] = [];
  const pending = new Map<string, (envelope: DecodedEnvelope) => void>();
  const declaredCapabilities = { reverseRequests: options.reverseRequests ?? false };

  let hostInstanceId: string | undefined;
  let closed = false;
  let detached = false;

  const hostChannel =
    options.wrapHostChannel === undefined ? hostSide : options.wrapHostChannel(hostSide);
  const detachHost = host.attach(hostChannel);

  function sendClientResponse(
    request: HostRequest,
    body: { readonly result: JsonValue } | { readonly error: ProtocolError },
  ): void {
    const candidate =
      "result" in body
        ? {
            kind: "client-response",
            protocolVersion: "1",
            hostInstanceId: request.hostInstanceId,
            streamId: request.streamId,
            requestId: request.requestId,
            result: body.result,
          }
        : {
            kind: "client-response",
            protocolVersion: "1",
            hostInstanceId: request.hostInstanceId,
            streamId: request.streamId,
            requestId: request.requestId,
            error: body.error,
          };

    const validated = validateMessage({ kind: "client-response" }, candidate);
    if (!validated.success) {
      throw new Error(`the fixture built an invalid client response: ${validated.failure.reason}`);
    }
    const encoded = encodeFrame({ kind: "client-response" }, validated.output);
    if (!encoded.success) throw new Error("the fixture could not encode its client response");
    clientSide.send(encoded.output);
  }

  clientSide.listen({
    onFrame(frame: string): void {
      frames.push(frame);

      const decoded = decodeFrame(frame);
      if (!decoded.success) return;
      const envelope = decoded.output;

      if (envelope.kind === "host-response") {
        const waiter = pending.get(envelope.requestId);
        if (waiter !== undefined) {
          pending.delete(envelope.requestId);
          waiter(envelope);
        }
        return;
      }

      if (envelope.kind === "host-request") {
        if (options.onReverse === undefined) return;
        const validated = validateMessage({ kind: "host-request" }, envelope);
        if (!validated.success) return;
        options.onReverse(validated.output, {
          respond: (result: JsonValue): void => {
            sendClientResponse(validated.output, { result });
          },
          fail: (code: ProtocolErrorCode): void => {
            sendClientResponse(validated.output, { error: { code, message: `test client: ${code}` } });
          },
          ignore: (): void => undefined,
        });
        return;
      }

      if (envelope.kind !== "host-event") return;
      const validated = validateMessage({ kind: "host-event" }, envelope);
      if (!validated.success) return;
      events.push(validated.output);

      for (const waiter of [...waiters]) {
        if (!waiter.match(validated.output)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(validated.output);
      }
    },
    onClose(): void {
      closed = true;
    },
  });

  function frameFor(method: OperationName, params: unknown, options: CallOptions | undefined): string {
    const requestId = options?.requestId ?? nextId("req");
    const input: Record<string, unknown> = {
      kind: "client-request",
      protocolVersion: "1",
      requestId,
      method,
      params,
    };

    if (method !== "host.describe") {
      const instance = options?.hostInstanceId ?? hostInstanceId;
      if (instance !== undefined) input["hostInstanceId"] = instance;
    }

    // Built through the real validator and encoder: a fixture that produced an
    // invalid request would fail here rather than test something else.
    const validated = validateMessage({ kind: "client-request" }, input);
    if (!validated.success) {
      throw new Error(`the fixture built an invalid ${method} request: ${validated.failure.reason}`);
    }
    const encoded = encodeFrame({ kind: "client-request" }, validated.output);
    if (!encoded.success) throw new Error(`the fixture could not encode its ${method} request`);
    return encoded.output;
  }

  function call<M extends OperationName>(
    method: M,
    params: OperationMap[M]["params"],
    options?: CallOptions,
  ): Promise<HostResponse<M>> {
    const frame = frameFor(method, params, options);
    const requestId = (JSON.parse(frame) as { requestId: string }).requestId;

    return new Promise<HostResponse<M>>((resolve, reject) => {
      pending.set(requestId, (envelope) => {
        const validated = validateMessage({ kind: "host-response", method }, envelope);
        if (!validated.success) {
          reject(new Error(`the host's ${method} response did not validate: ${validated.failure.reason}`));
          return;
        }
        resolve(validated.output);
      });

      try {
        clientSide.send(frame);
      } catch (error) {
        pending.delete(requestId);
        reject(error);
      }
    });
  }

  return {
    channel: clientSide,
    get frames(): readonly string[] {
      return frames;
    },
    get events(): readonly HostEvent[] {
      return events;
    },
    get isClosed(): boolean {
      return closed;
    },
    get hostInstanceId(): string | undefined {
      return hostInstanceId;
    },

    async describe(options?: CallOptions): Promise<HostResponse<"host.describe">> {
      const response = await call("host.describe", {
        supportedProtocolVersions: ["1"],
        client: { name: "test-client", version: "0.1.0" },
        capabilities: declaredCapabilities,
      }, options);
      if (response.result !== undefined) hostInstanceId = response.result.hostInstanceId;
      return response;
    },

    call,

    sendRaw(frame: string): void {
      clientSide.send(frame);
    },

    waitForEvent<T extends HostEvent["type"]>(
      type: T,
      match?: (event: Extract<HostEvent, { type: T }>) => boolean,
    ): Promise<Extract<HostEvent, { type: T }>> {
      const predicate = (event: HostEvent): event is Extract<HostEvent, { type: T }> => {
        if (event.type !== type) return false;
        return match === undefined || match(event as Extract<HostEvent, { type: T }>);
      };

      const existing = events.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);

      return new Promise((resolve) => {
        waiters.push({
          match: predicate,
          resolve: (event) => {
            resolve(event as Extract<HostEvent, { type: T }>);
          },
        });
      });
    },

    detach(): void {
      if (detached) return;
      detached = true;
      detachHost();
    },
  };
}

// ---------------------------------------------------------------------------
// Model clients.
// ---------------------------------------------------------------------------

export type ModelReply =
  | readonly ModelEvent[]
  | ((request: ModelRequest, context: RuntimeContext) => AsyncIterable<ModelEvent>);

export interface ScriptedModel {
  readonly client: ModelClient;
  readonly requests: ModelRequest[];
}

/**
 * A scripted model client: the nth `stream()` call replays the nth reply.
 *
 * The script is not recycled unless asked, so a host that makes one call too
 * many fails loudly instead of quietly repeating an answer.
 */
export function scriptedModel(
  replies: readonly ModelReply[],
  options: { readonly repeatLast?: boolean } = {},
): ScriptedModel {
  const requests: ModelRequest[] = [];
  let calls = 0;

  const client: ModelClient = {
    stream(request: ModelRequest, context: RuntimeContext): AsyncIterable<ModelEvent> {
      requests.push(request);
      const reply = replies[calls] ?? (options.repeatLast === true ? replies[replies.length - 1] : undefined);
      calls += 1;
      if (reply === undefined) throw new Error("the scripted model client ran out of replies");
      return typeof reply === "function" ? reply(request, context) : replay(reply);
    },
  };

  return { client, requests };
}

async function* replay(events: readonly ModelEvent[]): AsyncGenerator<ModelEvent> {
  yield* events;
}

/** One step that answers with text. */
export function textReply(text: string): readonly ModelEvent[] {
  return [
    { type: "text-delta", text },
    { type: "done" },
  ];
}

/** One step that asks for a tool. */
export function toolReply(callId: string, name: string, input: unknown): readonly ModelEvent[] {
  return [
    { type: "tool-call", call: { callId, name, input } },
    { type: "done" },
  ];
}

/** One step that says something *and* asks for a tool — the same step, as the Core sees it. */
export function textAndToolReply(
  text: string,
  callId: string,
  name: string,
  input: unknown,
): readonly ModelEvent[] {
  return [
    { type: "text-delta", text },
    { type: "tool-call", call: { callId, name, input } },
    { type: "done" },
  ];
}

/** A step that says something, then fails: the text reached the audience, the step did not finish. */
export function replyThenFail(events: readonly ModelEvent[], error: unknown): ModelReply {
  return async function* (): AsyncGenerator<ModelEvent> {
    yield* events;
    throw error;
  };
}

/** A step that says something and then waits for the turn to be aborted. */
export function partialThenAbortReply(text: string): ModelReply {
  return async function* (_request: ModelRequest, context: RuntimeContext): AsyncGenerator<ModelEvent> {
    yield { type: "text-delta", text };
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) {
        resolve();
        return;
      }
      context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
}

/** A step that never answers, until the gate opens. */
export function gatedReply(gateToAwait: Gate, then: readonly ModelEvent[] = textReply("late")): ModelReply {
  return async function* (): AsyncGenerator<ModelEvent> {
    await gateToAwait.promise;
    yield* then;
  };
}

/** A step that stops the moment the turn is aborted, without producing output. */
export function abortAwareReply(): ModelReply {
  return async function* (_request: ModelRequest, context: RuntimeContext): AsyncGenerator<ModelEvent> {
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) {
        resolve();
        return;
      }
      context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
}

// ---------------------------------------------------------------------------
// Tools and plugins.
// ---------------------------------------------------------------------------

export function constantTool(name: string, value: unknown = "ok"): Tool {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    execute: async () => value,
  };
}

/** Records every input it is handed, so a test can prove what the tool really saw. */
export function recordingTool(name: string, seen: unknown[]): Tool {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    execute: async (input: unknown) => {
      seen.push(input);
      return "recorded";
    },
  };
}

/**
 * A tool that runs until the gate opens, whatever the signal says.
 *
 * `starts` opens when execution has actually begun, so a test can cancel
 * exactly when the call is in flight rather than racing the Core's own
 * pre-cancellation checkpoint.
 */
export function gatedTool(name: string, release: Gate, starts?: Gate): Tool {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    execute: async () => {
      starts?.open();
      await release.promise;
      return "finished";
    },
  };
}

/** Cooperates with cancellation: it settles as soon as the turn is aborted. */
export function cooperativeTool(name: string): Tool {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    execute: async (_input: unknown, context: RuntimeContext) => {
      if (context.signal.aborted) return "cancelled before start";
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return "cancelled";
    },
  };
}

export interface TestPluginOptions {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly permissions?: readonly PluginPermission[];
  readonly tools?: readonly Tool[];
  readonly activate?: (context: PluginContext) => void | Promise<void>;
}

export function testPlugin(options: TestPluginOptions): Plugin {
  return {
    manifest: {
      id: options.id,
      name: options.name ?? `Plugin ${options.id}`,
      version: options.version ?? "1.0.0",
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    },
    activate: (context: PluginContext): void | Promise<void> => {
      for (const tool of options.tools ?? []) context.tools.register(tool);
      return options.activate?.(context);
    },
  };
}

/**
 * A plugin whose activation fails after staging a tool, with a cleanup that
 * may fail too — the two halves of the manager's failure reporting.
 */
export function failingPlugin(id: string, options: { readonly cleanupFails?: boolean } = {}): Plugin {
  return {
    manifest: { id, name: `Plugin ${id}`, version: "1.0.0" },
    activate: (context: PluginContext): void => {
      context.tools.register(constantTool(`${id}-tool`));
      if (options.cleanupFails === true) {
        context.onDispose(() => {
          throw new Error("cleanup exploded: super-secret-token");
        });
      }
      throw new Error("activation exploded: super-secret-token");
    },
  };
}

// ---------------------------------------------------------------------------
// Run helpers.
// ---------------------------------------------------------------------------

/**
 * Waits for a run's terminal publication, reading the directory rather than the
 * event stream.
 *
 * Polling `runs.get` is what makes this usable whether or not the client holds
 * a subscription, and whether the run settled before or after it connected —
 * exactly the position a reconnecting client is in. Event-level assertions
 * belong in the tests that open a subscription on purpose.
 */
export async function awaitRunTerminal(
  client: TestClient,
  runId: string,
  timeoutMs = 3000,
): Promise<Extract<HostEvent, { type: "run.ended" }>["payload"]["run"]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await client.call("runs.get", { runId });
    const run = response.result?.run;
    if (run !== undefined && run.live === null) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not settle in time`);
    await flush();
  }
}

/** Starts a run and waits for its terminal publication. */
export async function runToTerminal(
  client: TestClient,
  sessionId: string,
  text: string,
  submissionId: string = nextId("sub"),
): Promise<Extract<HostEvent, { type: "run.ended" }>["payload"]["run"]> {
  const response = await client.call("runs.start", { sessionId, submissionId, text });
  if (response.result === undefined) {
    throw new Error(`runs.start failed: ${response.error.code}`);
  }
  return awaitRunTerminal(client, response.result.run.runId);
}

/** Creates a session through the protocol and returns its snapshot. */
export async function createSessionThrough(client: TestClient) {
  const response = await client.call("sessions.create", {});
  if (response.result === undefined) throw new Error(`sessions.create failed: ${response.error.code}`);
  return response.result.session;
}

export function errorCode(response: { readonly error?: ProtocolError }): string | undefined {
  return response.error?.code;
}
