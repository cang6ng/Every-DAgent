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
  RunSnapshot,
  SessionSnapshot,
  TerminalRunSnapshot,
} from "@every-dagent/protocol";
import { decodeFrame, validateMessage } from "@every-dagent/protocol";

export function sessionSnapshot(
  overrides: Partial<SessionSnapshot> & { readonly sessionId: string },
): SessionSnapshot {
  return Object.freeze({
    createdAt: 1_700_000_000_000,
    status: "ready" as const,
    activeRunId: null,
    canonical: Object.freeze([]),
    ...overrides,
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
    status: "accepted" as const,
    endReason: null,
    error: null,
    live: Object.freeze([]),
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
  return activeRun({ ...overrides, status: "running" as const });
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
    status: "completed" as const,
    endReason: "completed" as const,
    error: null,
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
  return Object.freeze({
    name: `Plugin ${overrides.id}`,
    version: "1.0.0",
    permissions: Object.freeze([]),
    status: "disabled" as const,
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
export function runIn(runs: readonly RunSnapshot[], runId: string): RunSnapshot | undefined {
  return runs.find((run) => run.runId === runId);
}

/** Finds one session in a snapshot, by id. */
export function sessionIn(
  sessions: readonly SessionSnapshot[],
  sessionId: string,
): SessionSnapshot | undefined {
  return sessions.find((session) => session.sessionId === sessionId);
}
