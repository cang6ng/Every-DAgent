/**
 * The protocol dispatcher: every frame a client sends, and the twelve
 * operations behind them.
 *
 * The shape is deliberately a closed switch over the frozen operation names —
 * not a method registry, not a generic RPC front end. Each case builds the
 * response the protocol's own encoder expects for that method, so a result
 * cannot be sent under the wrong method's schema by accident.
 *
 * Two rules run through the whole module. Reads never touch the registry gate:
 * listing, fetching, cancelling and subscription traffic answer while a run or
 * a plugin lifecycle owns the registry, because the contract says an occupied
 * host still lets a client look and still lets it cancel. And a frame is
 * handled from a microtask, never from inside the channel's own callback, so a
 * transport that delivers synchronously cannot re-enter a host transaction
 * through `send`.
 */

import { createSession } from "@every-dagent/agent-core";
import type {
  ClientCapabilities,
  ClientRequestFor,
  DecodedEnvelope,
  HostCapabilities,
  OperationMap,
  ProtocolError,
  ProtocolErrorCode,
  SessionSnapshot,
  ValidationFailureReason,
} from "@every-dagent/protocol";
import { PROTOCOL_VERSION, decodeFrame, encodeFrame, validateMessage } from "@every-dagent/protocol";

import {
  assertEventBuilds,
  closeConnection,
  observePlugin,
  publishEvent,
  sendFrame,
  sessionCreatedEvent,
} from "./connection.js";
import { codeForPluginFailure, protocolError, shuttingDownError } from "./errors.js";
import { cancelRun, startRun } from "./run.js";
import {
  captureHostSnapshot,
  newId,
  operationFailed,
  operationSucceeded,
  pluginSummaryOf,
  runSnapshotOf,
  sessionEntryOf,
  sessionSummaryOf,
  trackTask,
  type ConnectionState,
  type HostState,
  type OperationOutcome,
  type RunEntry,
} from "./state.js";

type EncodedFrame = ReturnType<typeof encodeFrame>;
type ClientRequestEnvelope = Extract<DecodedEnvelope, { kind: "client-request" }>;
type SessionResult = OperationMap["sessions.create"]["result"];
type RunResult = OperationMap["runs.start"]["result"];
type PluginResult = OperationMap["plugins.enable"]["result"];

const HOST_CAPABILITIES: HostCapabilities = Object.freeze({
  sessions: true,
  runs: true,
  plugins: true,
  subscriptions: true,
  // The reverse seam exists in the protocol, but this host has no production
  // reverse request to make. Declaring it would be a claim nothing backs.
  reverseRequests: false,
});

/**
 * What a failed frame means on the wire.
 *
 * Decoding has already decided whether the frame could be correlated; this
 * table only answers the messages that were readable enough to answer.
 */
const VALIDATION_ERROR_CODES: Readonly<Record<ValidationFailureReason, ProtocolErrorCode>> = Object.freeze({
  INVALID_JSON: "INVALID_REQUEST",
  NON_JSON_VALUE: "INVALID_REQUEST",
  INVALID_ENVELOPE: "INVALID_REQUEST",
  UNSUPPORTED_PROTOCOL: "UNSUPPORTED_PROTOCOL",
  UNKNOWN_METHOD: "METHOD_NOT_FOUND",
  UNKNOWN_EVENT: "INVALID_REQUEST",
  INVALID_MESSAGE: "INVALID_REQUEST",
  INVALID_TARGET: "INTERNAL_ERROR",
});

/** One frame: bytes in, an operation, a response out. */
export function handleFrame(state: HostState, connection: ConnectionState, frame: string): void {
  if (connection.closed) return;

  const decoded = decodeFrame(frame);
  if (!decoded.success) {
    const correlation = decoded.failure.correlation;
    if (correlation === undefined || correlation.kind !== "client-request") {
      // Nothing was understood well enough to answer, or the frame claims a
      // direction this side never receives. The connection is the problem.
      closeConnection(state, connection);
      return;
    }

    // An id that can be read safely belongs to this connection from this
    // moment, exactly as a well-formed request's would. Answering an invalid
    // request without consuming its id would let a later frame spend a name
    // this connection has already used.
    if (connection.requestIds.has(correlation.requestId)) {
      closeConnection(state, connection);
      return;
    }
    connection.requestIds.add(correlation.requestId);

    replyError(
      state,
      connection,
      correlation.requestId,
      protocolError(VALIDATION_ERROR_CODES[decoded.failure.reason]),
    );
    return;
  }

  switch (decoded.output.kind) {
    case "client-request":
      dispatchClientRequest(state, connection, decoded.output);
      return;

    case "client-response":
      acceptClientResponse(state, connection, decoded.output);
      return;

    default:
      // host-request, host-response and host-event are this side's own
      // directions. A client sending one is not speaking this protocol.
      closeConnection(state, connection);
  }
}

/**
 * Reads a response to a request this host never made.
 *
 * v1 has no production reverse request, so every response is unassociated: it
 * is validated — a frame that cannot be read at all is a connection fault — and
 * then dropped, without touching the run it may have been meant for.
 */
function acceptClientResponse(state: HostState, connection: ConnectionState, envelope: unknown): void {
  if (!validateMessage({ kind: "client-response" }, envelope).success) {
    closeConnection(state, connection);
  }
}

function dispatchClientRequest(
  state: HostState,
  connection: ConnectionState,
  envelope: ClientRequestEnvelope,
): void {
  const requestId = envelope.requestId;

  // Request ids are reused never, not even by a request that failed to validate:
  // once an id has meant one thing, a second meaning cannot be answered.
  if (connection.requestIds.has(requestId)) {
    closeConnection(state, connection);
    return;
  }
  connection.requestIds.add(requestId);

  const validated = validateMessage({ kind: "client-request" }, envelope);
  if (!validated.success) {
    replyError(state, connection, requestId, protocolError(VALIDATION_ERROR_CODES[validated.failure.reason]));
    return;
  }

  const request = validated.output;
  if (request.method === "host.describe") {
    describe(state, connection, request);
    return;
  }

  if (connection.initialized === undefined) {
    replyError(state, connection, requestId, protocolError("NOT_INITIALIZED"));
    return;
  }
  if (request.hostInstanceId !== state.hostInstanceId) {
    replyError(state, connection, requestId, protocolError("HOST_INSTANCE_MISMATCH"));
    return;
  }

  switch (request.method) {
    case "sessions.list": {
      const result: OperationMap["sessions.list"]["result"] = {
        sessions: state.sessionOrder.map((sessionId) => sessionSummaryOf(sessionEntryOf(state, sessionId).published)),
      };
      sendSuccess(
        state,
        connection,
        requestId,
        encodeFrame(
          { kind: "host-response", method: "sessions.list" },
          hostResponse(state, requestId, result),
        ),
      );
      return;
    }

    case "sessions.create":
      respond(state, connection, requestId, createHostSession(state), (result) =>
        encodeFrame(
          { kind: "host-response", method: "sessions.create" },
          hostResponse(state, requestId, result),
        ),
      );
      return;

    case "sessions.get": {
      const entry = state.sessions.get(request.params.sessionId);
      if (entry === undefined) {
        replyError(state, connection, requestId, protocolError("SESSION_NOT_FOUND"));
        return;
      }
      const result: OperationMap["sessions.get"]["result"] = { session: entry.published };
      sendSuccess(
        state,
        connection,
        requestId,
        encodeFrame({ kind: "host-response", method: "sessions.get" }, hostResponse(state, requestId, result)),
      );
      return;
    }

    case "runs.start":
      respond(state, connection, requestId, startRun(state, request.params), (result) =>
        encodeFrame({ kind: "host-response", method: "runs.start" }, hostResponse(state, requestId, result)),
      );
      return;

    case "runs.get": {
      const run = findRun(state, request.params);
      if (run === undefined) {
        replyError(state, connection, requestId, protocolError("RUN_NOT_FOUND"));
        return;
      }
      const result: RunResult = { run: runSnapshotOf(run) };
      sendSuccess(
        state,
        connection,
        requestId,
        encodeFrame({ kind: "host-response", method: "runs.get" }, hostResponse(state, requestId, result)),
      );
      return;
    }

    case "runs.cancel":
      respond(state, connection, requestId, cancelRun(state, request.params.runId), (result) =>
        encodeFrame({ kind: "host-response", method: "runs.cancel" }, hostResponse(state, requestId, result)),
      );
      return;

    case "plugins.list": {
      const result: OperationMap["plugins.list"]["result"] = {
        plugins: state.pluginOrder.map((pluginId) => pluginSummaryOf(state, pluginId)),
      };
      sendSuccess(
        state,
        connection,
        requestId,
        encodeFrame(
          { kind: "host-response", method: "plugins.list" },
          hostResponse(state, requestId, result),
        ),
      );
      return;
    }

    case "plugins.enable":
      // Plugin operations outlive this frame: the response is sent when the
      // lifecycle has settled, and the dispatch of the next frame is not
      // waiting behind it.
      void operatePlugin(state, request.params.pluginId, "enable").then(
        (outcome) =>
          respond(state, connection, requestId, outcome, (result) =>
            encodeFrame(
              { kind: "host-response", method: "plugins.enable" },
              hostResponse(state, requestId, result),
            ),
          ),
        () => replyError(state, connection, requestId, protocolError("INTERNAL_ERROR")),
      );
      return;

    case "plugins.disable":
      void operatePlugin(state, request.params.pluginId, "disable").then(
        (outcome) =>
          respond(state, connection, requestId, outcome, (result) =>
            encodeFrame(
              { kind: "host-response", method: "plugins.disable" },
              hostResponse(state, requestId, result),
            ),
          ),
        () => replyError(state, connection, requestId, protocolError("INTERNAL_ERROR")),
      );
      return;

    case "subscriptions.open": {
      // The cut and the response are one synchronous step: the snapshot is what
      // the catalogues hold right now, and the response is queued on this
      // connection before anything can put an event on the new stream.
      const streamId = newId();
      const result: OperationMap["subscriptions.open"]["result"] = {
        snapshot: captureHostSnapshot(state, streamId),
      };
      const encoded = encodeFrame(
        { kind: "host-response", method: "subscriptions.open" },
        hostResponse(state, requestId, result),
      );
      if (!encoded.success) {
        replyError(state, connection, requestId, protocolError("INTERNAL_ERROR"));
        return;
      }
      connection.subscription = { streamId, sequence: 0 };
      sendFrame(state, connection, encoded.output);
      return;
    }

    case "subscriptions.close": {
      const current = connection.subscription;
      const closed = current !== undefined && current.streamId === request.params.streamId;
      if (closed) connection.subscription = undefined;
      const result: OperationMap["subscriptions.close"]["result"] = { closed };
      sendSuccess(
        state,
        connection,
        requestId,
        encodeFrame(
          { kind: "host-response", method: "subscriptions.close" },
          hostResponse(state, requestId, result),
        ),
      );
      return;
    }
  }
}

/**
 * Binds a logical connection to what its `describe` declared.
 *
 * A second describe with the same reverse capability is answered with an
 * equivalent description; a different one is refused, because a connection that
 * quietly changed what it is would invalidate every answer already given on it.
 */
function describe(
  state: HostState,
  connection: ConnectionState,
  request: ClientRequestFor<"host.describe">,
): void {
  const requestId = request.requestId;
  const params = request.params;

  if (!params.supportedProtocolVersions.includes(PROTOCOL_VERSION)) {
    replyError(state, connection, requestId, protocolError("UNSUPPORTED_PROTOCOL"));
    return;
  }

  const reverseRequests = params.capabilities.reverseRequests;
  const bound = connection.initialized;
  let clientCapabilities: ClientCapabilities;

  if (bound === undefined) {
    clientCapabilities = Object.freeze({ reverseRequests });
    connection.initialized = {
      name: params.client.name,
      version: params.client.version,
      capabilities: clientCapabilities,
    };
  } else if (bound.capabilities.reverseRequests !== reverseRequests) {
    replyError(state, connection, requestId, protocolError("INVALID_REQUEST"));
    return;
  } else {
    clientCapabilities = bound.capabilities;
  }

  const result: OperationMap["host.describe"]["result"] = {
    protocolVersion: PROTOCOL_VERSION,
    hostInstanceId: state.hostInstanceId,
    host: { name: state.name, version: state.version },
    capabilities: HOST_CAPABILITIES,
    clientCapabilities: { reverseRequests: clientCapabilities.reverseRequests },
    limits: { maxActiveRuns: 1 },
    retention: "host-lifetime",
  };

  sendSuccess(
    state,
    connection,
    requestId,
    encodeFrame({ kind: "host-response", method: "host.describe" }, hostResponse(state, requestId, result)),
  );
}

/**
 * A new, empty session.
 *
 * Allowed while the host is occupied — creating an entry changes no registry
 * and can wait for nothing — but refused once the host is shutting down, like
 * every other write.
 */
function createHostSession(state: HostState): OperationOutcome<SessionResult> {
  if (state.closing) return operationFailed(shuttingDownError());

  const sessionId = newId();
  const createdAt = Date.now();
  const session = createSession(sessionId);
  const snapshot: SessionSnapshot = Object.freeze({
    sessionId,
    createdAt,
    status: "ready" as const,
    activeRunId: null,
    canonical: Object.freeze([]),
  });

  const build = sessionCreatedEvent(snapshot);
  try {
    assertEventBuilds(state, build);
  } catch {
    return operationFailed(protocolError("INTERNAL_ERROR"));
  }

  state.sessions.set(sessionId, { session, createdAt, published: snapshot, publishedSeq: 0 });
  state.sessionOrder.push(sessionId);
  publishEvent(state, build);
  return operationSucceeded({ session: snapshot });
}

/**
 * One plugin lifecycle operation, under the registry's mutation ownership.
 *
 * The task is registered before the manager is called, and the manager is
 * called from a microtask: an activation runs synchronously up to its first
 * await, may hand out a storage view, and may run the plugin's own code — all
 * of which a shutdown that is already waiting has to be able to see.
 *
 * Once it is running, the manager is observed immediately: its status is
 * already `enabling`/`disabling` at that point, so a slow activation is visible
 * as one rather than being invented. Whatever the observation does, the
 * lifecycle's own promise is awaited to its end — a projection failure must not
 * release the registry while a plugin is still activating or cleaning up.
 */
function operatePlugin(
  state: HostState,
  pluginId: string,
  operation: "enable" | "disable",
): Promise<OperationOutcome<PluginResult>> {
  if (state.closing) return Promise.resolve(operationFailed(shuttingDownError()));

  const info = state.manager.get(pluginId);
  if (info === undefined) return Promise.resolve(operationFailed(protocolError("PLUGIN_NOT_FOUND")));
  if (info.status === "error") {
    return Promise.resolve(operationFailed(protocolError("PLUGIN_UNAVAILABLE")));
  }

  const lease = state.gate.tryAcquire("mutation");
  if (lease === undefined) return Promise.resolve(operationFailed(protocolError("HOST_BUSY")));

  const task = Promise.resolve().then(() => completePluginOperation(state, pluginId, operation, lease));
  trackTask(state, task);
  return task;
}

async function completePluginOperation(
  state: HostState,
  pluginId: string,
  operation: "enable" | "disable",
  lease: { release(): void },
): Promise<OperationOutcome<PluginResult>> {
  let projectionFailed = false;
  const observe = (): void => {
    try {
      observePlugin(state, pluginId);
    } catch {
      projectionFailed = true;
    }
  };

  try {
    const settled =
      operation === "enable" ? state.manager.enable(pluginId) : state.manager.disable(pluginId);
    // The handler is attached before anything can await, so a rejection is never
    // an unhandled one — and `failed` is a flag rather than a sentinel, because
    // a plugin is free to throw `undefined`.
    const outcome = settled.then(
      () => ({ failed: false as const }),
      (error: unknown) => ({ failed: true as const, error }),
    );

    observe();
    const result = await outcome;
    observe();

    if (projectionFailed) return operationFailed(protocolError("INTERNAL_ERROR"));
    if (result.failed) return operationFailed(pluginOperationError(state, pluginId, operation));

    const summary = state.plugins.get(pluginId);
    if (summary === undefined) return operationFailed(protocolError("INTERNAL_ERROR"));
    return operationSucceeded({ plugin: summary });
  } finally {
    // The registry is released only here: after the lifecycle settled, after the
    // final observation, and after this operation knows what it will report.
    lease.release();
  }
}

/**
 * The safe code for a failed lifecycle operation.
 *
 * Read from what the manager recorded, never parsed out of the thrown value: a
 * plugin's own words are not a classification this host is willing to trust.
 */
function pluginOperationError(
  state: HostState,
  pluginId: string,
  operation: "enable" | "disable",
): ProtocolError {
  const info = state.manager.get(pluginId);
  const failure = info?.lastFailure;
  if (failure !== undefined && failure.operation === operation) {
    return protocolError(codeForPluginFailure(failure));
  }
  if (info?.status === "error") return protocolError("PLUGIN_UNAVAILABLE");
  return protocolError("INTERNAL_ERROR");
}

function findRun(
  state: HostState,
  params: { readonly runId?: string; readonly submissionId?: string },
): RunEntry | undefined {
  if (params.runId !== undefined) return state.runs.get(params.runId);
  if (params.submissionId !== undefined) {
    const runId = state.submissions.get(params.submissionId);
    return runId === undefined ? undefined : state.runs.get(runId);
  }
  return undefined;
}

/** The success envelope for one request, without the method-specific encoding. */
function hostResponse<R>(
  state: HostState,
  requestId: string,
  result: R,
): {
  readonly kind: "host-response";
  readonly protocolVersion: "1";
  readonly hostInstanceId: string;
  readonly requestId: string;
  readonly result: R;
} {
  return {
    kind: "host-response",
    protocolVersion: PROTOCOL_VERSION,
    hostInstanceId: state.hostInstanceId,
    requestId,
    result,
  };
}

function respond<R>(
  state: HostState,
  connection: ConnectionState,
  requestId: string,
  outcome: OperationOutcome<R>,
  encode: (result: R) => EncodedFrame,
): void {
  if (!outcome.ok) {
    replyError(state, connection, requestId, outcome.error);
    return;
  }
  sendSuccess(state, connection, requestId, encode(outcome.result));
}

function sendSuccess(
  state: HostState,
  connection: ConnectionState,
  requestId: string,
  encoded: EncodedFrame,
): void {
  if (encoded.success) {
    sendFrame(state, connection, encoded.output);
    return;
  }
  // The host could not express its own successful result. The honest answer is
  // the error response, which does not depend on the payload that failed.
  replyError(state, connection, requestId, protocolError("INTERNAL_ERROR"));
}

function replyError(
  state: HostState,
  connection: ConnectionState,
  requestId: string,
  error: ProtocolError,
): void {
  const encoded = encodeFrame(
    { kind: "host-response" },
    {
      kind: "host-response",
      protocolVersion: PROTOCOL_VERSION,
      hostInstanceId: state.hostInstanceId,
      requestId,
      error,
    },
  );
  if (encoded.success) {
    sendFrame(state, connection, encoded.output);
    return;
  }
  // A host that cannot even encode its own error has nothing honest left to say
  // on this connection.
  closeConnection(state, connection);
}
