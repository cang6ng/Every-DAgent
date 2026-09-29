/**
 * A scriptable host on the other end of a loopback channel.
 *
 * Everything it sends is built by the protocol's own validator and encoder, so a
 * test can only be wrong about the *semantics* it wants to exercise, never about
 * the bytes. What it deliberately does not do is protect the client: frames can
 * be sent raw, out of order, twice, or not at all, because a hostile peer is the
 * only way to test what a client does with one.
 */

import type {
  ActiveRunSnapshot,
  ClientRequest,
  HostCapabilities,
  HostDescription,
  HostEvent,
  HostSnapshot,
  LiveToolItem,
  OperationMap,
  OperationName,
  PluginSummary,
  ProtocolChannel,
  ProtocolChannelListener,
  ProtocolErrorCode,
  RunSnapshot,
  SessionSnapshot,
  TerminalRunSnapshot,
} from "@every-dagent/protocol";
import { PROTOCOL_VERSION, decodeFrame, encodeFrame, validateMessage } from "@every-dagent/protocol";

type Base = {
  readonly kind: "host-event";
  readonly protocolVersion: "1";
  readonly hostInstanceId: string;
  readonly streamId: string;
  readonly sequence: number;
};

type DecodedMessage = Extract<ReturnType<typeof decodeFrame>, { success: true }>["output"];
type ClientRequestEnvelope = Extract<DecodedMessage, { kind: "client-request" }>;

/** One event a test wants on the current stream, without the envelope boilerplate. */
export type FakeEvent =
  | { readonly type: "session.created"; readonly session: SessionSnapshot }
  | { readonly type: "run.updated"; readonly run: ActiveRunSnapshot }
  | {
      readonly type: "run.output.delta";
      readonly sessionId: string;
      readonly runId: string;
      readonly itemId: string;
      readonly text: string;
    }
  | {
      readonly type: "run.tool.call";
      readonly sessionId: string;
      readonly runId: string;
      readonly item: LiveToolItem;
    }
  | {
      readonly type: "run.tool.result";
      readonly sessionId: string;
      readonly runId: string;
      readonly invocationId: string;
      readonly ok: boolean;
      readonly content: string;
    }
  | { readonly type: "run.ended"; readonly run: TerminalRunSnapshot; readonly session: SessionSnapshot }
  | { readonly type: "plugin.updated"; readonly plugin: PluginSummary }
  | {
      readonly type: "host.request.cancelled";
      readonly requestId: string;
      readonly reason: "cancelled" | "timeout";
    };

export interface FakeHostOptions {
  readonly hostInstanceId?: string;
  readonly capabilities?: Partial<HostCapabilities>;
  /** What the description echoes as the client's own capability. */
  readonly clientCapabilitiesReverse?: boolean;
  readonly maxActiveRuns?: number;
  /** Answer `describe` and `subscriptions.open` on arrival (default: true). */
  readonly auto?: boolean;
}

export interface FakeHost {
  /** Hand this to `createClient({ connect })`. */
  readonly channel: ProtocolChannel;
  readonly hostInstanceId: string;
  /** Every frame the client sent, in arrival order. */
  readonly sent: readonly string[];
  /** Every frame this host sent, in arrival order. */
  readonly delivered: readonly string[];
  /** Every decodable client request, in arrival order. */
  readonly requests: readonly ClientRequest[];
  readonly isClosed: boolean;
  readonly streamIds: readonly string[];
  readonly currentStreamId: string | undefined;
  readonly currentSequence: number;
  /** The params of the most recent `host.describe`. */
  readonly lastDescribe: OperationMap["host.describe"]["params"] | undefined;
  readonly describeCount: number;

  /** Satisfies the pending `describe` (auto-answered unless disabled). */
  serveDescribe(overrides?: Partial<HostDescription>): void;
  /** Satisfies the pending `subscriptions.open` (auto-answered unless disabled). */
  serveOpen(snapshot?: Partial<HostSnapshot>): void;
  /** Answers one request with a result body; throws if the fixture built it invalid. */
  respond(requestId: string, method: OperationName, result: unknown): void;
  respondError(requestId: string, code: ProtocolErrorCode): void;
  /** Emits one valid event on the stream the client currently holds. */
  emit(event: FakeEvent): void;
    /** Sends a frame exactly as given: for malformed, stale or duplicated traffic. */
    sendRaw(frame: string): void;
    /**
     * Delivers a frame to a listener this channel once had, ignoring whether it
     * is still installed — a transport that delivers what it had already
     * accepted when a client goes away.
     */
    deliverLate(frame: string, index?: number): void;
    /** Fires the nth listener's close, however long ago that listener was removed. */
    closeLate(index?: number): void;
  /** Closes the channel from this side. */
  close(): void;
  /** A well-formed snapshot for this host, with the given catalogues. */
  snapshot(fields?: {
    readonly sessions?: readonly SessionSnapshot[];
    readonly runs?: readonly RunSnapshot[];
    readonly plugins?: readonly PluginSummary[];
  }): HostSnapshot;
  /** The request id of the nth request of one method, for answering out of band. */
  requestIdOf(method: OperationName, index?: number): string | undefined;
  /** The raw decoded envelope of the nth request of one method. */
  envelopeOf(method: OperationName, index?: number): ClientRequestEnvelope | undefined;
}

/**
 * Stream ids are unique across every host a test creates.
 *
 * Real hosts never reuse a stream id, and a fixture that restarted its counter
 * per instance would make every reconnect look like a contract violation.
 */
let streamCounter = 0;

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const hostInstanceId = options.hostInstanceId ?? "host-1";
  const capabilities: HostCapabilities = Object.freeze({
    sessions: true,
    runs: true,
    plugins: true,
    subscriptions: true,
    reverseRequests: true,
    ...options.capabilities,
  });
  const auto = options.auto ?? true;

  const sent: string[] = [];
  const delivered: string[] = [];
  const requests: ClientRequest[] = [];
  const envelopes: ClientRequestEnvelope[] = [];
  const streamIds: string[] = [];
  let streamId: string | undefined;
  let sequence = 0;
  let describeParams: OperationMap["host.describe"]["params"] | undefined;
  let describes = 0;
  let descriptionServed = false;

  const state: {
    clientListener?: ProtocolChannelListener;
    hostListener?: ProtocolChannelListener;
    clientClosed: boolean;
    hostClosed: boolean;
  } = { clientClosed: false, hostClosed: false };
  /** Every listener this channel ever had, in order, for the late-delivery tests. */
  const listeners: ProtocolChannelListener[] = [];

  function deliver(frame: string, to: "client" | "host"): void {
    const listener = to === "client" ? state.clientListener : state.hostListener;
    const closed = to === "client" ? state.clientClosed : state.hostClosed;
    if (closed) throw new Error(`the ${to} side is closed`);
    if (listener === undefined) throw new Error(`no listener is installed on the ${to} side`);
    if (to === "client") delivered.push(frame);
    listener.onFrame(frame);
  }

  const clientSide: ProtocolChannel = {
    send(frame: string): void {
      if (state.clientClosed) throw new Error("the client channel is closed");
      sent.push(frame);
      const decoded = decodeFrame(frame);
      if (!decoded.success) return;
      if (decoded.output.kind !== "client-request") return;
      const envelope: ClientRequestEnvelope = decoded.output;
      const validated = validateMessage({ kind: "client-request" }, envelope);
      if (!validated.success) return;
      requests.push(validated.output);
      envelopes.push(envelope);

      const request = validated.output;
      if (request.method === "host.describe") {
        describes += 1;
        describeParams = request.params;
        if (auto && !descriptionServed) serveDescribe();
        return;
      }
      if (auto && request.method === "subscriptions.open") serveOpen();
    },
    listen(listener: ProtocolChannelListener): () => void {
      listeners.push(listener);
      state.clientListener = listener;
      return (): void => {
        if (state.clientListener === listener) state.clientListener = undefined;
      };
    },
    close(): void {
      if (state.clientClosed) return;
      state.clientClosed = true;
      state.hostClosed = true;
      state.hostListener?.onClose();
    },
  };

  const hostSide: ProtocolChannel = {
    send(frame: string): void {
      if (state.hostClosed) throw new Error("the host channel is closed");
      deliver(frame, "client");
    },
    listen(listener: ProtocolChannelListener): () => void {
      state.hostListener = listener;
      return (): void => {
        if (state.hostListener === listener) state.hostListener = undefined;
      };
    },
    close(): void {
      if (state.hostClosed) return;
      state.hostClosed = true;
      state.clientClosed = true;
      state.clientListener?.onClose();
    },
  };

  function sendEvent(message: HostEvent): void {
    const encoded = encodeFrame({ kind: "host-event" }, message);
    if (!encoded.success) throw new Error(`the fixture built an invalid event: ${encoded.failure.reason}`);
    hostSide.send(encoded.output);
  }

  function serveDescribe(overrides: Partial<HostDescription> = {}): void {
    const envelope = envelopes.at(-1);
    const requestId = envelope?.requestId;
    if (requestId === undefined) throw new Error("no describe request has arrived");
    descriptionServed = true;

    const response = {
      kind: "host-response",
      protocolVersion: PROTOCOL_VERSION,
      hostInstanceId,
      requestId,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        hostInstanceId,
        host: { name: "fake-host", version: "1.0.0" },
        capabilities,
        clientCapabilities: { reverseRequests: options.clientCapabilitiesReverse ?? true },
        limits: { maxActiveRuns: options.maxActiveRuns ?? 1 },
        retention: "host-lifetime",
        ...overrides,
      },
    };
    const validated = validateMessage({ kind: "host-response", method: "host.describe" }, response);
    if (!validated.success) throw new Error(`the fixture built an invalid description: ${validated.failure.reason}`);
    const encoded = encodeFrame({ kind: "host-response", method: "host.describe" }, validated.output);
    if (!encoded.success) throw new Error("the fixture could not encode the description");
    hostSide.send(encoded.output);
  }

  function snapshot(
    fields: {
      readonly sessions?: readonly SessionSnapshot[];
      readonly runs?: readonly RunSnapshot[];
      readonly plugins?: readonly PluginSummary[];
    } = {},
  ): HostSnapshot {
    return Object.freeze({
      hostInstanceId,
      watermark: Object.freeze({ streamId: streamId ?? "unopened", sequence: 0 }),
      sessions: Object.freeze([...(fields.sessions ?? [])]),
      runs: Object.freeze([...(fields.runs ?? [])]),
      plugins: Object.freeze([...(fields.plugins ?? [])]),
    });
  }

  function serveOpen(fields: Partial<HostSnapshot> = {}): void {
    const envelope = [...envelopes].reverse().find((candidate) => candidate.method === "subscriptions.open");
    const requestId = envelope?.requestId;
    if (requestId === undefined) throw new Error("no subscriptions.open request has arrived");

    streamId = `stream-${(streamCounter += 1)}`;
    streamIds.push(streamId);
    sequence = 0;

    const response = {
      kind: "host-response",
      protocolVersion: PROTOCOL_VERSION,
      hostInstanceId,
      requestId,
      result: { snapshot: { ...snapshot(), ...fields, watermark: { streamId, sequence: 0 } } },
    };
    const validated = validateMessage({ kind: "host-response", method: "subscriptions.open" }, response);
    if (!validated.success) throw new Error(`the fixture built an invalid snapshot: ${validated.failure.reason}`);
    const encoded = encodeFrame({ kind: "host-response", method: "subscriptions.open" }, validated.output);
    if (!encoded.success) throw new Error("the fixture could not encode the snapshot");
    hostSide.send(encoded.output);
  }

  function respond(requestId: string, method: OperationName, result: unknown): void {
    const candidate = {
      kind: "host-response",
      protocolVersion: PROTOCOL_VERSION,
      hostInstanceId,
      requestId,
      result,
    };
    const validated = validateMessage({ kind: "host-response", method }, candidate);
    if (!validated.success) {
      throw new Error(`the fixture built an invalid ${method} response: ${validated.failure.reason}`);
    }
    // The message has already been through the real validator, so serializing
    // the validated snapshot is exactly what the encoder would produce — while
    // keeping this fixture free of a per-method encoder table.
    hostSide.send(JSON.stringify(validated.output));
  }

  function respondError(requestId: string, code: ProtocolErrorCode): void {
    const encoded = encodeFrame(
      { kind: "host-response" },
      {
        kind: "host-response",
        protocolVersion: PROTOCOL_VERSION,
        hostInstanceId,
        requestId,
        error: { code, message: `fake host: ${code}` },
      },
    );
    if (!encoded.success) throw new Error("the fixture could not encode its error");
    hostSide.send(encoded.output);
  }

  function emit(event: FakeEvent): void {
    if (streamId === undefined) throw new Error("no subscription is open");
    sequence += 1;
    const base: Base = {
      kind: "host-event",
      protocolVersion: PROTOCOL_VERSION,
      hostInstanceId,
      streamId,
      sequence,
    };

    switch (event.type) {
      case "session.created":
        sendEvent({
          ...base,
          type: "session.created",
          scope: { kind: "session", sessionId: event.session.sessionId },
          payload: { session: event.session },
        });
        return;
      case "run.updated":
        sendEvent({
          ...base,
          type: "run.updated",
          scope: { kind: "run", sessionId: event.run.sessionId, runId: event.run.runId },
          payload: { run: event.run },
        });
        return;
      case "run.output.delta":
        sendEvent({
          ...base,
          type: "run.output.delta",
          scope: { kind: "run", sessionId: event.sessionId, runId: event.runId },
          payload: { itemId: event.itemId, text: event.text },
        });
        return;
      case "run.tool.call":
        sendEvent({
          ...base,
          type: "run.tool.call",
          scope: { kind: "run", sessionId: event.sessionId, runId: event.runId },
          payload: { item: event.item },
        });
        return;
      case "run.tool.result":
        sendEvent({
          ...base,
          type: "run.tool.result",
          scope: { kind: "run", sessionId: event.sessionId, runId: event.runId },
          payload: { invocationId: event.invocationId, ok: event.ok, content: event.content },
        });
        return;
      case "run.ended":
        sendEvent({
          ...base,
          type: "run.ended",
          scope: { kind: "run", sessionId: event.run.sessionId, runId: event.run.runId },
          payload: { run: event.run, session: event.session },
        });
        return;
      case "plugin.updated":
        sendEvent({
          ...base,
          type: "plugin.updated",
          scope: { kind: "plugin", pluginId: event.plugin.id },
          payload: { plugin: event.plugin },
        });
        return;
      case "host.request.cancelled":
        sendEvent({
          ...base,
          type: "host.request.cancelled",
          scope: { kind: "host" },
          payload: { requestId: event.requestId, reason: event.reason },
        });
        return;
    }
  }

  return {
    channel: clientSide,
    hostInstanceId,
    get sent(): readonly string[] {
      return sent;
    },
    get delivered(): readonly string[] {
      return delivered;
    },
    get requests(): readonly ClientRequest[] {
      return requests;
    },
    get isClosed(): boolean {
      return state.clientClosed;
    },
    get streamIds(): readonly string[] {
      return streamIds;
    },
    get currentStreamId(): string | undefined {
      return streamId;
    },
    get currentSequence(): number {
      return sequence;
    },
    get lastDescribe(): OperationMap["host.describe"]["params"] | undefined {
      return describeParams;
    },
    get describeCount(): number {
      return describes;
    },

    serveDescribe,
    serveOpen,
    respond,
    respondError,
    emit,
    sendRaw(frame: string): void {
      hostSide.send(frame);
    },
    deliverLate(frame: string, index = 0): void {
      const listener = listeners[index];
      if (listener === undefined) throw new Error(`no listener ${index} was ever installed`);
      delivered.push(frame);
      listener.onFrame(frame);
    },
    closeLate(index = 0): void {
      const listener = listeners[index];
      if (listener === undefined) throw new Error(`no listener ${index} was ever installed`);
      listener.onClose();
    },
    close(): void {
      hostSide.close();
    },
    snapshot,
    requestIdOf(method: OperationName, index = 0): string | undefined {
      return envelopes.filter((candidate) => candidate.method === method)[index]?.requestId;
    },
    envelopeOf(method: OperationName, index = 0): ClientRequestEnvelope | undefined {
      return envelopes.filter((candidate) => candidate.method === method)[index];
    },
  };
}
