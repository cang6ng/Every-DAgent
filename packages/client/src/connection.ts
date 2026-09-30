/**
 * The connection: one logical connection to a host, from the connector promise
 * to the last frame it will ever send.
 *
 * Four separations run through this module.
 *
 * The first is epoch versus identity. Every attempt at a connection gets a local
 * `epoch`; every callback — connector completion, frame, close, timer, reverse
 * handler, an `await` continuation — is bound to the attempt that created it,
 * and anything arriving from an older one is inert. `hostInstanceId` is a
 * different fact: it is the host's own identity, learned from `host.describe`,
 * and it distinguishes *which* host this is, never *which* connection.
 *
 * The second is invalidation before publication. A connection that is ending is
 * torn down first — epoch, channel, identity, stream, control ownership,
 * pending — and only then does the client say so. A listener that hears
 * "disconnected" is hearing about a client that can no longer send, reconnect on
 * a stale path, or overwrite a newer attempt.
 *
 * The third is the frame path versus everything foreign. Frames are routed
 * synchronously: a response settles its pending, an event folds, and the
 * subscription snapshot is installed before the frames behind it are read. A
 * control transaction — `open` above all — takes its ownership synchronously,
 * before it notifies or sends anything, so a reentrant listener starts a *new*
 * transaction instead of joining one that finished.
 *
 * The fourth is the presentation versus the caller. Only a validated open
 * snapshot and validated events move the shared presentation; an operation
 * response resolves its caller and touches nothing else.
 */

import type {
  ClientCapabilities,
  DecodedEnvelope,
  HostCapabilities,
  HostDescription,
  HostSnapshot,
  JsonValue,
  OperationMap,
  OperationName,
  ProtocolChannel,
  Watermark,
} from "@every-dagent/protocol";
import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  validateJsonValue,
  validateMessage,
} from "@every-dagent/protocol";

import type { ClientMisuseReason, ConnectionLostReason, ProtocolViolationReason } from "./errors.js";
import { ClientError, clientMisuse, connectionLost, protocolViolation, remoteError } from "./errors.js";
import { deepFreeze, foldEvent } from "./fold.js";
import type { ReverseHandlerContext, ReverseHandlerOutcome, ReverseTable } from "./reverse.js";
import type { ClientSnapshot, ConnectionStatus, PresentationStore } from "./store.js";
import { createStore } from "./store.js";

type ResponseEnvelope = Extract<DecodedEnvelope, { kind: "host-response" }>;
type EventEnvelope = Extract<DecodedEnvelope, { kind: "host-event" }>;
type RequestEnvelope = Extract<DecodedEnvelope, { kind: "host-request" }>;

/** Business requests one connection may have outstanding. */
const MAX_ORDINARY_PENDING = 128;
/** The control slots, reserved on top of them: an `open` must never be refused because business traffic is busy. */
const MAX_CONTROL_PENDING = 2;
/** How long a control request (`describe`, `open`, `close`) may wait for an answer. */
const CONTROL_DEADLINE_MS = 10_000;
/** How many reverse handlers may be running at once. */
const MAX_REVERSE_PENDING = 32;
/** How many reverse request ids one connection may spend before uniqueness cannot be proved. */
const MAX_REVERSE_HISTORY = 4096;
/**
 * How many retired stream ids one connection remembers.
 *
 * Streams are never reused, so this is the client's proof that a frame belongs
 * to a stream it has already ended. Forgetting an id would mean accepting its
 * frames again; the budget is finite, and using it up ends the connection
 * honestly instead of degrading into guesswork.
 */
const RETIRED_STREAM_BUDGET = 256;

const MAX_TIMER_DELAY = 2 ** 31 - 1;

/** The methods that keep this connection synchronized, and pay for their own capacity. */
const CONTROL_METHODS: ReadonlySet<OperationName> = new Set<OperationName>([
  "host.describe",
  "subscriptions.open",
  "subscriptions.close",
]);

/** A wait that survives a legal `timeoutMs` past `setTimeout`'s ceiling. */
function scheduleDeadline(deadline: number, fire: () => void): { cancel(): void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const arm = (): void => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      fire();
      return;
    }
    handle = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY));
  };

  arm();

  return {
    cancel: (): void => {
      cancelled = true;
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

/** Which capability an operation needs before it may be sent at all. */
const CAPABILITY_OF: Readonly<Record<OperationName, keyof HostCapabilities | undefined>> = Object.freeze({
  "host.describe": undefined,
  "sessions.list": "sessions",
  "sessions.create": "sessions",
  "sessions.get": "sessions",
  "runs.start": "runs",
  "runs.get": "runs",
  "runs.cancel": "runs",
  "plugins.list": "plugins",
  "plugins.enable": "plugins",
  "plugins.disable": "plugins",
  "subscriptions.open": "subscriptions",
  "subscriptions.close": "subscriptions",
});

interface PendingRequest {
  readonly method: OperationName;
  /** Control requests are the ones this connection cannot work without. */
  readonly control: boolean;
  readonly complete: (envelope: ResponseEnvelope) => void;
  /** Ends the caller's wait without an answer. */
  readonly fail: (error: ClientError) => void;
  /** The bounded wait a control request is given; business requests have none. */
  timer: { cancel(): void } | undefined;
}

interface ReversePending {
  readonly requestId: string;
  readonly streamId: string;
  /** The connection attempt this request arrived on; an older one is inert. */
  readonly epoch: number;
  /** This profile's own result contract: what may travel back as a success. */
  readonly resultIsValid: (result: JsonValue) => boolean;
  readonly controller: AbortController;
  timer: { cancel(): void } | undefined;
  finished: boolean;
}

interface Attempt {
  readonly epoch: number;
  aborted: boolean;
  readonly promise: Promise<void>;
  readonly settle: { resolve(): void; reject(error: unknown): void };
}

interface Identity {
  readonly hostInstanceId: string;
  readonly description: HostDescription;
}

interface StreamState {
  readonly streamId: string;
  expected: number;
}

/** The control ownership one `open` transaction holds while it is in flight. */
interface OpenToken {
  readonly attempt: number;
  readonly token: symbol;
}

interface SendHandlers<M extends OperationName> {
  readonly accept: (result: OperationMap[M]["result"], envelope: ResponseEnvelope) => void;
  readonly decline: (error: ClientError) => void;
}

export interface ClientOptions {
  /** Establishes one logical connection; the channel it resolves with is already open. */
  readonly connect: () => Promise<ProtocolChannel>;
  /** How this client names itself to the host. */
  readonly client?: { readonly name: string; readonly version: string };
}

const DEFAULT_CLIENT = Object.freeze({ name: "@every-dagent/client", version: "0.1.0" });

/** Every field a result must agree with, when the request named one. */
function verifyResultIdentity(
  method: OperationName,
  params: unknown,
  result: unknown,
): ProtocolViolationReason | undefined {
  const resultFields = fieldsOf(result);
  const paramFields = fieldsOf(params);
  const fail = "result-identity" as const;

  switch (method) {
    case "sessions.get": {
      const session = fieldsOf(resultFields?.["session"] ?? null);
      return session?.["sessionId"] === paramFields?.["sessionId"] ? undefined : fail;
    }
    case "runs.start": {
      const run = fieldsOf(resultFields?.["run"] ?? null);
      if (run === undefined || paramFields === undefined) return fail;
      const sameSession = run["sessionId"] === paramFields["sessionId"];
      const sameSubmission = run["submissionId"] === paramFields["submissionId"];
      const sameText = run["text"] === paramFields["text"];
      return sameSession && sameSubmission && sameText ? undefined : fail;
    }
    case "runs.get": {
      const run = fieldsOf(resultFields?.["run"] ?? null);
      if (run === undefined || paramFields === undefined) return fail;
      if (paramFields["runId"] !== undefined) return run["runId"] === paramFields["runId"] ? undefined : fail;
      return run["submissionId"] === paramFields["submissionId"] ? undefined : fail;
    }
    case "runs.cancel": {
      const run = fieldsOf(resultFields?.["run"] ?? null);
      return run?.["runId"] === paramFields?.["runId"] ? undefined : fail;
    }
    case "plugins.enable":
    case "plugins.disable": {
      const plugin = fieldsOf(resultFields?.["plugin"] ?? null);
      return plugin?.["id"] === paramFields?.["pluginId"] ? undefined : fail;
    }
    default:
      return undefined;
  }
}

/** The own data fields of a JSON object; `undefined` for anything else. */
function fieldsOf(value: unknown): Record<string, JsonValue> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) fields[key] = field;
  return fields;
}

function asClientError(error: unknown): ClientError {
  return error instanceof ClientError ? error : connectionLost("disconnected");
}

export class ClientConnection {
  private readonly options: ClientOptions;
  private readonly reverseTable: ReverseTable;
  private readonly store: PresentationStore = createStore();

  private epoch = 0;
  private attempt: Attempt | undefined;
  private channel: ProtocolChannel | undefined;
  private detach: (() => void) | undefined;
  private identity: Identity | undefined;
  private stream: StreamState | undefined;
  /** The control transaction in flight, if any: `open` is single-flight. */
  private openToken: OpenToken | undefined;
  private sync: Promise<void> | undefined;
  /** Whether a snapshot has ever been installed on this connection. */
  private everOpened = false;
  private readonly pendings = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private readonly reversePendings = new Map<string, ReversePending>();
  private readonly reverseRequestIds = new Set<string>();
  /** Every stream this connection has ended: the proof that its frames are not current. */
  private readonly retiredStreams = new Set<string>();

  constructor(options: ClientOptions, reverseTable: ReverseTable) {
    this.options = options;
    this.reverseTable = reverseTable;
  }

  // -------------------------------------------------------------------------
  // The public reads.
  // -------------------------------------------------------------------------

  getSnapshot(): ClientSnapshot {
    return this.store.get();
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  // -------------------------------------------------------------------------
  // Lifecycle.
  // -------------------------------------------------------------------------

  /** Resolves once this client is `ready`; merges with a connection already in flight. */
  connect(): Promise<void> {
    const running = this.attempt;
    if (running !== undefined) return running.promise;
    if (this.store.get().status === "ready") return Promise.resolve();
    return this.beginAttempt();
  }

  /** A fresh connection, whether or not one is live. Also merges with one in flight. */
  reconnect(): Promise<void> {
    const running = this.attempt;
    if (running !== undefined) return running.promise;
    return this.beginAttempt();
  }

  /**
   * Ends the connection: local state first, then the transport, then nothing.
   *
   * The presentation is kept and marked stale, no run is cancelled, and every
   * wait that was outstanding ends as `unknown` — the host owns the work, and
   * this client has no way to know what it did. Nothing is published until the
   * connection can no longer be used: a listener that hears "disconnected" must
   * not be able to send on it.
   */
  disconnect(): void {
    if (this.channel === undefined && this.attempt === undefined) {
      // Already disconnected: only the state needs saying, and only if it does.
      this.store.update({ status: "disconnected", stale: this.store.get().presentation !== null, error: null });
      return;
    }
    const owner = this.epoch;
    this.retireAttempt(owner, connectionLost("disconnected"));
    this.store.update({ status: "disconnected", stale: this.store.get().presentation !== null, error: null });
  }

  /**
   * Re-opens the subscription on the current connection.
   *
   * A gap in the stream and a caller asking for a refresh are the same operation,
   * and only one of them may be in flight: the subscription is re-cut, the
   * snapshot replaces the presentation whole, and the stream restarts at one.
   */
  async resync(): Promise<void> {
    if (this.channel === undefined || this.identity === undefined) throw connectionLost("disconnected");
    const stream = this.stream;
    if (stream !== undefined) this.revokeStream(stream.streamId);
    await this.openStream();
  }

  /**
   * Closes the current subscription, locally first.
   *
   * The moment the caller asks, the stream is no longer applicable: its frames
   * are dropped, its reverse handlers are aborted, and the presentation is
   * marked stale. The host's answer — `closed` true or false, early or late —
   * cannot bring the old stream back, and cannot touch a new one either.
   */
  async closeSubscription(): Promise<void> {
    const stream = this.stream;
    if (stream === undefined) {
      if (this.openToken !== undefined) throw clientMisuse("sync-in-flight");
      return;
    }
    if (this.openToken !== undefined) throw clientMisuse("sync-in-flight");

    const streamId = stream.streamId;
    this.revokeStream(streamId);
    this.store.update({ status: "connected", stale: this.store.get().presentation !== null });

    await new Promise<void>((resolve, reject) => {
      this.send<"subscriptions.close">("subscriptions.close", { streamId }, {
        accept: () => {
          resolve();
        },
        decline: (error) => {
          reject(error);
        },
      });
    });
  }

  private beginAttempt(): Promise<void> {
    if (this.channel !== undefined || this.attempt !== undefined) {
      // The old connection ends here: whatever it was waiting for will never be
      // answered, and the outcome is unknowable from this side.
      this.retireAttempt(this.epoch, connectionLost("disconnected"));
    }

    const epoch = (this.epoch += 1);
    let settle!: { resolve(): void; reject(error: unknown): void };
    const promise = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const attempt: Attempt = { epoch, aborted: false, promise, settle };
    this.attempt = attempt;

    this.store.update({
      status: "connecting",
      error: null,
      stale: this.store.get().presentation !== null,
      presentationHost: this.store.get().presentation === null ? "none" : "unconfirmed",
    });

    const retire = (): void => {
      if (this.attempt === attempt) this.attempt = undefined;
    };
    void this.runAttempt(attempt).then(
      (value) => {
        retire();
        settle.resolve();
        return value;
      },
      (error: unknown) => {
        retire();
        settle.reject(error);
      },
    );
    return promise;
  }

  /** Whether an attempt still owns this client: the only thing that may act on it. */
  private isActive(attempt: Attempt): boolean {
    return !attempt.aborted && this.attempt === attempt && this.epoch === attempt.epoch;
  }

  private async runAttempt(attempt: Attempt): Promise<void> {
    let channel: ProtocolChannel;
    try {
      channel = await this.options.connect();
    } catch (error) {
      if (this.isActive(attempt)) {
        this.failAttempt(attempt.epoch, connectionLost("connector-failed"), "lost");
      }
      throw error instanceof ClientError ? error : connectionLost("connector-failed");
    }

    if (!this.isActive(attempt)) {
      // A newer attempt owns the client now; this channel is nobody's.
      try {
        channel.close();
      } catch {
        // Best effort: an attempt that lost its place has nothing left to do.
      }
      throw connectionLost("disconnected");
    }

    this.channel = channel;
    const epoch = attempt.epoch;
    this.detach = channel.listen({
      onFrame: (frame: string): void => {
        if (this.epoch === epoch) this.acceptFrame(frame);
      },
      onClose: (): void => {
        if (this.epoch === epoch) this.endWithLoss("channel-closed");
      },
    });
    this.store.update({ status: "connected" });

    try {
      await this.bootstrap(attempt);
    } catch (error) {
      const failure = asClientError(error);
      if (!this.isActive(attempt)) throw failure;
      const status = this.store.get().status;
      if (status !== "protocol-error" && status !== "lost") {
        // The channel is still usable; the client simply is not synchronized on
        // it. A caller that wants another try reconnects.
        this.store.update({
          status: this.channel === undefined ? "lost" : "connected",
          stale: this.store.get().presentation !== null,
          error: failure,
        });
      }
      throw failure;
    }
  }

  /**
   * `describe`, then `open`, then `ready`.
   *
   * Every step re-checks that this attempt still owns the client: a disconnect,
   * a failure or a reconnect during `await` must not be resumed into a send.
   */
  private async bootstrap(attempt: Attempt): Promise<void> {
    // `describe` is already part of synchronizing: the channel is up, but
    // nothing about this client's replica is valid yet.
    this.store.update({ status: "syncing", error: null });
    await this.sendDescribe();
    if (!this.isActive(attempt)) throw connectionLost("disconnected");
    await this.openStream();
    if (!this.isActive(attempt)) throw connectionLost("disconnected");
  }

  private sendDescribe(): Promise<HostDescription> {
    const client = this.options.client ?? DEFAULT_CLIENT;
    const capabilities: ClientCapabilities = Object.freeze({ reverseRequests: true });

    return new Promise<HostDescription>((resolve, reject) => {
      this.send<"host.describe">(
        "host.describe",
        {
          supportedProtocolVersions: [PROTOCOL_VERSION],
          client: { name: client.name, version: client.version },
          capabilities,
        },
        {
          accept: (description, envelope) => {
            // The schema cannot say that the identity in the body is the identity
            // of *this* connection, nor that the host echoed what was declared.
            if (description.hostInstanceId !== envelope.hostInstanceId) {
              const error = protocolViolation("invalid-description", "unknown");
              reject(error);
              this.protocolFailure("invalid-description");
              return;
            }
            if (description.clientCapabilities.reverseRequests !== capabilities.reverseRequests) {
              const error = protocolViolation("invalid-description", "unknown");
              reject(error);
              this.protocolFailure("invalid-description");
              return;
            }
            if (!description.capabilities.subscriptions) {
              // An honest answer to an honest description: this client cannot
              // become ready without a subscription, and says so instead.
              reject(clientMisuse("capability-unavailable"));
              return;
            }

            const presentation = this.store.get().presentation;
            // Frozen before it is used at all: the object the client judges
            // capabilities by is the same object a caller may read, and neither
            // may change under the other.
            const frozen = deepFreeze(description);
            this.identity = { hostInstanceId: frozen.hostInstanceId, description: frozen };
            this.store.update({
              description: frozen,
              presentationHost:
                presentation === null
                  ? "none"
                  : presentation.hostInstanceId === frozen.hostInstanceId
                    ? "current"
                    : "previous",
            });
            resolve(frozen);
          },
          decline: (error) => {
            reject(error);
          },
        },
      );
    });
  }

  /**
   * One open at a time: a gap, a caller's resync and a retry share the same
   * transaction.
   *
   * The token is taken *before* anything observable — before the status is
   * published and before the request is sent — so a listener that reacts to
   * `syncing`, or to the `ready` that ends this open, starts a new cut rather
   * than joining one that has already finished.
   */
  private openStream(): Promise<void> {
    const running = this.sync;
    if (running !== undefined) return running;

    const token: OpenToken = { attempt: this.epoch, token: Symbol("open") };
    this.openToken = token;

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.sync = promise;

    const finish = (error?: ClientError): void => {
      if (this.openToken === token) this.openToken = undefined;
      if (this.sync === promise) this.sync = undefined;
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
      // A resync that failed leaves the client online but unsynchronized, and it
      // says so rather than staying "syncing" forever. During bootstrap the
      // attempt owns this outcome, and a protocol fault has already published
      // its own verdict.
      if (this.attempt === undefined && this.store.get().status === "syncing") {
        this.store.update({
          status: this.channel === undefined ? "lost" : "connected",
          stale: this.store.get().presentation !== null,
          error,
        });
      }
    };

    this.store.update({ status: "syncing", error: null });

    this.send<"subscriptions.open">(
      "subscriptions.open",
      {},
      {
        accept: (result, envelope) => {
          const snapshot = result.snapshot;
          const identity = this.identity;
          if (
            identity === undefined ||
            snapshot.hostInstanceId !== identity.hostInstanceId ||
            snapshot.hostInstanceId !== envelope.hostInstanceId
          ) {
            finish(protocolViolation("invalid-response", "unknown"));
            this.protocolFailure("invalid-response");
            return;
          }
          if (this.retiredStreams.has(snapshot.watermark.streamId)) {
            // Streams are never reused; one that comes back is a stream whose
            // frames this client has already applied and discarded.
            finish(protocolViolation("snapshot-fence", "unknown"));
            this.protocolFailure("snapshot-fence");
            return;
          }

          // Installed here, in the frame path: the frames that follow this
          // response are already on the new stream, and this snapshot is what
          // makes them applicable. The transaction is finished *before* the
          // store publishes `ready`, so a listener that refreshes immediately
          // starts a new cut instead of finding this one still open.
          this.stream = {
            streamId: snapshot.watermark.streamId,
            expected: snapshot.watermark.sequence + 1,
          };
          this.everOpened = true;
          finish();
          this.store.update({
            presentation: deepFreeze(snapshot),
            presentationHost: "current",
            stale: false,
            status: "ready",
            error: null,
          });
        },
        decline: (error) => {
          finish(error);
        },
      },
    );

    return promise;
  }

  // -------------------------------------------------------------------------
  // Operations.
  // -------------------------------------------------------------------------

  /** One typed request; `accept` runs in the frame path, `decline` wherever the wait ended. */
  private send<M extends OperationName>(
    method: M,
    params: OperationMap[M]["params"],
    handlers: SendHandlers<M>,
  ): void {
    const channel = this.channel;
    if (channel === undefined) {
      handlers.decline(connectionLost("disconnected"));
      return;
    }

    const identity = this.identity;
    const hostInstanceId = identity === undefined ? undefined : identity.hostInstanceId;
    if (method !== "host.describe") {
      if (hostInstanceId === undefined) {
        handlers.decline(clientMisuse("not-initialized"));
        return;
      }
      const capability = CAPABILITY_OF[method];
      if (capability !== undefined && identity?.description.capabilities[capability] !== true) {
        handlers.decline(clientMisuse("capability-unavailable"));
        return;
      }
    }

    // Control traffic pays for its own capacity: a connection whose business
    // slots are full must still be able to re-cut its subscription.
    const control = CONTROL_METHODS.has(method);
    const inFlight = [...this.pendings.values()];
    const used = control
      ? inFlight.filter((pending) => pending.control).length
      : inFlight.filter((pending) => !pending.control).length;
    if (used >= (control ? MAX_CONTROL_PENDING : MAX_ORDINARY_PENDING)) {
      handlers.decline(clientMisuse("capacity"));
      return;
    }

    this.requestCounter += 1;
    const requestId = `client-request-${this.requestCounter}`;
    const candidate: Record<string, unknown> = {
      kind: "client-request",
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      method,
      params,
    };
    if (method !== "host.describe" && hostInstanceId !== undefined) {
      candidate["hostInstanceId"] = hostInstanceId;
    }

    // Built through the real validator and encoder: a request the contract
    // cannot express is refused here, before anything reaches the transport.
    const validated = validateMessage({ kind: "client-request" }, candidate);
    if (!validated.success) {
      handlers.decline(clientMisuse("invalid-params"));
      return;
    }
    const encoded = encodeFrame({ kind: "client-request" }, validated.output);
    if (!encoded.success) {
      handlers.decline(clientMisuse("invalid-params"));
      return;
    }

    // The identity a response will be checked against is the snapshot that was
    // sent — never the caller's object, which they may edit the moment this
    // returns (and which the wire never saw).
    const sentParams = validated.output.params;
    const complete = (envelope: ResponseEnvelope): void => {
      const response = validateMessage({ kind: "host-response", method }, envelope);
      if (!response.success) {
        handlers.decline(protocolViolation("invalid-response", "unknown"));
        this.protocolFailure("invalid-response");
        return;
      }
      if (response.output.error !== undefined) {
        handlers.decline(remoteError(response.output.error));
        return;
      }
      const mismatch = verifyResultIdentity(method, sentParams, response.output.result);
      if (mismatch !== undefined) {
        handlers.decline(protocolViolation(mismatch, "unknown"));
        this.protocolFailure(mismatch);
        return;
      }
      handlers.accept(response.output.result, envelope);
    };
    const fail = (error: ClientError): void => {
      handlers.decline(error);
    };

    const pending: PendingRequest = { method, control, complete, fail, timer: undefined };
    this.pendings.set(requestId, pending);

    if (control) {
      // A control request is what makes this connection usable; one that is
      // never answered ends the attempt rather than hanging forever. Business
      // requests keep no default execution timeout: a plugin lifecycle may
      // legitimately take a long time.
      pending.timer = scheduleDeadline(Date.now() + CONTROL_DEADLINE_MS, () => {
        if (this.pendings.get(requestId) !== pending) return;
        this.endWithLoss("control-timeout");
      });
    }

    try {
      channel.send(encoded.output);
    } catch {
      // The transport refused the frame. Whether the host sees it is no longer
      // knowable from here, so the connection ends and the outcome is `unknown`.
      const rejected = this.takePending(requestId);
      rejected?.fail(connectionLost("send-failed"));
      this.endWithLoss("send-failed");
    }
  }

  request<M extends OperationName>(
    method: M,
    params: OperationMap[M]["params"],
  ): Promise<OperationMap[M]["result"]> {
    return new Promise<OperationMap[M]["result"]>((resolve, reject) => {
      this.send(method, params, {
        accept: (result) => {
          resolve(result);
        },
        decline: (error) => {
          reject(error);
        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // The frame path.
  // -------------------------------------------------------------------------

  private acceptFrame(frame: string): void {
    const decoded = decodeFrame(frame);
    if (!decoded.success) {
      // Nothing that cannot be read as a protocol message has any place on a
      // logical connection.
      this.protocolFailure("invalid-frame");
      return;
    }

    const envelope = decoded.output;
    switch (envelope.kind) {
      case "host-response":
        this.acceptResponse(envelope);
        return;
      case "host-event":
        this.acceptEvent(envelope);
        return;
      case "host-request":
        this.acceptHostRequest(envelope);
        return;
      case "client-request":
      case "client-response":
        this.protocolFailure("wrong-direction");
        return;
    }
  }

  /**
   * Every response is checked against this connection's context first.
   *
   * The generation and — once bootstrap has bound it — the host instance are
   * facts about the connection, not about the request, so they are checked
   * before the request id is even looked at. Only then does the id decide
   * whether this is an answer, a duplicate, or something never asked for.
   */
  private acceptResponse(envelope: ResponseEnvelope): void {
    if (envelope.protocolVersion !== PROTOCOL_VERSION) {
      this.takePending(envelope.requestId)?.fail(protocolViolation("unsupported-protocol", "unknown"));
      this.protocolFailure("unsupported-protocol");
      return;
    }

    const identity = this.identity;
    if (identity === undefined) {
      // Bootstrap: the identity is what `host.describe` is about to bind, so it
      // cannot be checked yet — but nothing else on this connection has been
      // asked at all.
      if (!this.pendings.has(envelope.requestId)) {
        this.protocolFailure("invalid-response");
        return;
      }
    } else if (envelope.hostInstanceId !== identity.hostInstanceId) {
      this.takePending(envelope.requestId)?.fail(protocolViolation("host-instance-mismatch", "unknown"));
      this.protocolFailure("host-instance-mismatch");
      return;
    }

    const pending = this.takePending(envelope.requestId);
    if (pending === undefined) return; // A duplicate or an unknown id: read, checked, dropped.
    pending.complete(envelope);
  }

  /**
   * How a frame on a stream that is not the current one is classified.
   *
   * The contract is specific about this, and the cases are not interchangeable:
   * a stream this client has already ended is dropped wherever it appears, a
   * never-installed stream is ordinary noise once the client is ready or after
   * it deliberately closed its subscription, and a stream that was never
   * explained at all — during bootstrap, or while a new cut is in flight — is
   * the fence the contract forbids.
   */
  private classifyNonCurrentStream(streamId: string): "discard" | "fault" {
    if (this.retiredStreams.has(streamId)) return "discard";
    if (this.stream !== undefined) return "discard";
    if (this.openToken !== undefined) return "fault";
    return this.everOpened ? "discard" : "fault";
  }

  private acceptEvent(envelope: EventEnvelope): void {
    const identity = this.identity;
    if (identity === undefined) {
      // The snapshot is what explains a stream, and no stream has been explained
      // on this connection yet.
      this.protocolFailure("snapshot-fence");
      return;
    }
    if (envelope.protocolVersion !== PROTOCOL_VERSION) {
      this.protocolFailure("unsupported-protocol");
      return;
    }
    if (envelope.hostInstanceId !== identity.hostInstanceId) {
      this.protocolFailure("host-instance-mismatch");
      return;
    }

    const stream = this.stream;
    if (stream === undefined || envelope.streamId !== stream.streamId) {
      if (this.classifyNonCurrentStream(envelope.streamId) === "fault") {
        this.protocolFailure("snapshot-fence");
      }
      return;
    }
    if (envelope.sequence < stream.expected) return; // Duplicate or stale within this stream: dropped.
    if (envelope.sequence > stream.expected) {
      // A gap cannot be repaired from here, and guessing the missing events is
      // exactly what the contract forbids: the stream is revoked and re-cut —
      // and the event that revealed the gap is never applied.
      this.revokeStream(stream.streamId);
      void this.openStream().catch(() => undefined);
      return;
    }

    const validated = validateMessage({ kind: "host-event" }, envelope);
    if (!validated.success) {
      this.protocolFailure(validated.failure.reason === "UNKNOWN_EVENT" ? "unknown-event" : "invalid-event");
      return;
    }
    const event = validated.output;

    if (event.type === "host.request.cancelled") {
      // The host stopped waiting: the local handler must stop too, and no
      // answer may travel for this request any more.
      const cancelled = this.reversePendings.get(event.payload.requestId);
      if (cancelled !== undefined) this.abandonReverse(cancelled);
    }

    const presentation = this.store.get().presentation;
    if (presentation === null) {
      this.protocolFailure("snapshot-fence");
      return;
    }
    const watermark: Watermark = Object.freeze({
      streamId: stream.streamId,
      sequence: event.sequence,
    });
    const folded = foldEvent(presentation, event, watermark);
    if (!folded.ok) {
      this.protocolFailure(folded.reason);
      return;
    }

    // The frame is applied whole or not at all: the position moves only once the
    // fold has accepted it, so a rejected event leaves no trace.
    stream.expected = event.sequence + 1;
    this.store.update({ presentation: folded.presentation });
  }

  // -------------------------------------------------------------------------
  // The reverse dispatcher.
  // -------------------------------------------------------------------------

  private acceptHostRequest(envelope: RequestEnvelope): void {
    const identity = this.identity;
    if (identity === undefined) {
      this.protocolFailure("snapshot-fence");
      return;
    }
    if (envelope.protocolVersion !== PROTOCOL_VERSION) {
      this.protocolFailure("unsupported-protocol");
      return;
    }
    if (envelope.hostInstanceId !== identity.hostInstanceId) {
      this.protocolFailure("host-instance-mismatch");
      return;
    }

    const stream = this.stream;
    if (stream === undefined || envelope.streamId !== stream.streamId) {
      // A request on a stream this client ended is dropped unanswered; one on a
      // stream that was never explained is the same fence an event would be.
      if (this.classifyNonCurrentStream(envelope.streamId) === "fault") {
        this.protocolFailure("snapshot-fence");
      }
      return;
    }
    if (identity.description.capabilities.reverseRequests !== true) {
      // The host may only ask when both sides declared the capability.
      this.protocolFailure("capability-violation");
      return;
    }

    const validated = validateMessage({ kind: "host-request" }, envelope);
    if (!validated.success) {
      // Readable enough to know it is a reverse request, but not enough to know
      // which stream it meant: there is no honest answer to send.
      this.protocolFailure("invalid-frame");
      return;
    }
    const request = validated.output;

    if (this.reverseRequestIds.has(request.requestId)) {
      this.protocolFailure("duplicate-request-id");
      return;
    }
    if (this.reverseRequestIds.size >= MAX_REVERSE_HISTORY) {
      // Uniqueness can no longer be proved on this connection, and pretending
      // otherwise would be worse than ending it.
      this.protocolFailure("duplicate-request-id");
      return;
    }
    this.reverseRequestIds.add(request.requestId);

    const handler = this.reverseTable.get(request.method);
    if (handler === undefined) {
      // Unknown is refused immediately and explicitly — never ignored, and never
      // treated as an approval of anything.
      this.replyReverse(request.streamId, request.requestId, {
        error: Object.freeze({ code: "METHOD_NOT_FOUND", message: "this client has no handler for that method" }),
      });
      return;
    }
    if (!handler.accepts(request.params)) {
      this.replyReverse(request.streamId, request.requestId, {
        error: Object.freeze({ code: "INVALID_REQUEST", message: "the payload did not match the method's contract" }),
      });
      return;
    }
    if (this.reversePendings.size >= MAX_REVERSE_PENDING) {
      this.replyReverse(request.streamId, request.requestId, {
        error: Object.freeze({ code: "INTERNAL_ERROR", message: "this client is at capacity for reverse requests" }),
      });
      return;
    }

    const controller = new AbortController();
    const pending: ReversePending = {
      requestId: request.requestId,
      streamId: request.streamId,
      epoch: this.epoch,
      resultIsValid: handler.resultIsValid,
      controller,
      timer: undefined,
      finished: false,
    };
    this.reversePendings.set(request.requestId, pending);
    // The deadline belongs to this entry, not to its id: a later connection may
    // legitimately receive the same id, and this timer must never end that one.
    pending.timer = scheduleDeadline(Date.now() + request.timeoutMs, () => {
      this.abandonReverse(pending);
    });

    const context: ReverseHandlerContext = {
      method: request.method,
      timeoutMs: request.timeoutMs,
      hostInstanceId: identity.hostInstanceId,
      signal: controller.signal,
    };
    const params = deepFreeze(request.params);

    // Detached on purpose: the frame path never waits for foreign code, so one
    // slow handler cannot hold up the frames behind it.
    void Promise.resolve()
      .then(() => handler.handle(params, context))
      .then(
        (outcome) => {
          this.finishReverse(pending, outcome);
        },
        () => {
          this.finishReverse(pending, {
            error: Object.freeze({ code: "INTERNAL_ERROR", message: "the handler failed" }),
          });
        },
      );
  }

  /**
   * Finishes one handler, if it still owns its request.
   *
   * The lookup is by identity, not by id: the same request id can legitimately
   * arrive again on a later connection, and a handler from the previous one —
   * which may have ignored its abort — must not answer it.
   */
  private finishReverse(pending: ReversePending, outcome: ReverseHandlerOutcome): void {
    if (this.reversePendings.get(pending.requestId) !== pending) return;
    if (this.epoch !== pending.epoch) return;

    this.reversePendings.delete(pending.requestId);
    pending.finished = true;
    pending.timer?.cancel();
    pending.timer = undefined;
    this.replyReverse(pending.streamId, pending.requestId, expressible(outcome, pending.resultIsValid));
  }

  /**
   * Ends one reverse request without an answer.
   *
   * The entry is matched by identity for the same reason its completion is: an
   * expired deadline belongs to the request that armed it.
   */
  private abandonReverse(pending: ReversePending): void {
    if (this.reversePendings.get(pending.requestId) !== pending) return;

    this.reversePendings.delete(pending.requestId);
    pending.finished = true;
    pending.timer?.cancel();
    pending.timer = undefined;
    pending.controller.abort();
  }

  private abortReverseForStream(streamId: string): void {
    for (const pending of [...this.reversePendings.values()]) {
      if (pending.streamId === streamId) this.abandonReverse(pending);
    }
  }

  private replyReverse(streamId: string, requestId: string, outcome: ReverseHandlerOutcome): void {
    const channel = this.channel;
    const identity = this.identity;
    if (channel === undefined || identity === undefined) return;

    const candidate =
      "error" in outcome
        ? {
            kind: "client-response",
            protocolVersion: PROTOCOL_VERSION,
            hostInstanceId: identity.hostInstanceId,
            streamId,
            requestId,
            error: outcome.error,
          }
        : {
            kind: "client-response",
            protocolVersion: PROTOCOL_VERSION,
            hostInstanceId: identity.hostInstanceId,
            streamId,
            requestId,
            result: outcome.result,
          };

    const validated = validateMessage({ kind: "client-response" }, candidate);
    if (!validated.success) return;
    const encoded = encodeFrame({ kind: "client-response" }, validated.output);
    if (!encoded.success) return;

    try {
      channel.send(encoded.output);
    } catch {
      this.endWithLoss("send-failed");
    }
  }

  // -------------------------------------------------------------------------
  // Ending things.
  // -------------------------------------------------------------------------

  /** Removes one pending from the ledger and stops its wait; the caller decides what to say. */
  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pendings.get(requestId);
    if (pending === undefined) return undefined;
    this.pendings.delete(requestId);
    pending.timer?.cancel();
    pending.timer = undefined;
    return pending;
  }

  /** The channel is gone, and nothing that was in flight will ever be answered. */
  private endWithLoss(reason: ConnectionLostReason): void {
    if (this.channel === undefined && this.attempt === undefined) return;
    this.failAttempt(this.epoch, connectionLost(reason), "lost");
  }

  /** The peer broke the contract. The connection cannot be used for anything else. */
  private protocolFailure(reason: ProtocolViolationReason): void {
    this.failAttempt(this.epoch, protocolViolation(reason, "unknown"), "protocol-error");
  }

  /**
   * Ends the attempt an error belongs to, then publishes the outcome.
   *
   * The order is the point: by the time anything can observe the new status, the
   * epoch is invalid, the channel and identity are gone, the control token is
   * retired and every pending is settled — so a listener that reacts to the
   * status cannot send on the connection that just ended, and a cleanup that
   * arrives late cannot touch a newer one.
   */
  private failAttempt(owner: number, error: ClientError, status: ConnectionStatus): void {
    if (this.epoch !== owner) return;
    this.retireAttempt(owner, error);
    this.store.update({ status, stale: this.store.get().presentation !== null, error });
  }

  /** Invalidates one attempt and everything bound to it. Publishes nothing. */
  private retireAttempt(owner: number, error: ClientError): void {
    if (this.epoch !== owner) return;
    this.epoch += 1;

    const attempt = this.attempt;
    this.attempt = undefined;
    if (attempt !== undefined) attempt.aborted = true;

    const detach = this.detach;
    this.detach = undefined;
    const channel = this.channel;
    this.channel = undefined;
    this.identity = undefined;
    const stream = this.stream;
    this.stream = undefined;
    if (stream !== undefined) this.rememberRetired(stream.streamId);
    this.openToken = undefined;
    this.everOpened = false;

    const pendings = [...this.pendings.values()];
    this.pendings.clear();
    const reverse = [...this.reversePendings.values()];
    this.reversePendings.clear();
    this.reverseRequestIds.clear();
    this.sync = undefined;

    // Everything local is finished before any foreign code runs: the attempt's
    // waiters, then the listeners, then the transport.
    if (attempt !== undefined) attempt.settle.reject(error);
    for (const pending of pendings) {
      pending.timer?.cancel();
      pending.timer = undefined;
      pending.fail(error);
    }
    for (const pending of reverse) {
      if (pending.finished) continue;
      pending.finished = true;
      pending.timer?.cancel();
      pending.timer = undefined;
      pending.controller.abort();
    }
    if (detach !== undefined) {
      try {
        detach();
      } catch {
        // The listener is gone from this client's point of view either way.
      }
    }
    if (channel !== undefined) {
      try {
        channel.close();
      } catch {
        // Best effort: closing a connection that is already failing has no
        // reader left to report it to.
      }
    }
  }

  /**
   * Drops the current stream, in one local transition.
   *
   * Losing the stream and marking the presentation stale are the same fact, and
   * they are published together: a reader never sees "no stream, but still
   * current" — which would be exactly the lie this client exists to avoid.
   */
  private revokeStream(streamId: string): void {
    const stream = this.stream;
    if (stream === undefined || stream.streamId !== streamId) return;

    this.stream = undefined;
    this.rememberRetired(streamId);
    this.abortReverseForStream(streamId);
    this.store.update({ stale: this.store.get().presentation !== null });
  }

  /**
   * Remembers one ended stream, or ends the connection when the budget is spent.
   *
   * The alternative — forgetting ids — would make an already-ended stream look
   * like a new one, and its frames would be applied to a presentation that has
   * moved on.
   */
  private rememberRetired(streamId: string): void {
    if (this.retiredStreams.has(streamId)) return;
    if (this.retiredStreams.size >= RETIRED_STREAM_BUDGET) {
      this.protocolFailure("stream-identity-budget");
      return;
    }
    this.retiredStreams.add(streamId);
  }
}

/**
 * A handler's answer, reduced to something this profile promised.
 *
 * Two rejections, one answer: a value the wire cannot carry at all, and a value
 * that is perfectly good JSON but not what this method's contract says. Neither
 * is a success, and neither is allowed to travel as one.
 */
function expressible(
  outcome: ReverseHandlerOutcome,
  resultIsValid: (result: JsonValue) => boolean,
): ReverseHandlerOutcome {
  if ("error" in outcome) return outcome;
  const validated = validateJsonValue(outcome.result);
  if (!validated.success) {
    return {
      error: Object.freeze({ code: "INTERNAL_ERROR", message: "the handler produced a value the wire cannot carry" }),
    };
  }
  if (!resultIsValid(validated.output)) {
    return {
      error: Object.freeze({ code: "INTERNAL_ERROR", message: "the handler produced a result this method does not define" }),
    };
  }
  return { result: validated.output };
}
