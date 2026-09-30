/**
 * The fold: what one validated event means for the presentation replica.
 *
 * This module is pure. It reads the previous snapshot and one event, and returns
 * either the next snapshot or a reason the event cannot follow from the state
 * the client holds. It never sends anything, never consults the connection, and
 * never repairs a gap by guessing: an event that does not fit its own history is
 * a peer error, not something to paper over.
 *
 * A single event's schema cannot describe history, so the checks here are about
 * *continuity*: which session a run belongs to, which stage it has reached, and
 * which identities it has already published. A frame that is individually valid
 * and still cannot follow from what was published before it is refused.
 *
 * Immutability is by construction: every node this module creates is frozen,
 * every node it reuses is already frozen, and the arrays it touches are copied
 * rather than edited — so an old snapshot can never change under a reader, and
 * an unchanged branch is shared instead of rebuilt.
 */

import type {
  ActiveRunSnapshot,
  DisplayInput,
  EventScope,
  HostEvent,
  HostSnapshot,
  LiveItem,
  PluginSummary,
  RunSnapshot,
  RunStatus,
  SessionSnapshot,
  TerminalRunSnapshot,
  Watermark,
} from "@every-dagent/protocol";

import type { ProtocolViolationReason } from "./errors.js";

export type FoldOutcome =
  | { readonly ok: true; readonly presentation: HostSnapshot }
  | { readonly ok: false; readonly reason: ProtocolViolationReason };

/** Freezes a value and everything reachable from it. Already-frozen parts are skipped. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Object.isFrozen(value)) return value;
  for (const field of Object.values(value)) deepFreeze(field);
  return Object.freeze(value);
}

function indexOfId<T>(items: readonly T[], id: string, idOf: (item: T) => string): number {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item !== undefined && idOf(item) === id) return index;
  }
  return -1;
}

function replaceAt<T>(items: readonly T[], index: number, item: T): readonly T[] {
  const next = [...items];
  next[index] = item;
  return Object.freeze(next);
}

function sameRunIdentity(left: RunSnapshot, right: RunSnapshot): boolean {
  return (
    left.runId === right.runId &&
    left.sessionId === right.sessionId &&
    left.submissionId === right.submissionId &&
    left.text === right.text
  );
}

/** A turn id, once bound, is the run's for good — it never changes and never clears. */
function turnIdFits(bound: string | null, incoming: string | null): boolean {
  return bound === null || bound === incoming;
}

function activeRunOf(runs: readonly RunSnapshot[], sessionId: string, exceptRunId: string): RunSnapshot | undefined {
  return runs.find(
    (run) => run.sessionId === sessionId && run.runId !== exceptRunId && run.live !== null,
  );
}

/**
 * The one rule about a run's stages, for every snapshot this module publishes.
 *
 * The spec's state machine is `accepted → running → { completed | limited |
 * cancelled | failed }`, plus `accepted → failed` for a host fault that lands
 * before the Core ever started. What breaks it is not something a later
 * snapshot may assert: a run that ended without the running publication the
 * client has to have seen to explain content, a move out of a terminal stage
 * that would rewrite history the client already presented, or an `accepted` a
 * running run never returns to — once running is published, the acceptance is
 * over for good.
 *
 * The end reason is the host's own account of *why* a failure happened, not a
 * stage the client tracks, so it is not part of this rule.
 */
function runStageAllows(from: RunStatus, to: RunStatus): boolean {
  switch (from) {
    case "accepted":
      return to === "accepted" || to === "running" || to === "failed";
    case "running":
      return to !== "accepted";
    default:
      return false;
  }
}

function withWatermark(base: Omit<HostSnapshot, "watermark">, watermark: Watermark): HostSnapshot {
  return Object.freeze({ ...base, watermark: Object.freeze({ streamId: watermark.streamId, sequence: watermark.sequence }) });
}

/** Structural equality for the JSON the protocol carries, used on display inputs and results. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJson(value, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

function sameDisplayInput(left: DisplayInput, right: DisplayInput): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "json" && right.kind === "json") return sameJson(left.value, right.value);
  return true;
}

/**
 * One live item's published identity, compared across a full replacement.
 *
 * A run.updated carries the whole timeline, so a rewrite of something already
 * shown would silently change history the client has already presented. Text
 * may grow; the identity of an occurrence may not.
 */
function sameLiveIdentity(left: LiveItem, right: LiveItem): boolean {
  if (left.kind !== right.kind || left.itemId !== right.itemId) return false;
  if (left.kind !== "tool" || right.kind !== "tool") return true;
  if (
    left.invocationId !== right.invocationId ||
    left.callId !== right.callId ||
    left.name !== right.name ||
    !sameDisplayInput(left.input, right.input)
  ) {
    return false;
  }
  if (left.result === null) return true;
  return right.result !== null && left.result.ok === right.result.ok && left.result.content === right.result.content;
}

/** The published timeline may only be extended, never rewritten or reordered. */
function liveContinues(previous: readonly LiveItem[], next: readonly LiveItem[]): boolean {
  if (next.length < previous.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const before = previous[index];
    const after = next[index];
    if (before === undefined || after === undefined) return false;
    if (!sameLiveIdentity(before, after)) return false;
  }
  const seen = new Set(next.map((item) => item.itemId));
  return seen.size === next.length;
}

/**
 * Applies one event.
 *
 * `watermark` is the stream position this event occupies; it is written into the
 * result even when the event changed nothing else, because the position itself
 * is state — that is what makes a duplicate detectable later.
 */
export function foldEvent(
  previous: HostSnapshot,
  event: HostEvent,
  watermark: Watermark,
): FoldOutcome {
  // The event is a validated, isolated snapshot: freezing it here means every
  // node the fold inserts is immutable from the moment it is published.
  deepFreeze(event);

  switch (event.type) {
    case "session.created":
      return foldSessionCreated(previous, event.payload.session, watermark);
    case "run.updated":
      return foldRunUpdated(previous, event.payload.run, watermark);
    case "run.output.delta":
      return foldOutputDelta(previous, event.scope, event.payload.itemId, event.payload.text, watermark);
    case "run.tool.call":
      return foldToolCall(previous, event.scope, event.payload.item, watermark);
    case "run.tool.result":
      return foldToolResult(previous, event.scope, event.payload, watermark);
    case "run.ended":
      return foldRunEnded(previous, event.scope, event.payload.run, event.payload.session, watermark);
    case "plugin.updated":
      return foldPluginUpdated(previous, event.payload.plugin, watermark);
    case "host.request.cancelled":
      // Control traffic, not conversation: the dispatcher aborts the handler,
      // and all this leaves behind is the stream position it consumed.
      return {
        ok: true,
        presentation: withWatermark(
          {
            hostInstanceId: previous.hostInstanceId,
            sessions: previous.sessions,
            runs: previous.runs,
            plugins: previous.plugins,
          },
          watermark,
        ),
      };
  }
}

function foldSessionCreated(
  previous: HostSnapshot,
  session: SessionSnapshot,
  watermark: Watermark,
): FoldOutcome {
  if (indexOfId(previous.sessions, session.sessionId, (item) => item.sessionId) >= 0) {
    return { ok: false, reason: "invalid-event" };
  }

  return {
    ok: true,
    presentation: withWatermark(
      {
        hostInstanceId: previous.hostInstanceId,
        sessions: Object.freeze([...previous.sessions, session]),
        runs: previous.runs,
        plugins: previous.plugins,
      },
      watermark,
    ),
  };
}

function foldRunUpdated(
  previous: HostSnapshot,
  run: ActiveRunSnapshot,
  watermark: Watermark,
): FoldOutcome {
  const sessionIndex = indexOfId(previous.sessions, run.sessionId, (item) => item.sessionId);
  if (sessionIndex < 0) return { ok: false, reason: "invalid-event" };
  const session = previous.sessions[sessionIndex];
  if (session === undefined) return { ok: false, reason: "invalid-event" };

  if (session.activeRunId !== null && session.activeRunId !== run.runId) {
    // One session, one active run: a second one cannot be true at the same time.
    return { ok: false, reason: "invalid-event" };
  }
  if (activeRunOf(previous.runs, run.sessionId, run.runId) !== undefined) {
    return { ok: false, reason: "invalid-event" };
  }

  const runIndex = indexOfId(previous.runs, run.runId, (item) => item.runId);
  let runs: readonly RunSnapshot[];
  if (runIndex < 0) {
    // A run this client has never seen can only be announced as accepted: the
    // `accepted → running` order is part of the contract, and a snapshot that
    // already holds a running run is the one exception (it is not an event).
    if (run.status !== "accepted") return { ok: false, reason: "invalid-event" };
    runs = Object.freeze([...previous.runs, run]);
  } else {
    const existing = previous.runs[runIndex];
    if (existing === undefined) return { ok: false, reason: "invalid-event" };
    // A run's stage only moves forward, and only a run that still has a
    // timeline has one to extend; its identity is fixed for its life.
    if (existing.live === null || !runStageAllows(existing.status, run.status)) {
      return { ok: false, reason: "invalid-event" };
    }
    if (!sameRunIdentity(existing, run) || !turnIdFits(existing.turnId, run.turnId)) {
      return { ok: false, reason: "run-identity" };
    }
    if (!liveContinues(existing.live, run.live)) return { ok: false, reason: "run-identity" };
    runs = replaceAt(previous.runs, runIndex, run);
  }

  // The active-run pointer moves in the same update as the run it points at:
  // a reader never sees the run without the session that owns it.
  const sessions = replaceAt(
    previous.sessions,
    sessionIndex,
    Object.freeze({ ...session, activeRunId: run.runId }),
  );

  return {
    ok: true,
    presentation: withWatermark(
      { hostInstanceId: previous.hostInstanceId, sessions, runs, plugins: previous.plugins },
      watermark,
    ),
  };
}

/**
 * The run a content event belongs to.
 *
 * The event's own scope says which session it claims to come from, and that
 * claim has to match the run this client actually published — a run belongs to
 * one session for its whole life, and a frame that says otherwise is not a
 * content update for anything.
 */
function contentRunAt(
  previous: HostSnapshot,
  scope: Extract<EventScope, { kind: "run" }>,
): { readonly index: number; readonly run: Extract<RunSnapshot, { live: readonly LiveItem[] }> } | undefined {
  const index = indexOfId(previous.runs, scope.runId, (item) => item.runId);
  if (index < 0) return undefined;
  const run = previous.runs[index];
  if (run === undefined || run.live === null) return undefined;
  if (run.sessionId !== scope.sessionId) return undefined;
  // Content follows the run's running publication, never its acceptance.
  if (run.status !== "running") return undefined;
  return { index, run };
}

function foldOutputDelta(
  previous: HostSnapshot,
  scope: Extract<EventScope, { kind: "run" }>,
  itemId: string,
  text: string,
  watermark: Watermark,
): FoldOutcome {
  const live = contentRunAt(previous, scope);
  if (live === undefined) return { ok: false, reason: "invalid-event" };

  const itemIndex = indexOfId(live.run.live, itemId, (item) => item.itemId);
  let items: readonly LiveItem[];
  if (itemIndex < 0) {
    // The first chunk of a new text item; the host decides where one ends.
    items = Object.freeze([
      ...live.run.live,
      Object.freeze({ kind: "text" as const, itemId, text }),
    ]);
  } else {
    const item = live.run.live[itemIndex];
    if (item === undefined || item.kind !== "text") return { ok: false, reason: "invalid-event" };
    items = replaceAt(live.run.live, itemIndex, Object.freeze({ kind: "text" as const, itemId, text: item.text + text }));
  }

  return replacedRun(previous, live.index, { ...live.run, live: items }, watermark);
}

function foldToolCall(
  previous: HostSnapshot,
  scope: Extract<EventScope, { kind: "run" }>,
  item: Extract<LiveItem, { kind: "tool" }>,
  watermark: Watermark,
): FoldOutcome {
  const live = contentRunAt(previous, scope);
  if (live === undefined) return { ok: false, reason: "invalid-event" };

  // Item ids and invocation ids identify one occurrence each: a repeated
  // `callId` is not a repeat, but a repeated id is a contradiction.
  if (indexOfId(live.run.live, item.itemId, (candidate) => candidate.itemId) >= 0) {
    return { ok: false, reason: "invalid-event" };
  }
  if (
    live.run.live.some((candidate) => candidate.kind === "tool" && candidate.invocationId === item.invocationId)
  ) {
    return { ok: false, reason: "invalid-event" };
  }

  const items = Object.freeze([...live.run.live, item]);
  return replacedRun(previous, live.index, { ...live.run, live: items }, watermark);
}

function foldToolResult(
  previous: HostSnapshot,
  scope: Extract<EventScope, { kind: "run" }>,
  payload: { readonly invocationId: string; readonly ok: boolean; readonly content: string },
  watermark: Watermark,
): FoldOutcome {
  const live = contentRunAt(previous, scope);
  if (live === undefined) return { ok: false, reason: "invalid-event" };

  const itemIndex = live.run.live.findIndex(
    (candidate) =>
      candidate.kind === "tool" &&
      candidate.invocationId === payload.invocationId &&
      candidate.result === null,
  );
  if (itemIndex < 0) {
    // A result fills the open occurrence it belongs to, and nothing else: an
    // unknown one would have to be invented, and a settled one would have to be
    // overwritten.
    return { ok: false, reason: "invalid-event" };
  }

  const item = live.run.live[itemIndex];
  if (item === undefined || item.kind !== "tool") return { ok: false, reason: "invalid-event" };
  const items = replaceAt(
    live.run.live,
    itemIndex,
    Object.freeze({ ...item, result: Object.freeze({ ok: payload.ok, content: payload.content }) }),
  );

  return replacedRun(previous, live.index, { ...live.run, live: items }, watermark);
}

function foldRunEnded(
  previous: HostSnapshot,
  scope: Extract<EventScope, { kind: "run" }>,
  run: TerminalRunSnapshot,
  session: SessionSnapshot,
  watermark: Watermark,
): FoldOutcome {
  const runIndex = indexOfId(previous.runs, run.runId, (item) => item.runId);
  const sessionIndex = indexOfId(previous.sessions, session.sessionId, (item) => item.sessionId);
  if (runIndex < 0 || sessionIndex < 0) return { ok: false, reason: "invalid-event" };
  if (scope.sessionId !== session.sessionId || scope.sessionId !== run.sessionId) {
    return { ok: false, reason: "invalid-event" };
  }

  const existing = previous.runs[runIndex];
  if (existing === undefined || !runStageAllows(existing.status, run.status)) {
    return { ok: false, reason: "invalid-event" };
  }
  if (!sameRunIdentity(existing, run)) return { ok: false, reason: "run-identity" };
  if (!turnIdFits(existing.turnId, run.turnId)) return { ok: false, reason: "run-identity" };

  // One update carries both halves: the terminal run and the settled session.
  // A reader never sees a finished run beside a session that still points at it.
  return {
    ok: true,
    presentation: withWatermark(
      {
        hostInstanceId: previous.hostInstanceId,
        sessions: replaceAt(previous.sessions, sessionIndex, session),
        runs: replaceAt(previous.runs, runIndex, run),
        plugins: previous.plugins,
      },
      watermark,
    ),
  };
}

function foldPluginUpdated(
  previous: HostSnapshot,
  plugin: PluginSummary,
  watermark: Watermark,
): FoldOutcome {
  const index = indexOfId(previous.plugins, plugin.id, (item) => item.id);
  if (index < 0) return { ok: false, reason: "invalid-event" };

  return {
    ok: true,
    presentation: withWatermark(
      {
        hostInstanceId: previous.hostInstanceId,
        sessions: previous.sessions,
        runs: previous.runs,
        plugins: replaceAt(previous.plugins, index, plugin),
      },
      watermark,
    ),
  };
}

function replacedRun(
  previous: HostSnapshot,
  runIndex: number,
  run: RunSnapshot,
  watermark: Watermark,
): FoldOutcome {
  return {
    ok: true,
    presentation: withWatermark(
      {
        hostInstanceId: previous.hostInstanceId,
        sessions: previous.sessions,
        runs: replaceAt(previous.runs, runIndex, run),
        plugins: previous.plugins,
      },
      watermark,
    ),
  };
}
