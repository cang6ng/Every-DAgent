/**
 * The delivery side of the host: logical connections, the frames queued for
 * them, and the eight event types the frozen contract lets the host publish.
 *
 * Delivery is deliberately not part of any state commit. A host fact is
 * recorded and expressed as a frame into a bounded local queue; whether a
 * client exists, is subscribed, is reading, or is still connected are all
 * questions this module answers with "drop it" or "close that connection", and
 * never with "stop the work".
 */

import type {
  ActiveRunSnapshot,
  CollectionRevisions,
  EventScope,
  HostEvent,
  LiveToolItem,
  PluginSummary,
  ProtocolChannel,
  SessionSummary,
  TerminalRunSnapshot,
} from "@every-dagent/protocol";
import { encodeFrame, validateMessage } from "@every-dagent/protocol";

import { HOST_LIMITS, OUTBOX_LIMIT_FRAMES } from "./limits.js";
import { ProjectionError, pluginFactsOf, projectPluginInfo, samePluginSummary } from "./projection.js";
import { createReverseConnectionState, dropAllReverse } from "./reverse.js";
import type { ReverseProfile } from "./reverse.js";
// Type-only on purpose: `state.ts` reaches `run.ts`, which reaches this module,
// so a value import here would close a cycle through the live-run path — and a
// cycle is enough to break the module identity a test's `vi.mock` depends on.
import type { ConnectionState, HostState, RunEntry } from "./state.js";

/**
 * How much may sit in one connection's queue before the host gives up on it.
 *
 * The queue only grows when a publisher outruns the microtask that drains it,
 * so these are not tuning knobs but a bound on memory a broken or absent reader
 * can cost. Reaching it closes the connection, which the client answers with a
 * resync — the alternative, dropping frames silently, would leave it believing
 * a state it no longer has.
 */
const MAX_OUTBOX_FRAMES = OUTBOX_LIMIT_FRAMES;
const MAX_OUTBOX_BYTES = HOST_LIMITS.maxOutboxBytes;

/** A stream id used only to check that an event can be built at all. */
const PREPARE_STREAM_ID = "prepare:stream";

export interface EventBase {
  readonly kind: "host-event";
  readonly protocolVersion: "2";
  readonly hostInstanceId: string;
  readonly streamId: string;
  readonly sequence: number;
}

/**
 * A pending event, expressed as a function of the envelope it will travel in.
 *
 * It exists as a builder rather than a value because the sequence number and
 * stream id are per subscription: each connection gets its own envelope around
 * the same frozen payload. A builder must therefore be pure and deterministic —
 * the host runs it once to check the event is expressible, and once per
 * subscriber to actually send it.
 */
export type EventBuilder = (base: EventBase) => HostEvent;

type RunScope = Extract<EventScope, { kind: "run" }>;
type SessionScope = Extract<EventScope, { kind: "session" }>;
type PluginScope = Extract<EventScope, { kind: "plugin" }>;

export function createConnection(
  channel: ProtocolChannel,
  profiles: readonly ReverseProfile[],
): ConnectionState {
  return {
    channel,
    requestIds: new Set<string>(),
    initialized: undefined,
    reverse: createReverseConnectionState(profiles),
    detachListener: undefined,
    subscription: undefined,
    outbox: [],
    outboxBytes: 0,
    pumping: false,
    closed: false,
  };
}

/**
 * Removes the frame listener, exactly once.
 *
 * Whether the connection ended remotely, was detached by its owner, or never
 * really started, the listener this host installed has to come off the channel —
 * and `closed` is not a record of that having happened.
 */
export function disposeListener(connection: ConnectionState): void {
  const detach = connection.detachListener;
  connection.detachListener = undefined;
  if (detach === undefined) return;
  try {
    detach();
  } catch {
    // A channel that cannot remove a listener is a channel that is already gone.
  }
}

/**
 * Ends one logical connection.
 *
 * Idempotent, and it never touches a run: a client that goes away stops being
 * told about work that is already owned by the host. Everything that was
 * waiting on this connection ends first — the reverse requests the host sent
 * included — so nothing is still holding a promise when the transport is told
 * to close.
 */
export function closeConnection(state: HostState, connection: ConnectionState): void {
  if (connection.closed) {
    disposeListener(connection);
    return;
  }
  connection.closed = true;
  connection.subscription = undefined;
  dropAllReverse(connection, "closed");
  connection.outbox.length = 0;
  connection.outboxBytes = 0;
  state.connections.delete(connection);
  disposeListener(connection);

  try {
    connection.channel.close();
  } catch {
    // Closing is best effort by definition: the connection is already gone from
    // this host's point of view, and the transport's own failure has no reader
    // here to be reported to.
  }
}

/** Queues one frame for delivery, or closes the connection that cannot hold it. */
export function sendFrame(state: HostState, connection: ConnectionState, frame: string): void {
  if (connection.closed) return;

  if (
    connection.outbox.length >= MAX_OUTBOX_FRAMES ||
    connection.outboxBytes + frame.length > MAX_OUTBOX_BYTES
  ) {
    closeConnection(state, connection);
    return;
  }

  connection.outbox.push(frame);
  connection.outboxBytes += frame.length;

  if (connection.pumping) return;
  connection.pumping = true;
  queueMicrotask(() => {
    pump(state, connection);
  });
}

/**
 * Hands queued frames to the transport in order.
 *
 * A rejection from `send` closes the connection and drops the rest: a transport
 * that cannot take a frame is a transport that cannot be trusted to keep the
 * order the protocol's sequence numbers promise.
 */
function pump(state: HostState, connection: ConnectionState): void {
  for (;;) {
    if (connection.closed) break;
    const frame = connection.outbox.shift();
    if (frame === undefined) break;
    connection.outboxBytes -= frame.length;

    try {
      connection.channel.send(frame);
    } catch {
      closeConnection(state, connection);
      break;
    }
  }
  connection.pumping = false;
}

/**
 * Checks that an event is expressible before anything depends on it.
 *
 * The host validates its own output here, not later: a terminal correction that
 * turns out to be unencodable must be turned into a host failure *before* the
 * published state moves, or the correction would be half applied.
 */
export function assertEventBuilds(state: HostState, build: EventBuilder): void {
  const candidate = build({
    kind: "host-event",
    protocolVersion: "2",
    hostInstanceId: state.hostInstanceId,
    streamId: PREPARE_STREAM_ID,
    sequence: 1,
  });
  if (!validateMessage({ kind: "host-event" }, candidate).success) {
    throw new ProjectionError("the event is not expressible in the protocol");
  }
}

/**
 * Sends one event to exactly one connection.
 *
 * The reverse seam needs this: a cancellation notice is addressed to the
 * connection that made the request, on the stream that request lived on, and it
 * consumes that stream's next sequence number like any other event. Broadcasting
 * it would tell unrelated subscribers about a request they never saw.
 */
export function publishEventTo(
  state: HostState,
  connection: ConnectionState,
  build: EventBuilder,
): void {
  const subscription = connection.subscription;
  if (subscription === undefined || connection.closed) return;

  const sequence = subscription.sequence + 1;
  const encoded = encodeFrame(
    { kind: "host-event" },
    build({
      kind: "host-event",
      protocolVersion: "2",
      hostInstanceId: state.hostInstanceId,
      streamId: subscription.streamId,
      sequence,
    }),
  );
  if (!encoded.success) {
    throw new ProjectionError("the event could not be encoded for a subscriber");
  }

  subscription.sequence = sequence;
  sendFrame(state, connection, encoded.output);
}

/**
 * Sends one event to every subscribed connection.
 *
 * Each subscriber gets its own envelope with its own next sequence number, so
 * the event is built per connection around the same frozen payload. A
 * connection that cannot take the frame is closed by the queue, not by this
 * function: publishing never fails because a reader did.
 */
export function publishEvent(state: HostState, build: EventBuilder): void {
  for (const connection of [...state.connections]) {
    publishEventTo(state, connection, build);
  }
}

/**
 * Validates and publishes in one step. The only way a state commit is allowed
 * to announce itself.
 */
export function publishValidatedEvent(state: HostState, build: EventBuilder): void {
  assertEventBuilds(state, build);
  publishEvent(state, build);
}

// ---------------------------------------------------------------------------
// Event builders. Frozen payloads, one scope each, no host objects.
// ---------------------------------------------------------------------------

function runScope(run: RunEntry): RunScope {
  return Object.freeze({ kind: "run" as const, sessionId: run.sessionId, runId: run.runId });
}

/** A non-terminal run state: accepted, running, first turn id, cancel requested. */
export function runUpdatedEvent(run: RunEntry, snapshot: ActiveRunSnapshot): EventBuilder {
  const scope = runScope(run);
  const payload = Object.freeze({ run: snapshot });
  return (base) => ({ ...base, scope, type: "run.updated", payload });
}

export function runOutputDeltaEvent(run: RunEntry, itemId: string, text: string): EventBuilder {
  const scope = runScope(run);
  const payload = Object.freeze({ itemId, text });
  return (base) => ({ ...base, scope, type: "run.output.delta", payload });
}

/** A call as the Core reported it. Its result slot stays empty; it is not an outcome. */
export function runToolCallEvent(run: RunEntry, item: LiveToolItem): EventBuilder {
  const scope = runScope(run);
  const payload = Object.freeze({ item });
  return (base) => ({ ...base, scope, type: "run.tool.call", payload });
}

export function runToolResultEvent(
  run: RunEntry,
  invocationId: string,
  ok: boolean,
  content: string,
): EventBuilder {
  const scope = runScope(run);
  const payload = Object.freeze({ invocationId, ok, content });
  return (base) => ({ ...base, scope, type: "run.tool.result", payload });
}

/**
 * The one event that carries a terminal run and the settled session together.
 *
 * They travel in one payload because they become true together: a reader must
 * never see the run finished while the session still points at it, nor the new
 * canonical while the run is still live.
 */
export function runEndedEvent(
  run: RunEntry,
  snapshot: TerminalRunSnapshot,
  session: SessionSummary,
  collections: CollectionRevisions,
): EventBuilder {
  const scope = runScope(run);
  const payload = Object.freeze({ run: snapshot, session, collections });
  return (base) => ({ ...base, scope, type: "run.ended", payload });
}

/**
 * A session's summary, announced as brand new.
 *
 * Creating and updating travel as two events because they mean different
 * things to a reader: `created` adds an entry to the directory, `updated`
 * changes one that is already there. Both carry the catalogue revisions the
 * change produced, so a client holding a page from before it knows the page is
 * no longer the current directory.
 */
export function sessionCreatedEvent(session: SessionSummary, collections: CollectionRevisions): EventBuilder {
  const scope: SessionScope = Object.freeze({ kind: "session" as const, sessionId: session.sessionId });
  const payload = Object.freeze({ session, collections });
  return (base) => ({ ...base, scope, type: "session.created", payload });
}

export function sessionUpdatedEvent(session: SessionSummary, collections: CollectionRevisions): EventBuilder {
  const scope: SessionScope = Object.freeze({ kind: "session" as const, sessionId: session.sessionId });
  const payload = Object.freeze({ session, collections });
  return (base) => ({ ...base, scope, type: "session.updated", payload });
}

export function sessionDeletedEvent(
  sessionId: string,
  generation: number,
  collections: CollectionRevisions,
): EventBuilder {
  const scope: SessionScope = Object.freeze({ kind: "session" as const, sessionId });
  const payload = Object.freeze({ sessionId, generation, collections });
  return (base) => ({ ...base, scope, type: "session.deleted", payload });
}

/** A catalogue revision that moved without a summary of its own to carry it. */
export function collectionInvalidatedEvent(collections: CollectionRevisions): EventBuilder {
  const scope: EventScope = Object.freeze({ kind: "host" as const });
  const payload = Object.freeze({ collections });
  return (base) => ({ ...base, scope, type: "collection.invalidated", payload });
}

export function pluginUpdatedEvent(pluginId: string, plugin: PluginSummary): EventBuilder {
  const scope: PluginScope = Object.freeze({ kind: "plugin" as const, pluginId });
  const payload = Object.freeze({ plugin });
  return (base) => ({ ...base, scope, type: "plugin.updated", payload });
}

/**
 * The control notice that ends one reverse request's wait.
 *
 * It is not conversation state: the client's dispatcher aborts the local handler
 * for `requestId` and stops waiting for its answer, and the presentation fold
 * only sees the stream advance.
 */
export function hostRequestCancelledEvent(
  requestId: string,
  reason: "cancelled" | "timeout",
): EventBuilder {
  const scope: EventScope = Object.freeze({ kind: "host" as const });
  const payload = Object.freeze({ requestId, reason });
  return (base) => ({ ...base, scope, type: "host.request.cancelled", payload });
}

/**
 * Reads one plugin's public state, and publishes it if it changed.
 *
 * The comparison is over the safe projection, field by field, so a failure that
 * leaves the status alone but rewrites the safe summary is still a change worth
 * announcing — and an original message that differed but projects identically
 * is not. Nothing here is published twice for the same content, and the
 * published summary is replaced only after the event carrying it is known to be
 * expressible.
 */
export function observePlugin(state: HostState, pluginId: string): PluginSummary | undefined {
  const info = state.manager.get(pluginId);
  if (info === undefined) return undefined;

  const summary = projectPluginInfo(info, pluginFactsOf(state, pluginId));
  const published = state.plugins.get(pluginId);
  if (published !== undefined && samePluginSummary(published, summary)) return summary;

  // Expressibility first, then the durable half, then publication. The
  // catalogue revision is part of the mutation, never a notification after it:
  // a summary that reached subscribers while the revision still described the
  // old catalogue would leave every client holding a page from a version that
  // never was. A bump that cannot be recorded therefore propagates to the
  // caller — which answers with the storage fault and publishes nothing —
  // instead of the change reaching the wire half-committed. The manager's own
  // lifecycle state is a fact about this instance either way, and a restart
  // rebuilds the catalogue from it.
  const build = pluginUpdatedEvent(pluginId, summary);
  assertEventBuilds(state, build);
  const revisions = state.repository.bumpPluginRevision();
  state.plugins.set(pluginId, summary);
  publishEvent(state, build);
  publishEvent(state, collectionInvalidatedEvent(revisions));

  return summary;
}
