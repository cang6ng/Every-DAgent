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
import { MAX_REQUEST_ID_BYTES, MAX_TITLE_CHARS, PROTOCOL_VERSION, encodeFrame } from "@every-dagent/protocol";

import { storedProtocolError } from "./errors.js";
import { encodeCursor, readSessionPage, sessionSummaryOf } from "./history.js";
import type { Lease, RegistryGate } from "./registry-gate.js";
import { HOST_NAMESPACE, MODEL_NAMESPACE } from "./settings-profile.js";
import { refuseCorruptRun, servesRun } from "./run.js";
import { heaviestAcceptedText, type Repository, type RunRecord, type SessionRecord } from "./repository.js";
import type { ReverseOutcome, ReverseProfile, ReverseTimer } from "./reverse.js";

/**
 * Where the one open tool occurrence of a run currently sits — and whether it
 * was ever shown.
 *
 * `index === undefined` is the whole point: the occurrence is tracked from the
 * moment the Core reports it, so its result can be matched against it, while
 * the *presentation* is what the live bound may drop. Nothing about execution
 * or canonical pairing is allowed to depend on how much of the timeline a
 * reader was shown.
 */
export interface OpenToolSlot {
  readonly index: number | undefined;
  readonly invocationId: string;
  readonly itemId: string;
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
  /** The accepted input, while this host is the one executing it. */
  text: string;
  readonly controller: AbortController;
  /** Held from before the run record existed until the drain has settled. */
  readonly lease: Lease;
  readonly acceptedAt: number;
  startedAt: number | null;
  turnId: string | null;
  /** Whether this host has asked the execution to stop. Display state, not proof. */
  cancelRequested: boolean;
  /**
   * Whether storage confirmed the cancel intent.
   *
   * Kept apart from `cancelRequested` because they are different facts: the
   * first is what this host asked for, the second is what the store recorded.
   * Only the second may ever be reported as a durable success.
   */
  cancelDurable: boolean;
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

/** One plugin's two configuration revisions: what is asked for, and what runs. */
export interface PluginConfigRevisions {
  desired: number;
  effective: number | null;
}

/**
 * The configuration this host instance is running from.
 *
 * `effective` holds what this instance actually consumed — one entry per
 * managed namespace, with the revision it was read at. It is a fact about a
 * running host and is never written to storage, never inherited from a previous
 * instance, and never updated during this instance's life: a settings update
 * changes the *desired* value the store holds, and only a restart can make a
 * new revision effective.
 */
export interface HostConfiguration {
  readonly effective: ReadonlyMap<string, import("./configuration.js").EffectiveNamespace>;
  /** The effective host settings the runtime was built with. */
  readonly host: import("./settings.js").HostSettings;
  /** The desired revisions the effective execution was composed from. */
  readonly revisions: import("./composition.js").SettingsRevisions;
}

/**
 * What the settings surface judges a *new* value with.
 *
 * The composition's own model validation and every registered plugin's contract
 * are facts this instance holds, so a settings write is judged by the same
 * authority the startup used — never by a second reading that could disagree.
 */
export interface SettingsAuthority {
  readonly validateModel: (value: import("@every-dagent/protocol").JsonValue) => { readonly ok: boolean };
  readonly pluginContracts: ReadonlyMap<string, PluginContract>;
}

/** One registered plugin's configuration contract, as the settings surface uses it. */
export interface PluginContract {
  readonly schemaVersion: number;
  readonly validate: (value: import("@every-dagent/plugin-system").PluginConfigValue) => boolean;
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
  /** What this instance is running from; see the note on `HostConfiguration`. */
  readonly configuration: HostConfiguration;
  /** The composition's own release path, held from the moment it handed execution over. */
  readonly disposeComposition: (() => void | Promise<void>) | undefined;
  /** How a settings write is judged; see the note on `SettingsAuthority`. */
  readonly settingsAuthority: SettingsAuthority;
  /** The published plugin summaries, by id, in registration order. */
  readonly plugins: Map<string, PluginSummary>;
  readonly pluginOrder: string[];
  /**
   * The desired-enabled intent of each registered plugin, as storage holds it.
   *
   * It is a projection, not an authority: an `enable` writes the intent first
   * and only then updates this map, so what a summary reports here is always a
   * durable fact rather than an intention this host has not committed.
   */
  readonly pluginIntents: Map<string, boolean>;
  /**
   * Per plugin: the desired configuration revision and the one this instance
   * actually bound. A plugin with no configuration contract has no entry, which
   * is what `null` on the wire means.
   */
  readonly pluginConfigRevisions: Map<string, PluginConfigRevisions>;

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

/**
 * Releases one run that has reached a durable terminal.
 *
 * A settled run is the repository's fact, not this host's memory. Its entry
 * leaves the live map — the map holds what is executing, so a long-lived host
 * does not grow one entry per run it ever ran — and the things it was carrying
 * (the accepted input, the published timeline, the loaded history window) are
 * dropped with it. Every later query is answered by the durable record, which
 * is the authority for a terminal run; a client asking for the run id gets the
 * same facts it would have gotten from the entry, and after the session is
 * deleted it gets the deleted-session answer instead of a stale copy.
 */
export function retireRun(state: HostState, run: RunEntry): void {
  state.runs.delete(run.runId);
  run.text = "";
  run.live = [];
  run.liveBytes = 0;
  run.window = undefined;
  run.posTool = undefined;
  run.textItemIndex = undefined;
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

/** The shape of every identity this host or the Core mints: a UUID's 36 bytes. */
const MINTED_ID = "00000000-0000-4000-8000-000000000000";

/**
 * The request identity a snapshot is measured with when no request exists yet.
 *
 * Startup and admission judge a frame that has not been asked for, and the
 * request id it will carry is not known yet — so the check reserves the most
 * expensive legal one there is. Every legal id is at most
 * `MAX_REQUEST_ID_BYTES` raw UTF-8 bytes, and the worst JSON string token such
 * an id can produce is a full identity's worth of NUL, each escaped to six
 * characters: `2 + 6 * MAX_REQUEST_ID_BYTES` bytes. Reserving that means a
 * state these checks accept is a state *every* legal request id can be served
 * in — a client with a long or escaping-heavy id cannot be refused by a
 * frame that the same state would have accepted for a UUID.
 *
 * It is a measurement input, never a wire value: a real subscriber's id is
 * echoed verbatim, and the capture measures the frame it will really send.
 */
export const PREPARED_REQUEST_ID = "\u0000".repeat(MAX_REQUEST_ID_BYTES);

/**
 * One atomic cut of the published state.
 *
 * The cut is bounded in both collections — a first directory page and a recent
 * run window — and says so through `hasMore`, because a client has to be able
 * to tell "this is everything" from "this is what fits". Both are read from the
 * repository inside this synchronous step, so the snapshot is exactly what
 * storage held when it was taken.
 *
 * The whole composition is then held to the frame it has to travel in — the
 * protocol's own encoder, on the response this very request will be answered
 * with — and a snapshot that would not encode is reduced: run window first,
 * then the directory, with `hasMore` telling the truth about what was left out.
 * There is no second budget beside that one: what is measured is the frame the
 * client would receive, so a state this accepts is a state that can be sent.
 * What it never does is publish a cut that claims completeness it does not
 * have, or fail a subscriber whose state could have been shown in a smaller
 * window.
 *
 * The run window is built here rather than by a page reader because it spans
 * sessions: it is the bounded view a subscriber gets for free, not a client's
 * paginated read of one session's runs. The live run, if there is one, is
 * always inside it — a session pointing at a run the client cannot see would be
 * a pointer to nothing.
 *
 * Every durable terminal it carries first passes the same validation every other
 * read of a settled run passes. A record that fails is not projected: the
 * session it belongs to is blocked — durably, and announced — and the record is
 * left out of the cut with `hasMore` saying so, because one corrupted
 * conversation must not cost a client every other session it could still read.
 */
export function captureHostSnapshot(
  state: HostState,
  streamId: string,
  requestId: string = PREPARED_REQUEST_ID,
): HostSnapshot {
  // The durable window is validated first: a session this cut has to stop is
  // blocked before anything else is read, so the revisions and the summaries
  // composed below are the ones that block produced.
  const recent = state.repository.listRecentRuns(SNAPSHOT_RUN_ITEMS, SNAPSHOT_RUN_TEXT_BYTES);
  const usable: RunRecord[] = [];
  let dropped = 0;
  for (const record of recent.records) {
    if (!servesRun(state, record)) {
      refuseCorruptRun(state, record);
      dropped += 1;
      continue;
    }
    usable.push(record);
  }

  const revisions = state.repository.revisions;
  const items: RunSummary[] = [];
  const seen = new Set<string>();

  const include = (record: RunRecord): void => {
    if (seen.has(record.runId)) return;
    seen.add(record.runId);
    items.push(runSummaryOfRecord(record, storedProtocolError(record.errorCode ?? "")));
  };

  for (const run of state.runs.values()) {
    // A settled run is the repository's to describe: its live entry is released
    // the moment the terminal is durable, so anything still here is executing.
    if (run.terminal !== undefined) continue;
    include(liveRecordOf(run));
  }
  for (const record of usable) include(record);

  const directory = readSessionPage(state.repository, undefined, SNAPSHOT_SESSION_ITEMS);
  if ("failure" in directory) throw new Error("the session directory could not be read");

  let sessions = directory.page;
  let runs = items;
  let hasMoreRuns = recent.hasMore || dropped > 0;

  // An executing run and the session that points at it travel as a pair. The
  // directory window is the newest page, so a session can fall off it while its
  // run keeps executing — and a cut carrying that run without its session is
  // unexpressible: the schema refuses the pointer, and the client could place
  // neither the run's live content nor the session it belongs to. The owning
  // session is therefore pinned into the window, exactly like the run is; one
  // host executes one run at a time, so this adds at most one entry, and the
  // window says `hasMore` rather than pretending to be the whole directory.
  const pinned: SessionSummary[] = [];
  for (const run of state.runs.values()) {
    if (run.terminal !== undefined) continue;
    if (sessions.items.some((session) => session.sessionId === run.sessionId)) continue;
    const record = state.repository.getSession(run.sessionId);
    if (record !== undefined) pinned.push(sessionSummaryOf(record));
  }
  if (pinned.length > 0) {
    sessions = Object.freeze({
      items: Object.freeze([...pinned, ...sessions.items]),
      collectionRevision: sessions.collectionRevision,
      nextCursor: sessions.nextCursor,
      hasMore: true,
    });
  }

  const compose = (): HostSnapshot =>
    Object.freeze({
      hostInstanceId: state.hostInstanceId,
      watermark: Object.freeze({ streamId, sequence: 0 }),
      storage: Object.freeze({
        storageId: state.repository.storageId,
        retention: state.repository.retention,
        schemaVersion: state.repository.schemaVersion,
      }),
      collections: revisions,
      sessions,
      runs: Object.freeze({
        items: Object.freeze(runs),
        collectionRevision: revisions.runs,
        nextCursor: null,
        hasMore: hasMoreRuns,
      }),
      plugins: Object.freeze(state.pluginOrder.map((pluginId) => pluginSummaryOf(state, pluginId))),
      settings: settingsSummariesOf(state),
    });

  let snapshot = compose();
  // Shrink honestly, and only in the ways the snapshot can account for: a
  // terminal run leaves the window first, then a session that points at no
  // run. The executing run and the session pointing at it are never dropped —
  // they are the pair the cut exists for. The bound is the encoded frame the
  // caller will be sent, decided by the protocol's own encoder: there is one
  // frame authority in this host, and this is a call into it.
  while (!snapshotFrameFits(state, snapshot, requestId)) {
    const droppable = lastIndexWhere(runs, (run) => run.status !== "accepted" && run.status !== "running");
    if (droppable >= 0) {
      runs = [...runs.slice(0, droppable), ...runs.slice(droppable + 1)];
      hasMoreRuns = true;
      snapshot = compose();
      continue;
    }
    const lastSession = lastIndexWhere(sessions.items, (session) => session.activeRunId === null);
    if (lastSession >= 0) {
      const kept = sessions.items.filter((_, index) => index !== lastSession);
      const last = kept[kept.length - 1];
      sessions = Object.freeze({
        items: Object.freeze(kept),
        collectionRevision: sessions.collectionRevision,
        nextCursor:
          last === undefined
            ? null
            : encodeCursor({
                v: 1,
                kind: "sessions",
                storageId: state.repository.storageId,
                collectionRevision: revisions.sessions,
                updatedAt: last.updatedAt,
                sessionId: last.sessionId,
              }),
        hasMore: true,
      });
      snapshot = compose();
      continue;
    }
    // Nothing left that may honestly be dropped, and it still does not fit.
    // Publishing a cut that cannot travel would be a lie about the state; the
    // caller answers with its own failure instead.
    throw new Error("the snapshot cannot be published inside one frame");
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// What a cut can never shrink away.
// ---------------------------------------------------------------------------

/**
 * The unshrinkable core of one published cut.
 *
 * A snapshot may honestly reduce itself — terminal runs and sessions that point
 * at no run are windows — but two things it can never drop: the session that
 * owns the executing run, and that run. The static catalogue travels with every
 * cut as well. Those three, composed from the same DTO builders the real cut
 * uses, are exactly the frame a client would be sent; that is what makes this
 * the right thing for a check made before the state exists.
 */
export function snapshotCoreOf(
  state: HostState,
  streamId: string,
  session: SessionSummary,
  run: RunSummary,
): HostSnapshot {
  const revisions = state.repository.revisions;
  return Object.freeze({
    hostInstanceId: state.hostInstanceId,
    watermark: Object.freeze({ streamId, sequence: 0 }),
    storage: Object.freeze({
      storageId: state.repository.storageId,
      retention: state.repository.retention,
      schemaVersion: state.repository.schemaVersion,
    }),
    collections: revisions,
    sessions: Object.freeze({
      items: Object.freeze([session]),
      collectionRevision: revisions.sessions,
      nextCursor: null,
      hasMore: false,
    }),
    runs: Object.freeze({
      items: Object.freeze([run]),
      collectionRevision: revisions.runs,
      nextCursor: null,
      hasMore: false,
    }),
    plugins: Object.freeze(state.pluginOrder.map((pluginId) => pluginSummaryOf(state, pluginId))),
    settings: settingsSummariesOf(state),
  });
}

/**
 * The fixed, bounded summary of the host's own two namespaces.
 *
 * Two entries, always, in one order: a snapshot says which revisions are in
 * force and whether a restart is owed, and never carries a value. The durable
 * revisions are read here — inside the cut's own synchronous step, like every
 * other window — and the effective ones come from what this instance consumed.
 */
export function settingsSummariesOf(state: HostState): readonly import("@every-dagent/protocol").SettingsSummary[] {
  const summaries: import("@every-dagent/protocol").SettingsSummary[] = [];
  for (const namespace of [HOST_NAMESPACE, MODEL_NAMESPACE]) {
    const record = state.repository.getSettingsNamespace(namespace);
    if (record === undefined) throw new Error("a managed settings namespace is missing");
    const effective = state.configuration.effective.get(namespace);
    summaries.push(
      Object.freeze({
        namespace,
        desiredRevision: record.revision,
        effectiveRevision: effective?.revision ?? null,
        restartRequired: effective === undefined || effective.revision !== record.revision,
      }),
    );
  }
  return Object.freeze(summaries);
}

/**
 * The heaviest run summary one legal execution can produce.
 *
 * The accepted input is the store's own record bound, escaped the way the frame
 * will escape it, and every identity is the size the host mints them at; the
 * status is the one a run reaches while it can still be executing, which is the
 * heaviest terminal-less shape a cut has to carry.
 */
function heaviestRunSummary(state: HostState, sessionId: string, runId: string): RunSummary {
  return runSummaryOfRecord(
    Object.freeze({
      runId,
      submissionId: MINTED_ID,
      sessionId,
      text: heaviestAcceptedText(state.limits.maxRecordBytes),
      acceptedAt: 0,
      startedAt: 0,
      endedAt: null,
      hostInstanceId: state.hostInstanceId,
      status: "running" as const,
      endReason: null,
      errorCode: null,
      executionKnowledge: null,
      turnId: MINTED_ID,
      cancelRequested: false,
    }),
    null,
  );
}

/**
 * The heaviest cut a legal state can force.
 *
 * Used where a state does not exist yet: at startup, to refuse a configuration
 * that leaves no room for any run at all, and before an admission, to refuse an
 * input whose accepted run could never be published inside one frame.
 */
export function snapshotOfHeaviestState(state: HostState, streamId: string): HostSnapshot {
  const sessionId = MINTED_ID;
  const runId = MINTED_ID;
  const session = sessionSummaryOf({
    sessionId,
    generation: 1,
    // A title is bounded in code units, so the heaviest one is made of units
    // that escape the most: an unpaired surrogate costs six bytes in JSON.
    title: "\ud800".repeat(MAX_TITLE_CHARS),
    createdAt: 0,
    updatedAt: 0,
    metadataRevision: 0,
    historyRevision: 0,
    committedSeq: 0,
    status: "ready",
    blockedReason: null,
    activeRunId: runId,
  });
  return snapshotCoreOf(state, streamId, session, heaviestRunSummary(state, sessionId, runId));
}

/**
 * The heaviest cut one specific admission would force.
 *
 * Same composition as the general case, but with the input and the submission
 * identity the caller actually offered, and the session summary exactly as the
 * admission transaction will leave it — so the frame checked is the frame the
 * accepted run would have to travel in.
 */
export function snapshotOfProspectiveRun(
  state: HostState,
  streamId: string,
  session: SessionRecord,
  offer: { readonly runId: string; readonly submissionId: string; readonly text: string; readonly acceptedAt: number },
): HostSnapshot {
  const summary = sessionSummaryOf({
    ...session,
    activeRunId: offer.runId,
    metadataRevision: session.metadataRevision + 1,
    updatedAt: offer.acceptedAt,
  });
  const run = runSummaryOfRecord(
    Object.freeze({
      runId: offer.runId,
      submissionId: offer.submissionId,
      sessionId: session.sessionId,
      text: offer.text,
      acceptedAt: offer.acceptedAt,
      // The clock order a running run must show: acceptance first, a start at
      // or after it, and no end.
      startedAt: offer.acceptedAt,
      endedAt: null,
      hostInstanceId: state.hostInstanceId,
      status: "running" as const,
      endReason: null,
      errorCode: null,
      executionKnowledge: null,
      turnId: MINTED_ID,
      cancelRequested: false,
    }),
    null,
  );
  return snapshotCoreOf(state, streamId, summary, run);
}

/**
 * Whether one composed cut fits the frame it has to travel in.
 *
 * The protocol's own encoder decides it, on the frame a subscriber would really
 * be sent — with the request id that frame will carry, when there is one. That
 * is the same question the response path asks at send time, asked while the
 * answer can still change something: a check made before a state exists and the
 * response a client later receives are never two different questions.
 *
 * With no request yet, the default is `PREPARED_REQUEST_ID` — the worst legal
 * request id's full encoded cost — so what this accepts, every legal request id
 * can be served in. Actual captures pass the real id and measure the real
 * frame; the reservation never replaces that check, it only precedes it.
 */
export function snapshotFrameFits(
  state: HostState,
  snapshot: HostSnapshot,
  requestId: string = PREPARED_REQUEST_ID,
): boolean {
  return encodeFrame(
    { kind: "host-response", method: "subscriptions.open" },
    {
      kind: "host-response",
      protocolVersion: PROTOCOL_VERSION,
      hostInstanceId: state.hostInstanceId,
      requestId,
      result: { snapshot },
    },
  ).success;
}

/** The last position a predicate accepts, or -1. */
function lastIndexWhere<T>(items: readonly T[], accept: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item !== undefined && accept(item)) return index;
  }
  return -1;
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
