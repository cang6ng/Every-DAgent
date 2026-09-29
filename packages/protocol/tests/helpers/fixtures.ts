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
  HostDescription,
  HostSnapshot,
  LiveItem,
  PluginSummary,
  ProtocolError,
  SessionSnapshot,
  SessionSummary,
  TerminalRunSnapshot,
} from "@every-dagent/protocol";

export const INSTANCE = "host-instance-1";
export const STREAM = "stream-1";
export const SESSION = "s-1";
export const RUN = "r-1";
export const PLUGIN = "calculator";

export function describeParams(): Record<string, unknown> {
  return {
    supportedProtocolVersions: ["1"],
    client: { name: "test-client", version: "0.1.0" },
    capabilities: { reverseRequests: true },
  };
}

export function describeRequest(requestId = "c-1"): Record<string, unknown> {
  return {
    kind: "client-request",
    protocolVersion: "1",
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
    protocolVersion: "1",
    requestId,
    method,
    params,
    hostInstanceId: INSTANCE,
  };
}

export function protocolError(code: ProtocolError["code"] = "INTERNAL_ERROR"): ProtocolError {
  return { code, message: "safe fixed notice" };
}

export function hostDescription(): HostDescription {
  return {
    protocolVersion: "1",
    hostInstanceId: INSTANCE,
    host: { name: "every-dagent", version: "0.1.0" },
    capabilities: {
      sessions: true,
      runs: true,
      plugins: true,
      subscriptions: true,
      reverseRequests: true,
    },
    clientCapabilities: { reverseRequests: true },
    limits: { maxActiveRuns: 1 },
    retention: "host-lifetime",
  };
}

export function pluginSummary(status: PluginSummary["status"] = "disabled"): PluginSummary {
  return {
    id: PLUGIN,
    name: "Calculator",
    version: "0.1.0",
    permissions: [],
    status,
  };
}

export function canonicalUser(id = "i-1"): CanonicalItem {
  return { kind: "user", id, turnId: "turn-1", text: "hello" };
}

export function canonicalToolCall(invocationId = "inv-1", callId = ""): CanonicalItem {
  return {
    kind: "tool-call",
    id: "i-3",
    turnId: "turn-1",
    invocationId,
    callId,
    name: "calculator",
    input: { kind: "json", value: { a: 21, b: 2 } },
  };
}

export function canonicalToolResult(invocationId = "inv-1", callId = ""): CanonicalItem {
  return {
    kind: "tool-result",
    id: "i-4",
    turnId: "turn-1",
    invocationId,
    callId,
    name: "calculator",
    ok: true,
    content: "42",
  };
}

export function sessionSummary(activeRunId: string | null = null): SessionSummary {
  return { sessionId: SESSION, createdAt: 1_000, status: "ready", activeRunId };
}

export function sessionSnapshot(
  canonical: CanonicalItem[] = [],
  activeRunId: string | null = null,
): SessionSnapshot {
  return { ...sessionSummary(activeRunId), canonical };
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
    status,
    endReason: null,
    error: null,
    live,
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
  };
  switch (status) {
    case "completed":
      return { ...base, status, endReason: "completed", error: null, live: null };
    case "limited":
      return { ...base, status, endReason: "max_steps", error: null, live: null };
    case "cancelled":
      return { ...base, status, endReason: "cancelled", error: null, live: null };
    case "failed":
      return { ...base, status, endReason: "host_error", error: protocolError(), live: null };
  }
}

export function hostSnapshot(): HostSnapshot {
  return {
    hostInstanceId: INSTANCE,
    watermark: { streamId: STREAM, sequence: 0 },
    sessions: [sessionSnapshot()],
    runs: [],
    plugins: [pluginSummary()],
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
    protocolVersion: "1",
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
    protocolVersion: "1",
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
    protocolVersion: "1",
    hostInstanceId: INSTANCE,
    streamId: STREAM,
    requestId,
    result,
  };
}

export function clientResponseError(requestId = "h-1"): Record<string, unknown> {
  return {
    kind: "client-response",
    protocolVersion: "1",
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
    protocolVersion: "1",
    hostInstanceId: INSTANCE,
    requestId,
    result,
  };
}

export function hostResponseError(requestId = "c-1"): Record<string, unknown> {
  return {
    kind: "host-response",
    protocolVersion: "1",
    hostInstanceId: INSTANCE,
    requestId,
    error: protocolError("METHOD_NOT_FOUND"),
  };
}
