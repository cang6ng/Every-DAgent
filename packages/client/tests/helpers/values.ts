/**
 * Well-formed protocol values for tests.
 *
 * The client's tests care about sequences, identities and folds, not about
 * typing out DTOs; these builders produce values the real validators accept, so
 * a fixture mistake surfaces as an invalid frame rather than as a confusing
 * assertion later.
 */

import type {
  ActiveRunSnapshot,
  LiveItem,
  LiveToolItem,
  PluginSummary,
  RunSummary,
  SessionSummary,
  SessionSummaryPage,
  TerminalRunSnapshot,
} from "@every-dagent/protocol";
import { decodeFrame, validateMessage } from "@every-dagent/protocol";

/** One session summary: a fresh identity with no history and no active run. */
export function sessionSummary(
  overrides: Partial<SessionSummary> & { readonly sessionId: string },
): SessionSummary {
  return Object.freeze({
    generation: 1,
    title: `Session ${overrides.sessionId}`,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    status: "ready" as const,
    blockedReason: null,
    metadataRevision: 1,
    historyRevision: 0,
    committedSeq: 0,
    activeRunId: null,
    ...overrides,
  });
}

/** One bounded page holding exactly the sessions given. */
export function sessionPage(items: readonly SessionSummary[]): SessionSummaryPage {
  return Object.freeze({
    items: Object.freeze([...items]),
    collectionRevision: 1,
    nextCursor: null,
    hasMore: false,
  });
}

export function activeRun(
  overrides: Partial<ActiveRunSnapshot> & {
    readonly runId: string;
    readonly sessionId: string;
    readonly submissionId: string;
  },
): ActiveRunSnapshot {
  return Object.freeze({
    text: "hello",
    turnId: null,
    cancelRequested: false,
    acceptedAt: 1_700_000_000_000,
    startedAt: null,
    endedAt: null,
    status: "accepted" as const,
    endReason: null,
    error: null,
    executionKnowledge: null,
    live: Object.freeze([]),
    liveTruncated: false,
    ...overrides,
  });
}

export function runningRun(
  overrides: Partial<ActiveRunSnapshot> & {
    readonly runId: string;
    readonly sessionId: string;
    readonly submissionId: string;
  },
): ActiveRunSnapshot {
  return activeRun({ startedAt: 1_700_000_000_001, ...overrides, status: "running" as const });
}

export function completedRun(input: {
  readonly runId: string;
  readonly sessionId: string;
  readonly submissionId: string;
  readonly text?: string;
  readonly turnId?: string;
}): TerminalRunSnapshot {
  return Object.freeze({
    runId: input.runId,
    sessionId: input.sessionId,
    submissionId: input.submissionId,
    text: input.text ?? "hello",
    turnId: input.turnId ?? "turn-1",
    cancelRequested: false,
    acceptedAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_001,
    endedAt: 1_700_000_000_002,
    status: "completed" as const,
    endReason: "completed" as const,
    error: null,
    executionKnowledge: null,
    live: null,
  });
}

export function textItem(itemId: string, text: string): LiveItem {
  return Object.freeze({ kind: "text" as const, itemId, text });
}

/** One live tool occurrence, unset until a result fills it. */
export function toolItem(
  overrides: Partial<LiveToolItem> & { readonly itemId: string; readonly invocationId: string },
): LiveToolItem {
  return Object.freeze({
    kind: "tool" as const,
    callId: "",
    name: "demo",
    input: Object.freeze({ kind: "json" as const, value: Object.freeze({}) }),
    result: null,
    ...overrides,
  });
}

export function pluginSummary(
  overrides: Partial<PluginSummary> & { readonly id: string },
): PluginSummary {
  const status = overrides.status ?? ("disabled" as const);
  const desiredEnabled = overrides.desiredEnabled ?? false;
  const configRevision = overrides.configRevision ?? null;
  const effectiveConfigRevision = overrides.effectiveConfigRevision ?? configRevision;
  return Object.freeze({
    name: `Plugin ${overrides.id}`,
    version: "1.0.0",
    permissions: Object.freeze([]),
    status,
    desiredEnabled,
    configRevision,
    effectiveConfigRevision,
    restartRequired:
      overrides.restartRequired ??
      (configRevision !== null && configRevision !== effectiveConfigRevision),
    unavailable: overrides.unavailable ?? (status === "error" || (desiredEnabled && status !== "enabled")),
    ...overrides,
  });
}

/**
 * Sends one frame to the client as-is, after checking it is a valid message.
 *
 * The fixture's own guard: when a test builds a *valid* frame to prove the
 * client rejects its *semantics*, a typo in the envelope should fail here rather
 * than pass silently as "the client rejected it".
 */
export function isDecodable(frame: string): boolean {
  return decodeFrame(frame).success;
}

export function isHostEvent(frame: string): boolean {
  const decoded = decodeFrame(frame);
  return decoded.success && decoded.output.kind === "host-event" && validateMessage({ kind: "host-event" }, decoded.output).success;
}

export function messagesOf(frames: readonly string[], kind: string): readonly unknown[] {
  return frames.flatMap((frame) => {
    const decoded = decodeFrame(frame);
    if (!decoded.success || decoded.output.kind !== kind) return [];
    return [decoded.output];
  });
}

/** The host events a client received, in order. */
export function eventsOf(frames: readonly string[]): readonly { readonly type: string; readonly sequence: number }[] {
  return frames.flatMap((frame) => {
    const decoded = decodeFrame(frame);
    if (!decoded.success || decoded.output.kind !== "host-event") return [];
    return [{ type: decoded.output.type, sequence: decoded.output.sequence }];
  });
}

/** Finds one run in a snapshot, by id. */
export function runIn(runs: readonly RunSummary[], runId: string): RunSummary | undefined {
  return runs.find((run) => run.runId === runId);
}

/** Finds one session in a snapshot, by id. */
export function sessionIn(
  sessions: readonly SessionSummary[],
  sessionId: string,
): SessionSummary | undefined {
  return sessions.find((session) => session.sessionId === sessionId);
}
