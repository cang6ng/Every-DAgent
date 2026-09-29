/**
 * The host's own data model: the directories it owns, the entries it mutates
 * while a run is live, and the published DTOs those entries project into.
 *
 * Two separations are the whole point of this module.
 *
 * The first is internal fact versus published state. The Core `Session`, the
 * `AbortController`, the registry lease and the drain promise are host facts
 * and never travel; `published` is what a client may see, and it is replaced,
 * never edited, so every reader sees a complete snapshot or the previous one.
 *
 * The second is publication versus delivery. Everything here is synchronous and
 * local: no `await`, no channel call, no plugin call, no user callback. A state
 * commit is finished before any of those could run, which is what makes the
 * terminal correction atomic from a reader's point of view.
 */

import type { AgentRuntime, Session, ToolRegistry, TurnEndReason } from "@every-dagent/agent-core";
import type { PluginManager } from "@every-dagent/plugin-system";
import type {
  ActiveRunSnapshot,
  CanonicalItem,
  ClientCapabilities,
  HostSnapshot,
  LiveItem,
  PluginSummary,
  ProtocolChannel,
  ProtocolError,
  RunSnapshot,
  SessionSnapshot,
  SessionSummary,
  TerminalRunSnapshot,
} from "@every-dagent/protocol";

import type { Lease, RegistryGate } from "./registry-gate.js";

/** A session: the Core object plus everything the protocol may show about it. */
export interface SessionEntry {
  readonly session: Session;
  readonly createdAt: number;
  /** The current published snapshot. Replaced whole, never mutated. */
  published: SessionSnapshot;
  /** How many log events `published.canonical` already represents. */
  publishedSeq: number;
}

/** Where the one open tool occurrence of a run currently sits in `live`. */
export interface OpenToolSlot {
  readonly index: number;
  readonly invocationId: string;
  readonly callId: string;
  readonly name: string;
}

export interface RunEntry {
  readonly runId: string;
  readonly submissionId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly controller: AbortController;
  /** Held from before the run record existed until the drain has settled. */
  readonly lease: Lease;
  turnId: string | null;
  cancelRequested: boolean;
  stage: "accepted" | "running";
  live: LiveItem[];
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
  terminal: TerminalRunSnapshot | undefined;
}

export interface SubscriptionState {
  readonly streamId: string;
  sequence: number;
}

export interface ConnectionState {
  readonly channel: ProtocolChannel;
  /** Every request id this connection has used, in either direction it sent. */
  readonly requestIds: Set<string>;
  /** Set by the first successful `host.describe`; bound for the connection's life. */
  initialized: {
    readonly name: string;
    readonly version: string;
    readonly capabilities: ClientCapabilities;
  } | undefined;
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
  /** The published plugin summaries, by id, in registration order. */
  readonly plugins: Map<string, PluginSummary>;
  readonly pluginOrder: string[];
  readonly sessions: Map<string, SessionEntry>;
  readonly sessionOrder: string[];
  readonly runs: Map<string, RunEntry>;
  readonly runOrder: string[];
  readonly submissions: Map<string, string>;
  readonly connections: Set<ConnectionState>;
  /** Every accepted task, so shutdown can wait for it to settle. */
  readonly pending: Set<Promise<void>>;
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
 * The published view of one run: the terminal snapshot once there is one,
 * otherwise the current active snapshot.
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
  };

  return run.stage === "accepted"
    ? Object.freeze({ ...base, status: "accepted" as const, endReason: null, error: null, live })
    : Object.freeze({ ...base, status: "running" as const, endReason: null, error: null, live });
}

export function runSnapshotOf(run: RunEntry): RunSnapshot {
  return run.terminal ?? activeRunSnapshotOf(run);
}

/** The directory view of a session: everything but the conversation. */
export function sessionSummaryOf(snapshot: SessionSnapshot): SessionSummary {
  return Object.freeze({
    sessionId: snapshot.sessionId,
    createdAt: snapshot.createdAt,
    status: snapshot.status,
    activeRunId: snapshot.activeRunId,
  });
}

/** A session snapshot with a new pointer, keeping the published items as they are. */
export function withActiveRun(snapshot: SessionSnapshot, activeRunId: string | null): SessionSnapshot {
  return Object.freeze({ ...snapshot, activeRunId });
}

export function withCanonical(
  snapshot: SessionSnapshot,
  canonical: readonly CanonicalItem[],
): SessionSnapshot {
  return Object.freeze({ ...snapshot, canonical: Object.freeze([...canonical]), activeRunId: null });
}

/**
 * One atomic cut of the published state.
 *
 * Everything in it is already-frozen published data, so the cut is exactly what
 * the catalogues held when it was taken: nothing that happens afterwards can
 * reach into it, and nothing that happened before is half-applied, because
 * every commit in this module is synchronous.
 */
export function captureHostSnapshot(state: HostState, streamId: string): HostSnapshot {
  const sessions = state.sessionOrder.map((sessionId) => sessionEntryOf(state, sessionId).published);
  const runs = state.runOrder.map((runId) => runSnapshotOf(runEntryOf(state, runId)));
  const plugins = state.pluginOrder.map((pluginId) => pluginSummaryOf(state, pluginId));

  return Object.freeze({
    hostInstanceId: state.hostInstanceId,
    watermark: Object.freeze({ streamId, sequence: 0 }),
    sessions: Object.freeze(sessions),
    runs: Object.freeze(runs),
    plugins: Object.freeze(plugins),
  });
}

export function sessionEntryOf(state: HostState, sessionId: string): SessionEntry {
  const entry = state.sessions.get(sessionId);
  if (entry === undefined) throw new Error(`session "${sessionId}" is not in the directory`);
  return entry;
}

export function runEntryOf(state: HostState, runId: string): RunEntry {
  const entry = state.runs.get(runId);
  if (entry === undefined) throw new Error(`run "${runId}" is not in the directory`);
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
