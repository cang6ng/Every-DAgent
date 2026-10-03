/**
 * The protocol dispatcher: every frame a client sends, and the operations behind them.
 *
 * The shape is deliberately a closed switch over the frozen operation names —
 * not a method registry, not a generic RPC front end. Each case builds the
 * response the protocol's own encoder expects for that method, so a result
 * cannot be sent under the wrong method's schema by accident.
 *
 * Three rules run through the whole module. Reads never touch the registry
 * gate: listing, fetching, cancelling and subscription traffic answer while a
 * run or a plugin lifecycle owns the registry, because the contract says an
 * occupied host still lets a client look and still lets it cancel. A write is
 * refused the moment the store cannot be trusted, because an unconfirmed write
 * is exactly what a client must not read as done. And a frame is handled from a
 * microtask, never from inside the channel's own callback, so a transport that
 * delivers synchronously cannot re-enter a host transaction through `send`.
 */

import type {
  ClientCapabilities,
  ClientRequestFor,
  DecodedEnvelope,
  HostCapabilities,
  JsonValue,
  OperationMap,
  OperationName,
  ProtocolError,
  ProtocolErrorCode,
  ValidationFailureReason,
} from "@every-dagent/protocol";
import type { PluginFailure } from "@every-dagent/plugin-system";
import { PROTOCOL_VERSION, decodeFrame, encodeFrame, validateMessage } from "@every-dagent/protocol";

import {
  assertEventBuilds,
  closeConnection,
  collectionInvalidatedEvent,
  observePlugin,
  publishEvent,
  publishValidatedEvent,
  sendFrame,
  sessionCreatedEvent,
  sessionDeletedEvent,
  sessionUpdatedEvent,
  settingsUpdatedEvent,
} from "./connection.js";
import {
  codeForPluginFailure,
  limitExceededError,
  protocolError,
  revisionConflictError,
  shuttingDownError,
  staleCursorError,
  storageUnavailableError,
} from "./errors.js";
import { HOST_LIMITS } from "./limits.js";
import { defaultTitle, readHistoryPage, readRunPage, readSessionPage, sessionSummaryOf } from "./history.js";
import { settingsSnapshotOf, settingsTargetOf, validateSettingsValue } from "./configuration.js";
import { ProjectionError } from "./projection.js";
import { answerReversePending, dropReverseForStream } from "./reverse.js";
import { blockCorruptedSession, cancelRun, markStorageFault, readRun, startRun } from "./run.js";
import { CommitOutcomeUnknownError, StoreUntrustedError } from "./repository.js";
import { MAX_SETTINGS_VALUE_BYTES } from "./settings-profile.js";
import {
  captureHostSnapshot,
  newId,
  operationFailed,
  operationSucceeded,
  pluginSummaryOf,
  PREPARED_REQUEST_ID,
  trackTask,
  type ConnectionState,
  type HostState,
  type OperationOutcome,
} from "./state.js";

type EncodedFrame = ReturnType<typeof encodeFrame>;
type ClientRequestEnvelope = Extract<DecodedEnvelope, { kind: "client-request" }>;
type ClientResponseEnvelope = Extract<DecodedEnvelope, { kind: "client-response" }>;
type SessionResult = OperationMap["sessions.create"]["result"];
type RunResult = OperationMap["runs.start"]["result"];
type PluginResult = OperationMap["plugins.enable"]["result"];

const HOST_CAPABILITIES: HostCapabilities = Object.freeze({
  sessions: true,
  runs: true,
  plugins: true,
  subscriptions: true,
  // Backed by the generic mechanism in `reverse.ts`: a connection that also
  // declares the capability can be asked, its answer is correlated and
  // validated against the profile that made the method real, and every pending
  // ends with its connection, its stream or the host. The *business* registry is
  // empty — no shipped method exists — but the mechanism itself is real and
  // tested, which is exactly what this flag claims.
  reverseRequests: true,
  historyPages: true,
  sessionMutations: true,
  // Reads and CAS updates, by namespace. Claimed only because every layer of it
  // is really wired: the store holds desired values, the startup composes from
  // them, a mutation is refused while the host is busy or its store unconfirmed,
  // and a subscriber is told which revisions moved.
  settings: true,
  // Real, end to end: the Core prepared the execution, this host decides with
  // a trusted policy, an approval is held in memory with a deadline, the
  // `tool.approval` profile asks a capable client, and the dispatch guard runs
  // on the answer. Claimed only because every one of those is wired.
  approvals: true,
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
  FRAME_TOO_LARGE: "LIMIT_EXCEEDED",
});

/**
 * The operations whose answer is a claim about *current* state.
 *
 * A storage fault ends this host's ability to vouch for what is current: the
 * outcome of the execution it was streaming may or may not have landed, and
 * nothing the host can read makes that a fact again — only a restart
 * reconciles it. So these are refused for as long as the fault stands: a
 * directory that still points at the unfinished run, a run query that would
 * call it `running`, and a cut that would present it as current. The
 * subscription is where a client bootstrap happens, and a successful bootstrap
 * out of a faulted host is exactly the claim this set exists to prevent.
 *
 * What is deliberately not here: `host.describe` (the identity and the static
 * capabilities are still true, and a describe is not a state bootstrap),
 * `sessions.history` (committed canonical, readable as the store's own facts),
 * `plugins.list` (this host's own catalogue), `runs.cancel` (a fault must not
 * prevent aborting work that is still running) and `subscriptions.close`
 * (delivery, not state).
 */
const CURRENT_STATE_METHODS: ReadonlySet<OperationName> = new Set([
  "sessions.list",
  "sessions.get",
  "runs.get",
  "runs.list",
  "subscriptions.open",
  // A settings read claims what the desired *and* the effective state are, and
  // a settings write is a write like any other: a host that cannot confirm a
  // commit has neither. `plugins.list` stays readable — its summaries are this
  // instance's own facts — and `settings.get` does not.
  "settings.get",
  "settings.update",
]);

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
 * Reads one client response.
 *
 * Two kinds arrive here: an answer to a reverse request this host is still
 * waiting for, and a frame that is associated with nothing — v2 ships no
 * business reverse method, so an unassociated response is validated and dropped
 * without answering it or touching the run it may have been meant for.
 *
 * An associated answer has to match this connection's context before it can
 * settle anything: the instance, the stream the request was sent on, and the
 * profile that made the method sendable. Anything else is a peer that cannot be
 * trusted with the wait, and the connection ends — the pending included.
 */
function acceptClientResponse(
  state: HostState,
  connection: ConnectionState,
  envelope: ClientResponseEnvelope,
): void {
  const pending = connection.reverse.pending.get(envelope.requestId);

  if (pending === undefined) {
    if (!validateMessage({ kind: "client-response" }, envelope).success) {
      closeConnection(state, connection);
    }
    return;
  }

  if (
    envelope.protocolVersion !== PROTOCOL_VERSION ||
    envelope.hostInstanceId !== state.hostInstanceId ||
    envelope.streamId !== pending.streamId
  ) {
    closeConnection(state, connection);
    return;
  }

  const validated = validateMessage({ kind: "client-response" }, envelope);
  if (!validated.success) {
    closeConnection(state, connection);
    return;
  }

  const answer = validated.output;
  if (answer.error !== undefined) {
    answerReversePending(connection, pending, { ok: false, error: answer.error });
    return;
  }
  if (!pending.acceptsResult(answer.result)) {
    closeConnection(state, connection);
    return;
  }

  // The profile's business half, run here and now: a claim is the synchronous
  // linearization point of an answer, so the winner of two near-simultaneous
  // decisions is decided by frame order and never by which promise resolved
  // first. A refused claim is a peer this side may not keep waiting on.
  const profile = connection.reverse.profiles.get(pending.method);
  if (profile?.claim !== undefined) {
    let claimed: boolean;
    try {
      claimed = profile.claim(pending, answer.result as JsonValue);
    } catch {
      claimed = false;
    }
    if (!claimed) {
      closeConnection(state, connection);
      return;
    }
  }
  answerReversePending(connection, pending, { ok: true, result: answer.result });
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

  // One authority for what a faulted host may still answer. The check is
  // synchronous and in front of every current-state read, so a fault that
  // lands between two frames cannot be raced by a bootstrap that was already
  // in flight: by the time this runs, the fault either stands — and the
  // answer is refusal — or it does not exist yet and the state is whole.
  if (state.storageFault && CURRENT_STATE_METHODS.has(request.method)) {
    replyError(state, connection, requestId, storageUnavailableError());
    return;
  }

  switch (request.method) {
    case "sessions.list": {
      let page;
      try {
        page = readSessionPage(state.repository, request.params.cursor, request.params.limit);
      } catch (error) {
        answerReadFailure(state, connection, requestId, error, undefined);
        return;
      }
      if ("failure" in page) {
        replyError(state, connection, requestId, staleCursorError());
        return;
      }
      sendSuccess(
        state,
        connection,
        requestId,
        encodeFrame(
          { kind: "host-response", method: "sessions.list" },
          hostResponse(state, requestId, { sessions: page.page }),
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
      let record;
      try {
        record = state.repository.getSession(request.params.sessionId);
      } catch (error) {
        answerReadFailure(state, connection, requestId, error, undefined);
        return;
      }
      if (record === undefined) {
        replyError(state, connection, requestId, protocolError("SESSION_NOT_FOUND"));
        return;
      }
      sendSuccess(
        state,
        connection,
        requestId,
        encodeFrame(
          { kind: "host-response", method: "sessions.get" },
          hostResponse(state, requestId, { session: sessionSummaryOf(record) }),
        ),
      );
      return;
    }

    case "sessions.history": {
      let outcome;
      try {
        outcome = readHistoryPage(state.repository, request.params.sessionId, request.params.cursor, request.params.limit);
      } catch (error) {
        // Durable facts that do not agree with what they claim to be are
        // refused, not repaired: the page is not served, and the caller is told
        // the host could not answer rather than shown a rewritten conversation.
        answerReadFailure(state, connection, requestId, error, request.params.sessionId);
        return;
      }
      if (outcome.kind === "session-not-found") {
        replyError(state, connection, requestId, protocolError("SESSION_NOT_FOUND"));
        return;
      }
      if (outcome.kind === "failure") {
        replyError(
          state,
          connection,
          requestId,
          outcome.failure === "stale" ? staleCursorError() : protocolError("INVALID_REQUEST"),
        );
        return;
      }
      sendSuccess(
        state,
        connection,
        requestId,
        encodeFrame(
          { kind: "host-response", method: "sessions.history" },
          hostResponse(state, requestId, { page: outcome.result.page }),
        ),
      );
      return;
    }

    case "sessions.rename":
      respond(
        state,
        connection,
        requestId,
        renameSession(state, request.params.sessionId, request.params.expectedRevision, request.params.title),
        (result) =>
          encodeFrame({ kind: "host-response", method: "sessions.rename" }, hostResponse(state, requestId, result)),
      );
      return;

    case "sessions.delete":
      respond(
        state,
        connection,
        requestId,
        deleteSession(state, request.params.sessionId, request.params.expectedRevision),
        (result) =>
          encodeFrame({ kind: "host-response", method: "sessions.delete" }, hostResponse(state, requestId, result)),
      );
      return;

    case "runs.start":
      respond(state, connection, requestId, startRun(state, request.params), (result) =>
        encodeFrame({ kind: "host-response", method: "runs.start" }, hostResponse(state, requestId, result)),
      );
      return;

    case "runs.get":
      respond(state, connection, requestId, readRun(state, request.params), (result) =>
        encodeFrame({ kind: "host-response", method: "runs.get" }, hostResponse(state, requestId, result)),
      );
      return;

    case "runs.list": {
      let known;
      let page;
      try {
        known = state.repository.getSession(request.params.sessionId);
        if (known === undefined) {
          replyError(state, connection, requestId, protocolError("SESSION_NOT_FOUND"));
          return;
        }
        page = readRunPage(state.repository, request.params.sessionId, request.params.cursor, request.params.limit);
      } catch (error) {
        // A run whose recorded range is not the turn the index holds is a fact
        // this host did not write; the page that would carry it is refused
        // rather than served with one rewritten entry.
        answerReadFailure(state, connection, requestId, error, request.params.sessionId);
        return;
      }
      if ("failure" in page) {
        replyError(state, connection, requestId, staleCursorError());
        return;
      }
      sendSuccess(
        state,
        connection,
        requestId,
        encodeFrame(
          { kind: "host-response", method: "runs.list" },
          hostResponse(state, requestId, { runs: page.page }),
        ),
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

    case "settings.get":
      respond(state, connection, requestId, readSettings(state, request.params.namespace), (result) =>
        encodeFrame(
          { kind: "host-response", method: "settings.get" },
          hostResponse(state, requestId, result),
        ),
      );
      return;

    case "settings.update":
      respond(state, connection, requestId, updateSettings(state, request.params), (result) =>
        encodeFrame(
          { kind: "host-response", method: "settings.update" },
          hostResponse(state, requestId, result),
        ),
      );
      return;

    case "subscriptions.open": {
      // The cut and the response are one synchronous step: the snapshot is what
      // the catalogues hold right now, and the response is queued on this
      // connection before anything can put an event on the new stream.
      //
      // A replacement ends the old scope first: its reverse requests can no
      // longer be answered, and clearing them here — before the cut — keeps
      // their completion from landing in the middle of it.
      const previous = connection.subscription;
      if (previous !== undefined) dropReverseForStream(connection, previous.streamId, "stream-gone");

      const streamId = newId();
      let snapshot;
      try {
        // The cut is held to the frame this very request will be answered
        // with, so what it accepts is exactly what can travel.
        snapshot = captureHostSnapshot(state, streamId, requestId);
      } catch (error) {
        // The cut could not be composed at all — a directory that cannot be
        // read, or a state that cannot be published inside one frame after
        // every honest reduction. The caller is told the host failed rather
        // than left waiting for a cut that will never arrive.
        answerReadFailure(state, connection, requestId, error, undefined);
        return;
      }
      const result: OperationMap["subscriptions.open"]["result"] = { snapshot };
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
      // The cut carries the current approval; the delivery that asks about it
      // follows on the same stream, so a client that reconnected is asked
      // again with this stream's own request id instead of being left with an
      // approval it can see but cannot answer.
      state.execution.offerToConnection(connection);
      return;
    }

    case "subscriptions.close": {
      const current = connection.subscription;
      const closed = current !== undefined && current.streamId === request.params.streamId;
      if (closed) {
        connection.subscription = undefined;
        dropReverseForStream(connection, request.params.streamId, "stream-gone");
      }
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
    storage: {
      storageId: state.repository.storageId,
      retention: state.repository.retention,
      schemaVersion: state.repository.schemaVersion,
    },
    capabilities: HOST_CAPABILITIES,
    clientCapabilities: { reverseRequests: clientCapabilities.reverseRequests },
    limits: HOST_LIMITS,
  };

  sendSuccess(
    state,
    connection,
    requestId,
    encodeFrame({ kind: "host-response", method: "host.describe" }, hostResponse(state, requestId, result)),
  );
}

/**
 * A new, empty session, committed before it is announced.
 *
 * Allowed while the host is occupied — creating an entry changes no registry
 * and can wait for nothing — but refused once the host is shutting down, like
 * every other write.
 */
function createHostSession(state: HostState): OperationOutcome<SessionResult> {
  if (state.closing) return operationFailed(shuttingDownError());
  if (state.storageFault) return operationFailed(storageUnavailableError());

  const sessionId = newId();
  const createdAt = Date.now();

  let record;
  try {
    record = state.repository.createSession({
      sessionId,
      title: defaultTitle(sessionId, new Date(createdAt)),
      createdAt,
    });
  } catch {
    return operationFailed(storageUnavailableError());
  }

  const summary = sessionSummaryOf(record);
  const build = sessionCreatedEvent(summary, state.repository.revisions);
  try {
    assertEventBuilds(state, build);
  } catch {
    return operationFailed(protocolError("INTERNAL_ERROR"));
  }

  publishEvent(state, build);
  return operationSucceeded({ session: summary });
}

/**
 * Renames one session, against the revision the caller read.
 *
 * The compare-and-set is the whole operation: a rename that expected a revision
 * the session has since moved past is refused rather than applied on top of
 * facts the caller never saw.
 */
function renameSession(
  state: HostState,
  sessionId: string,
  expectedRevision: number,
  title: string,
): OperationOutcome<SessionResult> {
  if (state.closing) return operationFailed(shuttingDownError());
  if (state.storageFault) return operationFailed(storageUnavailableError());

  let outcome;
  try {
    outcome = state.repository.renameSession({ sessionId, expectedRevision, title, at: Date.now() });
  } catch {
    return operationFailed(storageUnavailableError());
  }

  if (outcome.kind === "not-found") return operationFailed(protocolError("SESSION_NOT_FOUND"));
  if (outcome.kind === "revision-conflict") return operationFailed(revisionConflictError());

  const summary = sessionSummaryOf(outcome.session);

  // The rename committed and it moved the session's own catalogue revision, so
  // the change is announced with it — the same one-step shape create and
  // delete already have. A replica that asked for this rename may never keep
  // serving the old title, and a client that connects afterwards reads the
  // very summary this response carries.
  try {
    const build = sessionUpdatedEvent(summary, state.repository.revisions);
    assertEventBuilds(state, build);
    publishEvent(state, build);
  } catch {
    // The durable fact stands and the caller is answered from it; a subscriber
    // that could not be told reads the new summary on its next cut or list.
  }

  return operationSucceeded({ session: summary });
}

/**
 * Deletes one session, its runs and its history, as one transaction.
 *
 * Refused while a run of this session is live on this host or the durable row
 * still points at one, because an execution that owns work must not have its
 * only record deleted out from under it. The deletion is not a cancel, and the
 * confirmation says exactly what was removed.
 */
function deleteSession(
  state: HostState,
  sessionId: string,
  expectedRevision: number,
): OperationOutcome<OperationMap["sessions.delete"]["result"]> {
  if (state.closing) return operationFailed(shuttingDownError());
  if (state.storageFault) return operationFailed(storageUnavailableError());

  for (const run of state.runs.values()) {
    if (run.sessionId === sessionId && run.terminal === undefined) {
      return operationFailed(protocolError("HOST_BUSY"));
    }
  }

  let outcome;
  try {
    outcome = state.repository.deleteSession({ sessionId, expectedRevision, at: Date.now() });
  } catch {
    return operationFailed(storageUnavailableError());
  }

  if (outcome.kind === "not-found") return operationFailed(protocolError("SESSION_NOT_FOUND"));
  if (outcome.kind === "revision-conflict") return operationFailed(revisionConflictError());
  if (outcome.kind === "busy") return operationFailed(protocolError("HOST_BUSY"));

  const build = sessionDeletedEvent(sessionId, outcome.generation, state.repository.revisions);
  try {
    assertEventBuilds(state, build);
  } catch {
    return operationFailed(protocolError("INTERNAL_ERROR"));
  }
  publishEvent(state, build);

  return operationSucceeded({ sessionId, generation: outcome.generation, deleted: true as const });
}

/**
 * One plugin lifecycle operation, under the registry's mutation ownership.
 *
 * The task is registered before the manager is called, and the manager is
 * called from a microtask: an activation runs synchronously up to its first
 * await, may hand out a storage view, and may run the plugin's own code — all
 * of which a shutdown that is already waiting has to be able to see.
 */
function operatePlugin(
  state: HostState,
  pluginId: string,
  operation: "enable" | "disable",
): Promise<OperationOutcome<PluginResult>> {
  if (state.closing) return Promise.resolve(operationFailed(shuttingDownError()));

  // The fault boundary, in front of both lifecycle mutations, for the one
  // reason each of them has. An `enable` adds executable capability: the
  // tool set this host would run with is not something a host that can no
  // longer vouch for its current state may grow. A `disable` is the same
  // class of write request as every other refused mutation, and its one
  // durable effect — the catalogue revision — must not land after the fault
  // either. Neither is a necessary cleanup: a shutdown releases plugins
  // through the manager directly, never through this operation, so refusing
  // here strands nothing. `plugins.list` is not a lifecycle mutation and
  // stays readable.
  if (state.storageFault) return Promise.resolve(operationFailed(storageUnavailableError()));

  const info = state.manager.get(pluginId);
  if (info === undefined) return Promise.resolve(operationFailed(protocolError("PLUGIN_NOT_FOUND")));
  // No refusal on the manager's error state, for either operation: the desired
  // intent is committed before the lifecycle is touched, so a plugin that could
  // never be asked to stop would keep a durable intent to run across a restart
  // and be attempted again on every startup. A lifecycle that fails anyway is
  // reported truthfully below, with the intent the client asked for intact.

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
  let storageFailure: unknown;
  const observe = (): void => {
    try {
      observePlugin(state, pluginId);
    } catch (error) {
      // Two different failures, told apart by what they are: a summary the
      // protocol cannot carry is a host limitation, while a catalogue revision
      // that could not be recorded durably means this host can no longer say
      // what its own catalogue version is — the same unconfirmable-write
      // boundary every other durable write obeys.
      if (error instanceof ProjectionError) {
        projectionFailed = true;
        return;
      }
      if (storageFailure === undefined) storageFailure = error;
    }
  };

  // What the manager recorded before this attempt: a refusal that does not add
  // a failure is the error state answering, and the code a client sees should
  // say so rather than quote a lifecycle failure from an earlier request.
  const failureBefore = state.manager.get(pluginId)?.lastFailure;

  try {
    // The desired intent is committed first, and the lifecycle is not touched
    // until it is durable. A store that cannot confirm the intent gets no
    // lifecycle at all: a plugin that changed state without a recorded intent
    // would be one no later startup could explain, and the client's request
    // would have taken effect somewhere this host cannot account for.
    const desiredEnabled = operation === "enable";
    let intent;
    try {
      intent = state.repository.setPluginDesiredEnabled({
        pluginId,
        desiredEnabled,
        at: Date.now(),
      });
    } catch (error) {
      if (error instanceof CommitOutcomeUnknownError) markStorageFault(state);
      return operationFailed(storageUnavailableError());
    }

    const changed = state.pluginIntents.get(pluginId) !== intent.desiredEnabled;
    state.pluginIntents.set(pluginId, intent.desiredEnabled);
    // The intent is durable now, so what this publishes is a fact rather than
    // an intention. Publishing before the lifecycle runs is the honest order:
    // "wanted, not yet enabled" is exactly the truth at this moment, and a
    // lifecycle that fails leaves it standing.
    if (changed) observe();

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

    if (storageFailure !== undefined) {
      // The lifecycle ran — the manager's own fact, which nothing here undoes —
      // but the catalogue revision that has to travel with it did not land, so
      // no success is published and no current state is claimed. The host stops
      // vouching for writes rather than keep a catalogue whose version it
      // cannot state.
      markStorageFault(state);
      return operationFailed(storageUnavailableError());
    }
    if (projectionFailed) return operationFailed(protocolError("INTERNAL_ERROR"));
    if (result.failed) {
      return operationFailed(pluginOperationError(state, pluginId, operation, failureBefore));
    }

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
 * `failureBefore` is how the two kinds of failure are told apart: a manager in
 * its error state refuses to operate at all and records nothing new, so the
 * same failure object coming back means the state answered — which has its own
 * code and is not a lifecycle failure this request caused.
 */
function pluginOperationError(
  state: HostState,
  pluginId: string,
  operation: "enable" | "disable",
  failureBefore: PluginFailure | undefined,
): ProtocolError {
  const info = state.manager.get(pluginId);
  const failure = info?.lastFailure;
  if (failure === failureBefore) {
    return info?.status === "error"
      ? protocolError("PLUGIN_UNAVAILABLE")
      : protocolError("INTERNAL_ERROR");
  }
  if (failure !== undefined && failure.operation === operation) {
    return protocolError(codeForPluginFailure(failure));
  }
  if (info?.status === "error") return protocolError("PLUGIN_UNAVAILABLE");
  return protocolError("INTERNAL_ERROR");
}

/** The result both settings operations answer with. */
type SettingsResult = OperationMap["settings.get"]["result"];

/**
 * One bounded read of a namespace: what is stored, and what this instance runs.
 *
 * It takes no lease: a read is not a mutation, and the contract says an occupied
 * host still lets a client look. What it does *not* do is serve a namespace this
 * host has no business answering about — an arbitrary name, an unknown plugin,
 * or a registered plugin that declares no configuration contract are one
 * answer, and it is not "here is some stored value".
 */
function readSettings(state: HostState, namespace: string): OperationOutcome<SettingsResult> {
  const target = settingsTargetOf(namespace, state.settingsAuthority.pluginContracts);
  if (target === undefined) return operationFailed(protocolError("CAPABILITY_NOT_SUPPORTED"));

  let record;
  try {
    record = state.repository.getSettingsNamespace(namespace);
  } catch (error) {
    return operationFailed(
      error instanceof StoreUntrustedError ? storageUnavailableError() : protocolError("INTERNAL_ERROR"),
    );
  }
  if (record === undefined) return operationFailed(protocolError("INTERNAL_ERROR"));

  const snapshot = settingsSnapshotOf({
    namespace,
    desired: record,
    effective: state.configuration.effective.get(namespace),
  });
  // A stored value this host cannot read as JSON is refused, not repaired: the
  // caller is told the host could not answer rather than shown a rewritten one.
  if (snapshot === undefined) return operationFailed(protocolError("INTERNAL_ERROR"));
  return operationSucceeded({ settings: snapshot });
}

/**
 * One compare-and-set write of a namespace's desired value.
 *
 * The order is the contract. A closed/storage check comes first, then the
 * registry's own mutation lease — taken, not waited for, so a busy host answers
 * HOST_BUSY rather than racing a run it is executing. The value is validated by
 * the authority this instance started with, the frame the caller will receive
 * is composed and measured *before* anything durable happens, and only then
 * does the CAS run. A conflict writes nothing and a lost receipt is answered
 * from the batch's own evidence — never by rewriting, replaying or assuming a
 * rollback. What the caller receives on success is a *desired* commit: this
 * instance keeps running what it started with, and the answer says so.
 */
function updateSettings(
  state: HostState,
  params: { readonly namespace: string; readonly expectedRevision: number; readonly value: import("@every-dagent/protocol").JsonValue },
): OperationOutcome<SettingsResult> {
  if (state.closing) return operationFailed(shuttingDownError());
  if (state.storageFault) return operationFailed(storageUnavailableError());

  const target = settingsTargetOf(params.namespace, state.settingsAuthority.pluginContracts);
  if (target === undefined) return operationFailed(protocolError("CAPABILITY_NOT_SUPPORTED"));

  const lease = state.gate.tryAcquire("mutation");
  if (lease === undefined) return operationFailed(protocolError("HOST_BUSY"));
  try {
    return applySettingsUpdate(state, target, params);
  } finally {
    // The lease is released only here: after the durable commit, after any
    // publication, and after this operation knows what it will answer.
    lease.release();
  }
}

function applySettingsUpdate(
  state: HostState,
  target: import("./configuration.js").SettingsTarget,
  params: { readonly namespace: string; readonly expectedRevision: number; readonly value: import("@every-dagent/protocol").JsonValue },
): OperationOutcome<SettingsResult> {
  // The value as storage will hold it, measured the way storage measures it:
  // escaped, in UTF-8, against the one bound this profile enforces.
  const valueJson = JSON.stringify(params.value);
  if (Buffer.byteLength(valueJson, "utf8") > MAX_SETTINGS_VALUE_BYTES) {
    return operationFailed(limitExceededError());
  }

  const checked = validateSettingsValue({
    target,
    value: params.value,
    authority: state.settingsAuthority,
  });
  if (!checked.ok) return operationFailed(protocolError("SETTINGS_INVALID"));

  let current;
  try {
    current = state.repository.getSettingsNamespace(params.namespace);
  } catch (error) {
    return operationFailed(
      error instanceof StoreUntrustedError ? storageUnavailableError() : protocolError("INTERNAL_ERROR"),
    );
  }
  // A managed namespace exists from the moment the store is initialized; one
  // that does not is a store this host cannot have written, and an update is
  // not an initialization.
  if (current === undefined) return operationFailed(protocolError("INTERNAL_ERROR"));

  // The frame the caller will receive, composed now and held to the frame bound
  // — the desired value *and* the effective one, so an update cannot succeed
  // and then fail to be expressible.
  const prospective: SettingsResult = {
    settings: Object.freeze({
      namespace: params.namespace,
      desiredRevision: current.revision + 1,
      effectiveRevision: state.configuration.effective.get(params.namespace)?.revision ?? null,
      restartRequired: true,
      desiredValue: params.value,
      effectiveValue: state.configuration.effective.get(params.namespace)?.value ?? null,
    }),
  };
  if (!settingsResultFits(state, prospective)) {
    return operationFailed(limitExceededError());
  }

  let outcome;
  try {
    outcome = state.repository.updateSettingsNamespace({
      namespace: params.namespace,
      expectedRevision: params.expectedRevision,
      schemaVersion: checked.schemaVersion,
      valueJson,
      at: Date.now(),
    });
  } catch (error) {
    if (error instanceof CommitOutcomeUnknownError) markStorageFault(state);
    return operationFailed(storageUnavailableError());
  }

  if (outcome.kind === "not-found") return operationFailed(protocolError("INTERNAL_ERROR"));
  if (outcome.kind === "revision-conflict") return operationFailed(revisionConflictError());

  const snapshot = settingsSnapshotOf({
    namespace: params.namespace,
    desired: outcome.record,
    effective: state.configuration.effective.get(params.namespace),
  });
  if (snapshot === undefined) return operationFailed(protocolError("INTERNAL_ERROR"));

  // The commit stands from here on. What follows is publication: the settings
  // invalidation always, and — for a plugin's configuration — the summary whose
  // revision moved and the catalogue revision that travels with it.
  const restartRequired = snapshot.restartRequired;
  try {
    publishValidatedEvent(
      state,
      settingsUpdatedEvent(params.namespace, outcome.record.revision, restartRequired),
    );
  } catch {
    // A subscriber that cannot be told reads the new state on its next cut or
    // read; the durable commit is not undone by a delivery failure.
  }

  if (target.kind === "plugin") {
    const revisions = state.pluginConfigRevisions.get(target.pluginId);
    if (revisions !== undefined) revisions.desired = outcome.record.revision;
    try {
      observePlugin(state, target.pluginId);
    } catch (error) {
      // The configuration is committed, but the catalogue revision that has to
      // travel with its summary did not land: this host can no longer state
      // which catalogue version it is serving, so it stops claiming one.
      if (!(error instanceof ProjectionError)) markStorageFault(state);
      return operationFailed(storageUnavailableError());
    }
  }

  return operationSucceeded({ settings: snapshot });
}

/**
 * Whether one settings result can travel in one frame, measured with the
 * protocol's own encoder on the frame the caller will really receive.
 */
function settingsResultFits(state: HostState, result: SettingsResult): boolean {
  // The method is fixed here: an update's success answer is the same shape a
  // read answers with, and it is the frame this caller will receive.
  return encodeFrame(
    { kind: "host-response", method: "settings.update" },
    hostResponse(state, PREPARED_REQUEST_ID, result),
  ).success;
}

/** The success envelope for one request, without the method-specific encoding. */
function hostResponse<R>(
  state: HostState,
  requestId: string,
  result: R,
): {
  readonly kind: "host-response";
  readonly protocolVersion: "2";
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
  // the error response, which does not depend on the payload that failed — and
  // when the payload was simply too large, that is what the caller is told.
  replyError(
    state,
    connection,
    requestId,
    protocolError(encoded.failure.reason === "FRAME_TOO_LARGE" ? "LIMIT_EXCEEDED" : "INTERNAL_ERROR"),
  );
}

/**
 * What a failed durable read means on the wire.
 *
 * A connection that could not end its transaction cannot say what the store
 * holds: that is a store the host cannot answer from at all — no client's
 * mistake, and not evidence about anything — so the caller gets
 * STORAGE_UNAVAILABLE rather than an answer read off rows that may never land.
 *
 * Corruption is the other case. A session whose committed canonical is not what
 * it claims is blocked durably, so no later run executes against a history the
 * host cannot read, and the caller is told the host could not answer instead of
 * being served a repaired fact.
 */
function answerReadFailure(
  state: HostState,
  connection: ConnectionState,
  requestId: string,
  error: unknown,
  sessionId: string | undefined,
): void {
  if (error instanceof StoreUntrustedError) {
    replyError(state, connection, requestId, storageUnavailableError());
    return;
  }
  if (sessionId !== undefined) blockCorruptedSession(state, sessionId);
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
