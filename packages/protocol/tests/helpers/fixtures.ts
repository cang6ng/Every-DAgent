/**
 * Shared, valid-by-construction message builders for the protocol tests.
 *
 * Every builder returns a plain object matching the frozen DTOs, so tests
 * express intent as deltas from a valid baseline instead of restating the
 * whole contract in each case.
 */

import type {
  ActiveRunSnapshot,
  CanonicalItem,
  CollectionRevisions,
  HistoryPage,
  HostDescription,
  HostSnapshot,
  LiveItem,
  PluginSummary,
  ProtocolError,
  RunSummary,
  RunSummaryPage,
  SessionSummary,
  SessionSummaryPage,
  SettingsSnapshot,
  StorageIdentity,
  TerminalRunSnapshot,
} from "@every-dagent/protocol";

export const INSTANCE = "host-instance-1";
export const STREAM = "stream-1";
export const STORAGE = "storage-1";
export const SESSION = "s-1";
export const RUN = "r-1";
export const PLUGIN = "calculator";

export const REQUIRED_LIMITS = {
  maxActiveRuns: 1,
  maxInputBytes: 16 * 1024,
  maxRecordBytes: 64 * 1024,
  maxPageItems: 50,
  maxPageBytes: 192 * 1024,
  maxFrameBytes: 256 * 1024,
  maxOutboxBytes: 1024 * 1024,
  maxTitleChars: 200,
} as const;

export const FULL_CAPABILITIES = {
  sessions: true,
  runs: true,
  plugins: true,
  subscriptions: true,
  reverseRequests: true,
  historyPages: true,
  sessionMutations: true,
  settings: false,
  approvals: false,
} as const;

export function describeParams(): Record<string, unknown> {
  return {
    supportedProtocolVersions: ["2"],
    client: { name: "test-client", version: "0.1.0" },
    capabilities: { reverseRequests: true },
  };
}

export function describeRequest(requestId = "c-1"): Record<string, unknown> {
  return {
    kind: "client-request",
    protocolVersion: "2",
    requestId,
    method: "host.describe",
    params: describeParams(),
  };
}

export function businessRequest(
  method: string,
  params: unknown,
  requestId = "c-2",
): Record<string, unknown> {
  return {
    kind: "client-request",
    protocolVersion: "2",
    requestId,
    method,
    params,
    hostInstanceId: INSTANCE,
  };
}

export function protocolError(code: ProtocolError["code"] = "INTERNAL_ERROR"): ProtocolError {
  return { code, message: "safe fixed notice" };
}

export function storageIdentity(retention: "durable" | "ephemeral" = "ephemeral"): StorageIdentity {
  return { storageId: STORAGE, retention, schemaVersion: 1 };
}

export function hostDescription(): HostDescription {
  return {
    protocolVersion: "2",
    hostInstanceId: INSTANCE,
    host: { name: "every-dagent", version: "0.2.0" },
    storage: storageIdentity(),
    capabilities: { ...FULL_CAPABILITIES },
    clientCapabilities: { reverseRequests: true },
    limits: { ...REQUIRED_LIMITS },
  };
}

export function pluginSummary(status: PluginSummary["status"] = "disabled"): PluginSummary {
  return {
    id: PLUGIN,
    name: "Calculator",
    version: "0.1.0",
    permissions: [],
    status,
    desiredEnabled: false,
    configRevision: null,
    effectiveConfigRevision: null,
    restartRequired: false,
    unavailable: status === "error",
  };
}

export function canonicalUser(id = "i-1", seq = 1): CanonicalItem {
  return { kind: "user", id, turnId: "turn-1", seq, text: "hello" };
}

export function canonicalAssistant(id = "i-2", seq = 2): CanonicalItem {
  return { kind: "assistant", id, turnId: "turn-1", seq, text: "hi" };
}

export function canonicalToolCall(invocationId = "inv-1", callId = "", seq = 3): CanonicalItem {
  return {
    kind: "tool-call",
    id: "i-3",
    turnId: "turn-1",
    seq,
    invocationId,
    callId,
    name: "calculator",
    input: { kind: "json", value: { a: 21, b: 2 } },
  };
}

export function canonicalToolResult(invocationId = "inv-1", callId = "", seq = 4): CanonicalItem {
  return {
    kind: "tool-result",
    id: "i-4",
    turnId: "turn-1",
    seq,
    invocationId,
    callId,
    name: "calculator",
    ok: true,
    content: "42",
  };
}

export function collectionRevisions(
  revisions: Partial<CollectionRevisions> = {},
): CollectionRevisions {
  return {
    sessions: revisions.sessions ?? 1,
    runs: revisions.runs ?? 1,
    plugins: revisions.plugins ?? 1,
  };
}

export function sessionSummary(activeRunId: string | null = null): SessionSummary {
  return {
    sessionId: SESSION,
    generation: 1,
    title: "会话 s-1",
    createdAt: 1_000,
    updatedAt: 1_000,
    status: "ready",
    blockedReason: null,
    metadataRevision: 0,
    historyRevision: 0,
    committedSeq: 0,
    activeRunId,
  };
}

export function sessionPage(items: readonly SessionSummary[] = []): SessionSummaryPage {
  return { items: [...items], collectionRevision: 1, nextCursor: null, hasMore: false };
}

export function runSummary(status: RunSummary["status"] = "completed"): RunSummary {
  const base = {
    runId: RUN,
    submissionId: "sub-1",
    sessionId: SESSION,
    text: "calculate 21 * 2",
    turnId: "turn-1",
    cancelRequested: false,
    acceptedAt: 1_000,
    startedAt: 1_001,
    endedAt: 1_002,
  };
  switch (status) {
    case "accepted":
      return { ...base, status, endReason: null, error: null, executionKnowledge: null, startedAt: null, endedAt: null };
    case "running":
      return { ...base, status, endReason: null, error: null, executionKnowledge: null, endedAt: null };
    case "completed":
      return { ...base, status, endReason: "completed", error: null, executionKnowledge: null };
    case "limited":
      return { ...base, status, endReason: "max_steps", error: null, executionKnowledge: null };
    case "cancelled":
      return { ...base, status, endReason: "cancelled", error: null, executionKnowledge: null };
    case "failed":
      return { ...base, status, endReason: "host_error", error: protocolError(), executionKnowledge: null };
    case "interrupted":
      return { ...base, status, endReason: "interrupted", error: null, executionKnowledge: "unknown" };
  }
}

export function runPage(items: readonly RunSummary[] = []): RunSummaryPage {
  return { items: [...items], collectionRevision: 1, nextCursor: null, hasMore: false };
}

export function historyPage(items: readonly CanonicalItem[] = []): HistoryPage {
  const fromSeq = items.length === 0 ? 0 : (items[0]?.seq ?? 0) - 1;
  const toSeq = items.length === 0 ? 0 : (items[items.length - 1]?.seq ?? 0) + 1;
  return {
    storageId: STORAGE,
    sessionId: SESSION,
    generation: 1,
    historyRevision: 1,
    fenceSeq: toSeq,
    direction: "backward",
    items: [...items],
    coverage: { fromSeq, toSeq },
    startsAtTurnBoundary: true,
    endsAtTurnBoundary: true,
    atStart: fromSeq === 0,
    atFence: true,
    nextCursor: fromSeq === 0 ? null : "cursor-1",
  };
}

export function liveTextItem(itemId = "live-1"): LiveItem {
  return { kind: "text", itemId, text: "partial" };
}

export function liveToolItem(invocationId = "inv-1", callId = ""): LiveItem {
  return {
    kind: "tool",
    itemId: "live-2",
    invocationId,
    callId,
    name: "calculator",
    input: { kind: "json", value: { a: 21, b: 2 } },
    result: null,
  };
}

export function activeRun(
  status: "accepted" | "running" = "accepted",
  live: LiveItem[] = [],
): ActiveRunSnapshot {
  return {
    runId: RUN,
    submissionId: "sub-1",
    sessionId: SESSION,
    text: "calculate 21 * 2",
    turnId: null,
    cancelRequested: false,
    acceptedAt: 1_000,
    startedAt: status === "running" ? 1_001 : null,
    endedAt: null,
    status,
    endReason: null,
    error: null,
    executionKnowledge: null,
    live,
    liveTruncated: false,
  };
}

export function terminalRun(
  status: TerminalRunSnapshot["status"] = "completed",
): TerminalRunSnapshot {
  const base = {
    runId: RUN,
    submissionId: "sub-1",
    sessionId: SESSION,
    text: "calculate 21 * 2",
    turnId: "turn-1",
    cancelRequested: false,
    acceptedAt: 1_000,
    startedAt: 1_001,
    endedAt: 1_002,
  };
  switch (status) {
    case "completed":
      return { ...base, status, endReason: "completed", error: null, executionKnowledge: null, live: null };
    case "limited":
      return { ...base, status, endReason: "max_steps", error: null, executionKnowledge: null, live: null };
    case "cancelled":
      return { ...base, status, endReason: "cancelled", error: null, executionKnowledge: null, live: null };
    case "failed":
      return { ...base, status, endReason: "host_error", error: protocolError(), executionKnowledge: null, live: null };
    case "interrupted":
      return { ...base, status, endReason: "interrupted", error: null, executionKnowledge: "unknown", live: null };
  }
}

export function hostSnapshot(): HostSnapshot {
  return {
    hostInstanceId: INSTANCE,
    watermark: { streamId: STREAM, sequence: 0 },
    storage: storageIdentity(),
    collections: collectionRevisions(),
    sessions: sessionPage([sessionSummary()]),
    runs: runPage(),
    plugins: [pluginSummary()],
    settings: [
      { namespace: "host", desiredRevision: 1, effectiveRevision: 1, restartRequired: false },
      { namespace: "model", desiredRevision: 1, effectiveRevision: 1, restartRequired: false },
    ],
  };
}

/** One settings snapshot, as a read of a namespace answers. */
export function settingsSnapshot(): SettingsSnapshot {
  return {
    namespace: "host",
    desiredRevision: 2,
    effectiveRevision: 1,
    restartRequired: true,
    desiredValue: { systemPrompt: "next" },
    effectiveValue: { systemPrompt: "current" },
  };
}

export function hostEvent(
  type: string,
  scope: unknown,
  payload: unknown,
  sequence = 1,
): Record<string, unknown> {
  return {
    kind: "host-event",
    protocolVersion: "2",
    hostInstanceId: INSTANCE,
    streamId: STREAM,
    sequence,
    scope,
    type,
    payload,
  };
}

export function hostRequest(
  method: string,
  params: unknown,
  requestId = "h-1",
): Record<string, unknown> {
  return {
    kind: "host-request",
    protocolVersion: "2",
    requestId,
    method,
    params,
    hostInstanceId: INSTANCE,
    streamId: STREAM,
    timeoutMs: 1_000,
  };
}

export function clientResponseSuccess(
  result: unknown,
  requestId = "h-1",
): Record<string, unknown> {
  return {
    kind: "client-response",
    protocolVersion: "2",
    hostInstanceId: INSTANCE,
    streamId: STREAM,
    requestId,
    result,
  };
}

export function clientResponseError(requestId = "h-1"): Record<string, unknown> {
  return {
    kind: "client-response",
    protocolVersion: "2",
    hostInstanceId: INSTANCE,
    streamId: STREAM,
    requestId,
    error: protocolError("REQUEST_CANCELLED"),
  };
}

export function hostResponseSuccess(
  result: unknown,
  requestId = "c-1",
): Record<string, unknown> {
  return {
    kind: "host-response",
    protocolVersion: "2",
    hostInstanceId: INSTANCE,
    requestId,
    result,
  };
}

export function hostResponseError(requestId = "c-1"): Record<string, unknown> {
  return {
    kind: "host-response",
    protocolVersion: "2",
    hostInstanceId: INSTANCE,
    requestId,
    error: protocolError("METHOD_NOT_FOUND"),
  };
}
