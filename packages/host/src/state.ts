/**
 * The host's own data model: the live runs it owns, the connections it serves,
 * and the bounded snapshots it publishes.
 *
 * The directory is no longer here. Sessions, runs and history live in the
 * repository, which is the durable truth; what this module holds is *live*
 * state only — a run while it owns the execution lease, a connection while it
 * is attached — plus the pure functions that project either into the DTOs the
 * protocol carries. That separation is what makes "the host never loads all of
 * your history" structural rather than a promise: there is nowhere here to put
 * it.
 *
 * Publication is synchronous and local: no `await`, no channel call, no plugin
 * call, no user callback. A state commit finishes before any of those could
 * run, which is what makes a terminal correction atomic from a reader's point
 * of view.
 */

import type { AgentRuntime, Session, ToolRegistry, TurnEndReason } from "@every-dagent/agent-core";
import type { PluginManager } from "@every-dagent/plugin-system";
import type {
  ActiveRunSnapshot,
  CollectionRevisions,
  HostLimits,
  HostSnapshot,
  LiveItem,
  PluginSummary,
  ProtocolChannel,
  ProtocolError,
  RunSnapshot,
  RunSummary,
  SessionSummary,
  TerminalRunSnapshot,
} from "@every-dagent/protocol";

import { storedProtocolError } from "./errors.js";
import { readSessionPage } from "./history.js";
import type { Lease, RegistryGate } from "./registry-gate.js";
import type { Repository, RunRecord } from "./repository.js";
import type { ReverseOutcome, ReverseProfile, ReverseTimer } from "./reverse.js";

/** Where the one open tool occurrence of a run currently sits in `live`. */
export interface OpenToolSlot {
  readonly index: number;
  readonly invocationId: string;
  readonly callId: string;
  readonly name: string;
}

/**
 * The bounded window one run executes against.
 *
 * Loaded before the Runtime starts and released when it settles: a run reads
 * the recent turns it needs to continue the conversation, and the rest of the
 * log stays in storage where a turn can be large without costing memory.
 * `loadedSeq` is how many committed events the window already held, which is
 * what makes the newly appended suffix exactly the new suffix.
 */
export interface RunWindow {
  readonly session: Session;
  readonly baseSeq: number;
  readonly loadedSeq: number;
}

export interface RunEntry {
  readonly runId: string;
  readonly submissionId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly controller: AbortController;
  /** Held from before the run record existed until the drain has settled. */
  readonly lease: Lease;
  readonly acceptedAt: number;
  startedAt: number | null;
  turnId: string | null;
  cancelRequested: boolean;
  stage: "accepted" | "running";
  live: LiveItem[];
  /** Encoded size of the published timeline, kept so the bound costs nothing to check. */
  liveBytes: number;
  /** Set once the timeline reached its bound: the run keeps going, the view stops. */
  liveTruncated: boolean;
  /** Index of the open text item; `undefined` means the next chunk opens one. */
  textItemIndex: number | undefined;
  posTool: OpenToolSlot | undefined;
  /** Monotonic source of live item and invocation ids for this run. */
  nextLiveId: number;
  /** The turn end the Runtime stream reported. The log has the final word. */
  observedEnd: TurnEndReason | undefined;
  /**
   * Set when the host could not project or validate this run. A faulted run
   * publishes no further increments and ends as `host_error` with a blocked
   * session, whatever the Core did.
   */
  faulted: boolean;
  /** The committed history this run continues, loaded before the Runtime runs. */
  window: RunWindow | undefined;
  terminal: TerminatedRun | undefined;
}

/** A run that has reached a durable outcome this host published. */
export interface TerminatedRun {
  readonly snapshot: TerminalRunSnapshot;
  readonly summary: SessionSummary;
  readonly revisions: CollectionRevisions;
}

export interface SubscriptionState {
  readonly streamId: string;
  sequence: number;
}

/**
 * One host→client request this connection is still waiting for.
 *
 * The entry is self-contained on purpose: it carries the profile's own result
 * contract and the resolution of the caller's wait, so settling it needs no
 * lookup beyond the connection that owns it.
 */
export interface ReversePendingEntry {
  readonly requestId: string;
  readonly method: string;
  readonly streamId: string;
  /** Whether an answer's `result` satisfies the profile that made this method real. */
  readonly acceptsResult: (result: import("@every-dagent/protocol").JsonValue) => boolean;
  readonly settle: (outcome: ReverseOutcome) => void;
  /** Whether the request itself ever reached the wire; a notice is only owed for one that did. */
  sent: boolean;
  timer: ReverseTimer | undefined;
}

/**
 * The reverse half of one connection: what may be sent, and what is in flight.
 *
 * `requestIds` is this direction's own ledger, kept apart from the ids the
 * client used on the same connection — the two directions are separate accounts,
 * and disambiguating them by `kind` is exactly what the protocol promises.
 */
export interface ReverseConnectionState {
  readonly profiles: ReadonlyMap<string, ReverseProfile>;
  readonly pending: Map<string, ReversePendingEntry>;
  readonly requestIds: Set<string>;
  counter: number;
}

export interface ConnectionState {
  readonly channel: ProtocolChannel;
  /** Every request id this connection has used, in either direction it sent. */
  readonly requestIds: Set<string>;
  /** Set by the first successful `host.describe`; bound for the connection's life. */
  initialized: {
    readonly name: string;
    readonly version: string;
    readonly capabilities: import("@every-dagent/protocol").ClientCapabilities;
  } | undefined;
  readonly reverse: ReverseConnectionState;
  /** Removes the frame listener; the transport itself is closed separately. */
  detachListener: (() => void) | undefined;
  subscription: SubscriptionState | undefined;
  outbox: string[];
  outboxBytes: number;
  pumping: boolean;
  closed: boolean;
}

export interface HostState {
  readonly hostInstanceId: string;
  readonly name: string;
  readonly version: string;
  readonly runtime: AgentRuntime;
  readonly registry: ToolRegistry;
  readonly manager: PluginManager;
  readonly gate: RegistryGate;
  readonly repository: Repository;
  readonly limits: HostLimits;
  /** The published plugin summaries, by id, in registration order. */
  readonly plugins: Map<string, PluginSummary>;
  readonly pluginOrder: string[];
  /** The runs this host is currently executing. Terminal runs live in storage. */
  readonly runs: Map<string, RunEntry>;
  readonly connections: Set<ConnectionState>;
  /** Every accepted task, so shutdown can wait for it to settle. */
  readonly pending: Set<Promise<void>>;
  /**
   * Set when the store failed in a way this host cannot see through.
   *
   * From that moment no new write and no new execution is attempted: the host
   * cannot confirm an outcome, and confirming one is what every write here is
   * for. Reads keep answering, so a client can still see what did happen.
   */
  storageFault: boolean;
  closing: boolean;
  shutdown: Promise<void> | undefined;
}

/** The two ways a host operation can end. */
export type OperationOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: ProtocolError };

export function operationSucceeded<T>(result: T): OperationOutcome<T> {
  return { ok: true, result };
}

export function operationFailed<T>(error: ProtocolError): OperationOutcome<T> {
  return { ok: false, error };
}

/**
 * The published view of one live run.
 *
 * An active snapshot is built on demand rather than cached, because the live
 * timeline changes far more often than anything reads it; the array handed out
 * is a copy, and the items themselves are frozen, so an older snapshot cannot
 * change under the reader.
 */
export function activeRunSnapshotOf(run: RunEntry): ActiveRunSnapshot {
  const live = Object.freeze([...run.live]);
  const base = {
    runId: run.runId,
    submissionId: run.submissionId,
    sessionId: run.sessionId,
    text: run.text,
    turnId: run.turnId,
    cancelRequested: run.cancelRequested,
    acceptedAt: run.acceptedAt,
    startedAt: run.startedAt,
    endedAt: null,
    executionKnowledge: null,
  };

  return run.stage === "accepted"
    ? Object.freeze({
        ...base,
        status: "accepted" as const,
        endReason: null,
        error: null,
        live,
        liveTruncated: run.liveTruncated,
      })
    : Object.freeze({
        ...base,
        status: "running" as const,
        endReason: null,
        error: null,
        live,
        liveTruncated: run.liveTruncated,
      });
}

export function runSnapshotOf(run: RunEntry): RunSnapshot {
  return run.terminal?.snapshot ?? activeRunSnapshotOf(run);
}

/**
 * One durable run record, as the wire DTO.
 *
 * Everything a client can ask about a run that outlived the process is here:
 * the timestamps the store kept, the terminal outcome it recorded, and — for a
 * run the previous host never finished — the evidence class that decided
 * whether it was blocked or merely left ready.
 */
export function runSnapshotOfRecord(record: RunRecord, error: ProtocolError | null): RunSnapshot {
  const base = {
    runId: record.runId,
    submissionId: record.submissionId,
    sessionId: record.sessionId,
    text: record.text,
    turnId: record.turnId,
    cancelRequested: record.cancelRequested,
    acceptedAt: record.acceptedAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  };

  switch (record.status) {
    case "accepted":
    case "running":
      return Object.freeze({
        ...base,
        endedAt: null,
        status: record.status,
        endReason: null,
        error: null,
        executionKnowledge: null,
        live: Object.freeze([]),
        liveTruncated: true,
      });
    case "completed":
      return Object.freeze({ ...base, status: "completed", endReason: "completed", error: null, executionKnowledge: null, live: null });
    case "limited":
      return Object.freeze({ ...base, status: "limited", endReason: "max_steps", error: null, executionKnowledge: null, live: null });
    case "cancelled":
      return Object.freeze({ ...base, status: "cancelled", endReason: "cancelled", error: null, executionKnowledge: null, live: null });
    case "interrupted":
      return Object.freeze({
        ...base,
        status: "interrupted",
        endReason: "interrupted",
        error: null,
        executionKnowledge: record.executionKnowledge ?? "unknown",
        live: null,
      });
    case "failed":
    default:
      return Object.freeze({
        ...base,
        status: "failed",
        endReason: record.endReason === "error" ? "error" : "host_error",
        error: error ?? unknownFailure(),
        executionKnowledge: null,
        live: null,
      });
  }
}

function unknownFailure(): ProtocolError {
  return Object.freeze({
    code: "INTERNAL_ERROR" as const,
    message: "the host failed while handling this request",
  });
}

/** A durable record as a list item: the same facts, with no timeline. */
export function runSummaryOfRecord(record: RunRecord, error: ProtocolError | null): RunSummary {
  const snapshot = runSnapshotOfRecord(record, error);
  if (snapshot.live === null) {
    const { live, ...rest } = snapshot;
    void live;
    return Object.freeze(rest);
  }
  const { live, liveTruncated, ...rest } = snapshot;
  void live;
  void liveTruncated;
  return Object.freeze(rest);
}

/** The directory view of a live run, for a session that points at one. */
export function liveRunSummaryOf(run: RunEntry): RunSummary {
  return Object.freeze({
    runId: run.runId,
    submissionId: run.submissionId,
    sessionId: run.sessionId,
    text: run.text,
    turnId: run.turnId,
    cancelRequested: run.cancelRequested,
    acceptedAt: run.acceptedAt,
    startedAt: run.startedAt,
    endedAt: null,
    status: run.stage,
    endReason: null,
    error: null,
    executionKnowledge: null,
  });
}

/** A session summary with a new pointer, keeping everything else as it is. */
export function withActiveRun(summary: SessionSummary, activeRunId: string | null): SessionSummary {
  return Object.freeze({ ...summary, activeRunId });
}

export function runEntryOf(state: HostState, runId: string): RunEntry {
  const entry = state.runs.get(runId);
  if (entry === undefined) throw new Error(`run "${runId}" is not live on this host`);
  return entry;
}

export function pluginSummaryOf(state: HostState, pluginId: string): PluginSummary {
  const summary = state.plugins.get(pluginId);
  if (summary === undefined) throw new Error(`plugin "${pluginId}" has no published summary`);
  return summary;
}

/**
 * Registers one accepted task so shutdown can wait for it.
 *
 * The task is registered before it can do anything observable, and the entry is
 * dropped when it settles. Rejections are observed here so a failing task can
 * never surface as an unhandled rejection; the task's own contract is to report
 * failures through host state, not through its promise.
 */
export function trackTask(state: HostState, task: Promise<unknown>): void {
  const settled = task.then(
    () => undefined,
    () => undefined,
  );
  state.pending.add(settled);
  void settled.then(() => {
    state.pending.delete(settled);
  });
}

/** A new opaque id for a session, run, stream or host instance. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// The published snapshot.
// ---------------------------------------------------------------------------

/** How many sessions and runs one snapshot window carries before it says `hasMore`. */
const SNAPSHOT_SESSION_ITEMS = 20;
const SNAPSHOT_RUN_ITEMS = 20;
/** How much accepted input the snapshot's run window may carry in total. */
const SNAPSHOT_RUN_TEXT_BYTES = 48 * 1024;

/**
 * One atomic cut of the published state.
 *
 * The cut is bounded in both collections — a first directory page and a recent
 * run window — and says so through `hasMore`, because a client has to be able
 * to tell "this is everything" from "this is what fits". Both are read from the
 * repository inside this synchronous step, so the snapshot is exactly what
 * storage held when it was taken.
 *
 * The run window is built here rather than by a page reader because it spans
 * sessions: it is the bounded view a subscriber gets for free, not a client's
 * paginated read of one session's runs. The live run, if there is one, is
 * always inside it — a session pointing at a run the client cannot see would be
 * a pointer to nothing.
 */
export function captureHostSnapshot(state: HostState, streamId: string): HostSnapshot {
  const sessions = readSessionPage(state.repository, undefined, SNAPSHOT_SESSION_ITEMS);
  if ("failure" in sessions) throw new Error("the session directory could not be read");

  const revisions = state.repository.revisions;
  const items: RunSummary[] = [];
  const seen = new Set<string>();

  const include = (record: RunRecord): void => {
    if (seen.has(record.runId)) return;
    seen.add(record.runId);
    items.push(runSummaryOfRecord(record, storedProtocolError(record.errorCode ?? "")));
  };

  for (const run of state.runs.values()) {
    // A settled run is the repository's to describe: its live entry still
    // carries the last stage it ran in and no end at all, while the session
    // has already cleared its active-run pointer — a pair no snapshot may
    // publish, and one that would shadow the durable terminal record here.
    if (run.terminal !== undefined) continue;
    include(liveRecordOf(run));
  }

  const recent = state.repository.listRecentRuns(SNAPSHOT_RUN_ITEMS, SNAPSHOT_RUN_TEXT_BYTES);
  for (const record of recent) include(record);
  const hasMoreRuns = recent.length >= SNAPSHOT_RUN_ITEMS || state.repository.listRecentRuns(SNAPSHOT_RUN_ITEMS + 1, SNAPSHOT_RUN_TEXT_BYTES).length > recent.length;

  const plugins = state.pluginOrder.map((pluginId) => pluginSummaryOf(state, pluginId));

  return Object.freeze({
    hostInstanceId: state.hostInstanceId,
    watermark: Object.freeze({ streamId, sequence: 0 }),
    storage: Object.freeze({
      storageId: state.repository.storageId,
      retention: state.repository.retention,
      schemaVersion: state.repository.schemaVersion,
    }),
    collections: revisions,
    sessions: sessions.page,
    runs: Object.freeze({
      items: Object.freeze(items),
      collectionRevision: revisions.runs,
      nextCursor: null,
      hasMore: hasMoreRuns,
    }),
    plugins: Object.freeze(plugins),
  });
}

/**
 * One durable record, narrowed to the terminal snapshot only a settled run has.
 *
 * A caller that has just committed a terminal knows the record's status, but
 * the type carries every status there is; this is the one place that gap is
 * closed, and it refuses rather than assuming.
 */
export function terminalSnapshotOfRecord(record: RunRecord, error: ProtocolError | null): TerminalRunSnapshot {
  const snapshot = runSnapshotOfRecord(record, error);
  if (snapshot.live === null) return snapshot;
  throw new Error("the durable record is not terminal");
}

/** The run window's view of a live run: its durable fields, without the timeline. */
function liveRecordOf(run: RunEntry): RunRecord {
  return Object.freeze({
    runId: run.runId,
    submissionId: run.submissionId,
    sessionId: run.sessionId,
    text: run.text,
    acceptedAt: run.acceptedAt,
    startedAt: run.startedAt,
    endedAt: null,
    hostInstanceId: "",
    status: run.stage,
    endReason: null,
    errorCode: null,
    executionKnowledge: null,
    turnId: run.turnId,
    cancelRequested: run.cancelRequested,
  });
}
