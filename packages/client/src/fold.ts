/**
 * The fold: what one validated event means for the presentation replica.
 *
 * This module is pure. It reads the previous snapshot and one event, and returns
 * either the next snapshot or a reason the event cannot follow from the state
 * the client holds. It never sends anything, never consults the connection, and
 * never repairs a gap by guessing: an event that does not fit its own history is
 * a peer error, not something to paper over.
 *
 * Immutability is by construction here: every node this module creates is
 * frozen, every node it reuses is already frozen, and the arrays it touches are
 * copied rather than edited — so an old snapshot can never change under a
 * reader, and an unchanged branch is shared instead of rebuilt.
 */

import type {
  ActiveRunSnapshot,
  HostEvent,
  HostSnapshot,
  LiveItem,
  PluginSummary,
  RunSnapshot,
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

function withWatermark(base: Omit<HostSnapshot, "watermark">, watermark: Watermark): HostSnapshot {
  return Object.freeze({ ...base, watermark: Object.freeze({ streamId: watermark.streamId, sequence: watermark.sequence }) });
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
      return foldOutputDelta(previous, event.scope.runId, event.payload.itemId, event.payload.text, watermark);
    case "run.tool.call":
      return foldToolCall(previous, event.scope.runId, event.payload.item, watermark);
    case "run.tool.result":
      return foldToolResult(previous, event.scope.runId, event.payload, watermark);
    case "run.ended":
      return foldRunEnded(previous, event.payload.run, event.payload.session, watermark);
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
    runs = Object.freeze([...previous.runs, run]);
  } else {
    const existing = previous.runs[runIndex];
    if (existing === undefined) return { ok: false, reason: "invalid-event" };
    // A terminal run is final; and a run's identity is fixed for its life.
    if (existing.live === null || !sameRunIdentity(existing, run) || !turnIdFits(existing.turnId, run.turnId)) {
      return { ok: false, reason: existing.live === null ? "invalid-event" : "run-identity" };
    }
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

/** The run a content event belongs to: it must exist here, and it must still be live. */
function liveRunAt(
  previous: HostSnapshot,
  runId: string,
): { readonly index: number; readonly run: Extract<RunSnapshot, { live: readonly LiveItem[] }> } | undefined {
  const index = indexOfId(previous.runs, runId, (item) => item.runId);
  if (index < 0) return undefined;
  const run = previous.runs[index];
  if (run === undefined || run.live === null) return undefined;
  return { index, run };
}

function foldOutputDelta(
  previous: HostSnapshot,
  runId: string,
  itemId: string,
  text: string,
  watermark: Watermark,
): FoldOutcome {
  const live = liveRunAt(previous, runId);
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
  runId: string,
  item: Extract<LiveItem, { kind: "tool" }>,
  watermark: Watermark,
): FoldOutcome {
  const live = liveRunAt(previous, runId);
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
  runId: string,
  payload: { readonly invocationId: string; readonly ok: boolean; readonly content: string },
  watermark: Watermark,
): FoldOutcome {
  const live = liveRunAt(previous, runId);
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
  run: TerminalRunSnapshot,
  session: SessionSnapshot,
  watermark: Watermark,
): FoldOutcome {
  const runIndex = indexOfId(previous.runs, run.runId, (item) => item.runId);
  const sessionIndex = indexOfId(previous.sessions, session.sessionId, (item) => item.sessionId);
  if (runIndex < 0 || sessionIndex < 0) return { ok: false, reason: "invalid-event" };

  const existing = previous.runs[runIndex];
  if (existing === undefined || existing.live === null) return { ok: false, reason: "invalid-event" };
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
