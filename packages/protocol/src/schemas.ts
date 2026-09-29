/**
 * Valibot schemas for the frozen DTOs and the primitive constraints they all
 * share.
 *
 * Two rules shape everything here:
 *
 * 1. Valibot checks structure; `json-value.ts` has already ruled out the
 *    things a schema cannot see (accessors, prototypes, `-0`, `NaN`). The
 *    whole message passes the strict JSON guard and is snapshotted before any
 *    schema in this module runs.
 * 2. Fixed DTOs use `v.object` (unknown fields stripped); arbitrary JSON
 *    dictionaries use `JsonValueSchema`, which re-runs the real predicate —
 *    never an always-true assertion, and never `v.record`, which would
 *    silently drop legal keys like `__proto__`.
 *
 * These schemas are internal: the public contract is the TypeScript types in
 * `contracts.ts` / `operations.ts` / `events.ts`, and the tests pin the
 * schema outputs to those types so the two cannot drift.
 */

import * as v from "valibot";

import type {
  ActiveRunSnapshot,
  CanonicalItem,
  HostDescription,
  HostSnapshot,
  JsonValue,
  LiveItem,
  LiveToolItem,
  ProtocolError,
  RunSnapshot,
  SessionSnapshot,
  SessionSummary,
  TerminalRunSnapshot,
} from "./contracts.js";
import { isStrictJsonValue } from "./json-value.js";

// ---------------------------------------------------------------------------
// Primitives.
// ---------------------------------------------------------------------------

/** Any string, including empty. `callId`, `text` and tool content live here. */
const plainStringSchema = v.string();

/** A host-generated identifier: non-empty, never trimmed or rewritten. */
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

const idSchema = nonEmptyStringSchema;

/** A wire generation: a positive integer in plain decimal, never parsed numerically. */
const generationStringSchema = v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/));

/** Core plugin ids keep the Phase 2 shape; the protocol does not widen it. */
const pluginIdSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9._-]*$/));

/** A finite JSON number — `NaN` is already gone at the guard, `Infinity` is not. */
const finiteNumberSchema = v.pipe(v.number(), v.check((value) => Number.isFinite(value)));

/** `Sequence` and every count: a non-negative safe integer. */
const nonNegativeSafeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const sequenceSchema = nonNegativeSafeIntegerSchema;

const positiveSafeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

/** Text that must contain something beyond whitespace; compared verbatim, never trimmed. */
const hasNonWhitespaceSchema = v.pipe(
  v.string(),
  v.check((text) => /\S/.test(text)),
);

const plainBooleanSchema = v.boolean();

// ---------------------------------------------------------------------------
// Arbitrary JSON.
// ---------------------------------------------------------------------------

/**
 * Re-runs the full strict predicate. The enclosing message already passed it,
 * so this never fails in practice — but it keeps the schema honest: a
 * `JsonValue` slot is checked as a `JsonValue`, not asserted.
 */
const JsonValueSchema: v.GenericSchema<JsonValue> = v.custom<JsonValue>(isStrictJsonValue);

/**
 * Rejects non-object payloads on the RAW value, before any stripping runs.
 *
 * Valibot's `v.object` happily accepts an array (or class instance) as input
 * and strips it into a fresh `{}` — so "no required fields" schemas would
 * otherwise launder an array into an empty params object. Everything with
 * zero required entries composes this first; DTOs with required fields fail
 * on their own missing keys. Typed loosely on purpose: its output is always
 * handed straight to a structuring schema.
 */
const plainJsonObjectSchema = v.custom<{ readonly [key: string]: unknown }>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);

// ---------------------------------------------------------------------------
// Errors. Declared before the DTO schemas that embed them.
// ---------------------------------------------------------------------------

const protocolErrorSchema: v.GenericSchema<ProtocolError> = v.object({
  code: v.union([
    v.literal("INVALID_REQUEST"),
    v.literal("UNSUPPORTED_PROTOCOL"),
    v.literal("NOT_INITIALIZED"),
    v.literal("HOST_INSTANCE_MISMATCH"),
    v.literal("METHOD_NOT_FOUND"),
    v.literal("CAPABILITY_NOT_SUPPORTED"),
    v.literal("SESSION_NOT_FOUND"),
    v.literal("SESSION_UNAVAILABLE"),
    v.literal("RUN_NOT_FOUND"),
    v.literal("PLUGIN_NOT_FOUND"),
    v.literal("HOST_BUSY"),
    v.literal("PLUGIN_UNAVAILABLE"),
    v.literal("PLUGIN_PERMISSION_DENIED"),
    v.literal("PLUGIN_OPERATION_FAILED"),
    v.literal("SUBMISSION_CONFLICT"),
    v.literal("REQUEST_CANCELLED"),
    v.literal("INTERNAL_ERROR"),
  ]),
  message: v.string(),
});

// ---------------------------------------------------------------------------
// Capabilities and host description.
// ---------------------------------------------------------------------------

const clientCapabilitiesSchema = v.object({ reverseRequests: v.boolean() });

const hostCapabilitiesSchema = v.object({
  sessions: v.boolean(),
  runs: v.boolean(),
  plugins: v.boolean(),
  subscriptions: v.boolean(),
  reverseRequests: v.boolean(),
});

const hostDescriptionSchema: v.GenericSchema<HostDescription> = v.object({
  protocolVersion: v.literal("1"),
  hostInstanceId: idSchema,
  host: v.object({ name: nonEmptyStringSchema, version: nonEmptyStringSchema }),
  capabilities: hostCapabilitiesSchema,
  clientCapabilities: clientCapabilitiesSchema,
  // A legal limit is any positive safe integer; "the current Host reports 1"
  // is that Host's admission, checked in P3.2, not a protocol constant.
  limits: v.object({ maxActiveRuns: positiveSafeIntegerSchema }),
  retention: v.literal("host-lifetime"),
});

// ---------------------------------------------------------------------------
// Plugin summary.
// ---------------------------------------------------------------------------

const pluginFailureSummarySchema = v.object({
  operation: v.union([v.literal("enable"), v.literal("disable")]),
  phase: v.union([
    v.literal("permissions"),
    v.literal("activate"),
    v.literal("commit"),
    v.literal("dispose"),
  ]),
  code: v.union([v.literal("PLUGIN_PERMISSION_DENIED"), v.literal("PLUGIN_OPERATION_FAILED")]),
  message: v.string(),
  cleanupFailureCount: nonNegativeSafeIntegerSchema,
});

const pluginSummarySchema = v.object({
  id: pluginIdSchema,
  name: nonEmptyStringSchema,
  version: nonEmptyStringSchema,
  // A plain string on purpose: plugin descriptions come from trusted plugin
  // authors, and "" is as legitimate as any other text.
  description: v.optional(v.string()),
  permissions: v.array(v.literal("storage")),
  status: v.union([
    v.literal("disabled"),
    v.literal("enabling"),
    v.literal("enabled"),
    v.literal("disabling"),
    v.literal("error"),
  ]),
  lastFailure: v.optional(pluginFailureSummarySchema),
});

// ---------------------------------------------------------------------------
// Canonical conversation.
// ---------------------------------------------------------------------------

const displayInputSchema = v.variant("kind", [
  v.object({ kind: v.literal("json"), value: JsonValueSchema }),
  v.object({ kind: v.literal("unavailable"), reason: v.literal("not-json-safe") }),
]);

const canonicalBaseEntries = {
  id: idSchema,
  turnId: idSchema,
} as const;

// `callId` is a plain string on purpose: Core allows empty and repeated ids,
// and pairing is by log order + invocationId, never by callId uniqueness.
// Tool names are plain strings too — a tool owns its name, and "" must not be
// tightened away by the protocol.
const canonicalItemSchema = v.variant("kind", [
  v.object({ ...canonicalBaseEntries, kind: v.literal("user"), text: v.string() }),
  v.object({ ...canonicalBaseEntries, kind: v.literal("assistant"), text: v.string() }),
  v.object({
    ...canonicalBaseEntries,
    kind: v.literal("tool-call"),
    invocationId: idSchema,
    callId: plainStringSchema,
    name: plainStringSchema,
    input: displayInputSchema,
  }),
  v.object({
    ...canonicalBaseEntries,
    kind: v.literal("tool-result"),
    invocationId: idSchema,
    callId: plainStringSchema,
    name: plainStringSchema,
    ok: v.boolean(),
    content: v.string(),
  }),
]);

/**
 * Occurrence-level consistency of one published canonical array, checked on
 * the whole array because pair correctness is not a per-item property.
 *
 * Pairing is by `invocationId` — never by `callId`, which may be empty and
 * may repeat across invocations. One invocation is one call plus at most one
 * result: a call may occur once, a result consumes exactly one preceding,
 * still-open call, and a pair whose turnId/callId/name disagree is a broken
 * projection, not bad luck to strip away.
 */
function canonicalOccurrencesConsistent(items: readonly CanonicalItem[]): boolean {
  const itemIds = new Set<string>();
  const calls = new Set<string>();
  const results = new Set<string>();
  const openCalls = new Map<string, { turnId: string; callId: string; name: string }>();
  for (const item of items) {
    if (itemIds.has(item.id)) return false;
    itemIds.add(item.id);

    if (item.kind === "tool-call") {
      if (calls.has(item.invocationId)) return false;
      calls.add(item.invocationId);
      openCalls.set(item.invocationId, { turnId: item.turnId, callId: item.callId, name: item.name });
    } else if (item.kind === "tool-result") {
      if (results.has(item.invocationId)) return false;
      const call = openCalls.get(item.invocationId);
      if (call === undefined) return false;
      if (call.turnId !== item.turnId || call.callId !== item.callId || call.name !== item.name) {
        return false;
      }
      results.add(item.invocationId);
      openCalls.delete(item.invocationId);
    }
  }
  return true;
}

const sessionSummarySchema: v.GenericSchema<SessionSummary> = v.object({
  sessionId: idSchema,
  createdAt: v.pipe(finiteNumberSchema, v.minValue(0)),
  status: v.union([v.literal("ready"), v.literal("blocked")]),
  activeRunId: v.union([v.null(), idSchema]),
});

const sessionSnapshotSchema: v.GenericSchema<SessionSnapshot> = v.pipe(
  v.object({
    sessionId: idSchema,
    createdAt: v.pipe(finiteNumberSchema, v.minValue(0)),
    status: v.union([v.literal("ready"), v.literal("blocked")]),
    activeRunId: v.union([v.null(), idSchema]),
    canonical: v.array(canonicalItemSchema),
  }),
  v.check((snapshot) => canonicalOccurrencesConsistent(snapshot.canonical)),
);

// ---------------------------------------------------------------------------
// Runs.
// ---------------------------------------------------------------------------

const liveToolResultSchema = v.object({ ok: v.boolean(), content: v.string() });

const liveToolItemObjectSchema = v.object({
  kind: v.literal("tool"),
  itemId: idSchema,
  invocationId: idSchema,
  callId: plainStringSchema,
  name: plainStringSchema,
  input: displayInputSchema,
  result: v.union([v.null(), liveToolResultSchema]),
});

const liveToolItemSchema: v.GenericSchema<LiveToolItem> = liveToolItemObjectSchema;

const liveItemSchema: v.GenericSchema<LiveItem> = v.variant("kind", [
  v.object({ kind: v.literal("text"), itemId: idSchema, text: v.string() }),
  liveToolItemObjectSchema,
]);

const runBaseEntries = {
  runId: idSchema,
  submissionId: idSchema,
  sessionId: idSchema,
  text: v.string(),
  turnId: v.union([v.null(), idSchema]),
  cancelRequested: v.boolean(),
} as const;

const activeRunSchema: v.GenericSchema<ActiveRunSnapshot> = v.union([
  v.object({
    ...runBaseEntries,
    status: v.literal("accepted"),
    endReason: v.null(),
    error: v.null(),
    live: v.array(liveItemSchema),
  }),
  v.object({
    ...runBaseEntries,
    status: v.literal("running"),
    endReason: v.null(),
    error: v.null(),
    live: v.array(liveItemSchema),
  }),
]);

const terminalRunSchema: v.GenericSchema<TerminalRunSnapshot> = v.union([
  v.object({
    ...runBaseEntries,
    status: v.literal("completed"),
    endReason: v.literal("completed"),
    error: v.null(),
    live: v.null(),
  }),
  v.object({
    ...runBaseEntries,
    status: v.literal("limited"),
    endReason: v.literal("max_steps"),
    error: v.null(),
    live: v.null(),
  }),
  v.object({
    ...runBaseEntries,
    status: v.literal("cancelled"),
    endReason: v.literal("cancelled"),
    error: v.null(),
    live: v.null(),
  }),
  v.object({
    ...runBaseEntries,
    status: v.literal("failed"),
    endReason: v.union([v.literal("error"), v.literal("host_error")]),
    error: protocolErrorSchema,
    live: v.null(),
  }),
]);

const runSnapshotSchema: v.GenericSchema<RunSnapshot> = v.union([
  activeRunSchema,
  terminalRunSchema,
]);

// ---------------------------------------------------------------------------
// Snapshots.
// ---------------------------------------------------------------------------

const watermarkSchema = v.object({ streamId: idSchema, sequence: sequenceSchema });

const hostSnapshotSchema: v.GenericSchema<HostSnapshot> = v.pipe(
  v.object({
    hostInstanceId: idSchema,
    watermark: watermarkSchema,
    sessions: v.array(sessionSnapshotSchema),
    runs: v.array(runSnapshotSchema),
    plugins: v.array(pluginSummarySchema),
  }),
  // Directory consistency the snapshot can prove about itself: unique ids,
  // unique submissions, every run anchored to a session, and the active-run
  // pointers forming a bijection — each session points at most at its own
  // active run, and each active run is pointed at by exactly its own session.
  // This is per-snapshot bookkeeping, NOT a protocol limit on how many runs a
  // whole Host may run at once; concurrency limits are Host implementation
  // facts published through `limits.maxActiveRuns`.
  v.check((snapshot) => {
    const sessionIds = new Set(snapshot.sessions.map((session) => session.sessionId));
    if (sessionIds.size !== snapshot.sessions.length) return false;
    const runIds = new Set(snapshot.runs.map((run) => run.runId));
    if (runIds.size !== snapshot.runs.length) return false;
    const pluginIds = new Set(snapshot.plugins.map((plugin) => plugin.id));
    if (pluginIds.size !== snapshot.plugins.length) return false;
    const submissionIds = new Set(snapshot.runs.map((run) => run.submissionId));
    if (submissionIds.size !== snapshot.runs.length) return false;

    const pointed = new Set<string>();
    for (const session of snapshot.sessions) {
      if (session.activeRunId === null) continue;
      const run = snapshot.runs.find((candidate) => candidate.runId === session.activeRunId);
      if (run === undefined) return false;
      if (run.sessionId !== session.sessionId) return false;
      if (run.status !== "accepted" && run.status !== "running") return false;
      if (pointed.has(run.runId)) return false;
      pointed.add(run.runId);
    }
    for (const run of snapshot.runs) {
      // Every run — active OR terminal — must anchor to a session that exists
      // in this snapshot; a settled run is history, never an orphan.
      if (!sessionIds.has(run.sessionId)) return false;
      if ((run.status === "accepted" || run.status === "running") && !pointed.has(run.runId)) {
        return false;
      }
    }
    return true;
  }),
);

export {
  activeRunSchema,
  canonicalItemSchema,
  clientCapabilitiesSchema,
  displayInputSchema,
  finiteNumberSchema,
  generationStringSchema,
  hasNonWhitespaceSchema,
  hostCapabilitiesSchema,
  hostDescriptionSchema,
  hostSnapshotSchema,
  idSchema,
  JsonValueSchema,
  liveItemSchema,
  liveToolItemSchema,
  nonEmptyStringSchema,
  nonNegativeSafeIntegerSchema,
  plainJsonObjectSchema,
  plainStringSchema,
  pluginIdSchema,
  pluginSummarySchema,
  positiveSafeIntegerSchema,
  protocolErrorSchema,
  runSnapshotSchema,
  sequenceSchema,
  sessionSnapshotSchema,
  sessionSummarySchema,
  terminalRunSchema,
  watermarkSchema,
};
