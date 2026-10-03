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
 * Cross-field checks run on the pre-strip snapshot, so a mismatch between a
 * payload's own ids, its scope, and the window bounds it claims can never be
 * laundered into a valid message by field stripping.
 *
 * These schemas are internal: the public contract is the TypeScript types in
 * `contracts.ts` / `operations.ts` / `events.ts`, and the tests pin the
 * schema outputs to those types so the two cannot drift.
 */

import * as v from "valibot";

import {
  MAX_REQUEST_ID_BYTES,
  MAX_TITLE_CHARS,
  type ActiveRunSnapshot,
  type CanonicalItem,
  type CollectionRevisions,
  type HistoryPage,
  type HostDescription,
  type HostLimits,
  type HostSnapshot,
  type JsonValue,
  type LiveItem,
  type LiveToolItem,
  type PluginSummary,
  type ProtocolError,
  type RunSnapshot,
  type RunSummary,
  type RunSummaryPage,
  type SessionSummary,
  type SessionSummaryPage,
  type StorageIdentity,
  type TerminalRunSnapshot,
} from "./contracts.js";
import { utf8Bytes } from "./bytes.js";
import { isStrictJsonValue } from "./json-value.js";

// ---------------------------------------------------------------------------
// Primitives.
// ---------------------------------------------------------------------------

/** Any string, including empty. `callId`, `text` and tool content live here. */
const plainStringSchema = v.string();

/** A host-generated identifier: non-empty, never trimmed or rewritten. */
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

const idSchema = nonEmptyStringSchema;

/**
 * A request id: non-empty, and inside the one byte bound every envelope
 * position shares.
 *
 * Deliberately not applied to the other identities the wire carries — session,
 * run, submission, item and invocation ids are host-generated and are bounded
 * by the frame they travel in, not by this. A request id is different: it is
 * the correlation a prospective frame check has to reserve room for, and the
 * one identity a peer chooses freely, so its bound has to be a published,
 * enforceable one. Measured as the UTF-8 bytes of the raw string, because a
 * character count is not what a frame pays for.
 */
export function isLegalRequestId(text: string): boolean {
  return text.length > 0 && utf8Bytes(text) <= MAX_REQUEST_ID_BYTES;
}

const requestIdSchema = v.pipe(v.string(), v.check(isLegalRequestId));

/** A wire generation: a positive integer in plain decimal, never parsed numerically. */
const generationStringSchema = v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/));

/** Core plugin ids keep the Phase 2 shape; the protocol does not widen it. */
const pluginIdSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9._-]*$/));

/** A finite JSON number — `NaN` is already gone at the guard, `Infinity` is not. */
const finiteNumberSchema = v.pipe(v.number(), v.check((value) => Number.isFinite(value)));

/** `Sequence` and every count: a non-negative safe integer. */
const nonNegativeSafeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const sequenceSchema = nonNegativeSafeIntegerSchema;
const logPositionSchema = nonNegativeSafeIntegerSchema;
const revisionSchema = nonNegativeSafeIntegerSchema;

const positiveSafeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

/** A non-negative host clock stamp. */
const clockSchema = v.pipe(finiteNumberSchema, v.minValue(0));

/** Text that must contain something beyond whitespace; compared verbatim, never trimmed. */
const hasNonWhitespaceSchema = v.pipe(
  v.string(),
  v.check((text) => /\S/.test(text)),
);

/** A bounded, non-empty display title. Code-unit counted, exactly as a page would show it. */
const titleSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(MAX_TITLE_CHARS),
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
    v.literal("SUBMISSION_RETIRED"),
    v.literal("STALE_CURSOR"),
    v.literal("REVISION_CONFLICT"),
    v.literal("LIMIT_EXCEEDED"),
    v.literal("SETTINGS_INVALID"),
    v.literal("STORAGE_UNAVAILABLE"),
    v.literal("REQUEST_CANCELLED"),
    v.literal("INTERNAL_ERROR"),
  ]),
  message: v.string(),
});

// ---------------------------------------------------------------------------
// Capabilities, storage and host description.
// ---------------------------------------------------------------------------

const clientCapabilitiesSchema = v.object({ reverseRequests: v.boolean() });

const hostCapabilitiesSchema = v.object({
  sessions: v.boolean(),
  runs: v.boolean(),
  plugins: v.boolean(),
  subscriptions: v.boolean(),
  reverseRequests: v.boolean(),
  historyPages: v.boolean(),
  sessionMutations: v.boolean(),
  settings: v.boolean(),
  approvals: v.boolean(),
});

const storageIdentitySchema: v.GenericSchema<StorageIdentity> = v.object({
  storageId: idSchema,
  retention: v.union([v.literal("durable"), v.literal("ephemeral")]),
  schemaVersion: positiveSafeIntegerSchema,
});

const hostLimitsSchema: v.GenericSchema<HostLimits> = v.object({
  // A legal limit is any positive safe integer; "the current Host reports 1"
  // is that Host's admission, checked by the Host, not a protocol constant.
  maxActiveRuns: positiveSafeIntegerSchema,
  maxInputBytes: positiveSafeIntegerSchema,
  maxRecordBytes: positiveSafeIntegerSchema,
  maxPageItems: positiveSafeIntegerSchema,
  maxPageBytes: positiveSafeIntegerSchema,
  maxFrameBytes: positiveSafeIntegerSchema,
  maxOutboxBytes: positiveSafeIntegerSchema,
  maxTitleChars: positiveSafeIntegerSchema,
});

const hostDescriptionSchema: v.GenericSchema<HostDescription> = v.object({
  protocolVersion: v.literal("2"),
  hostInstanceId: idSchema,
  host: v.object({ name: nonEmptyStringSchema, version: nonEmptyStringSchema }),
  storage: storageIdentitySchema,
  capabilities: hostCapabilitiesSchema,
  clientCapabilities: clientCapabilitiesSchema,
  limits: hostLimitsSchema,
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

const pluginSummarySchema = v.pipe(
  v.object({
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
    desiredEnabled: v.boolean(),
    configRevision: v.union([v.null(), revisionSchema]),
    effectiveConfigRevision: v.union([v.null(), revisionSchema]),
    restartRequired: v.boolean(),
    unavailable: v.boolean(),
  }),
  // Two derived facts, pinned to their definitions so a summary cannot claim
  // one thing with its numbers and another with its flags: a restart is owed
  // exactly when the desired configuration revision moved past the bound one,
  // and a plugin is unavailable exactly when it is broken or off while wanted.
  v.check(
    (plugin) =>
      plugin.restartRequired ===
        (plugin.configRevision !== null && plugin.configRevision !== plugin.effectiveConfigRevision) &&
      plugin.unavailable === (plugin.status === "error" || (plugin.desiredEnabled && plugin.status !== "enabled")),
  ),
);

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
  seq: logPositionSchema,
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

/** The identity a tool call and its result both carry for one occurrence. */
interface OccurrenceIdentity {
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
}

function sameOccurrence(left: OccurrenceIdentity, right: OccurrenceIdentity): boolean {
  return left.turnId === right.turnId && left.callId === right.callId && left.name === right.name;
}

/**
 * Occurrence-level consistency of one published canonical array.
 *
 * A published array is either a settled turn's items or one page of a
 * traversal, and the rules are the same for both *within the array*: pairing is
 * by `invocationId` — never by `callId`, which may be empty and may repeat
 * across invocations — one invocation carries at most one call and at most one
 * result, and when both halves are present they must agree on turnId, callId
 * and name. A call that is not here is not a fault; it is the fragment case.
 *
 * A history page is explicitly a fragment: it may begin or end inside a turn,
 * and it may carry one half of an occurrence whose other half sits on the next
 * page — the result here, its call on the page below. So pairing is checked
 * *within* the array and never demanded *of* it: a result whose call is not in
 * the same array is legal, while two items claiming one identity, one position,
 * or one occurrence twice are contradictions no projection could produce.
 *
 * The check is order-independent: each occurrence's two halves are compared
 * with each other whichever way round they appear, because a page's cut can
 * land on either side of an occurrence and a validator that only looked
 * backwards would accept a result-then-contradicting-call array. Whichever
 * half arrives second must agree with the one already here; a half that stands
 * alone stays legal. The whole-turn rules — every declaration recorded, every
 * call answered, no turn left open — belong to the execution window and the
 * commit, where the host applies them to complete ranges (see the host's
 * `assertStoredRange` and `projectSettledTurn`), not to a bounded cut.
 *
 * Positions are checked here too, because "these are log-ordered facts" is a
 * property of the sequence, not of any one item: `id`, `seq` and position in
 * the array must agree.
 */
function canonicalItemsConsistent(items: readonly CanonicalItem[]): boolean {
  const itemIds = new Set<string>();
  const occurrences = new Map<string, { call?: OccurrenceIdentity; result?: OccurrenceIdentity }>();

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item === undefined) return false;
    if (itemIds.has(item.id)) return false;
    itemIds.add(item.id);
    // Ascending, strictly: two items may not claim one log position, and the
    // array order is the log order.
    if (index > 0) {
      const previous = items[index - 1];
      if (previous === undefined || previous.seq >= item.seq) return false;
    }

    if (item.kind !== "tool-call" && item.kind !== "tool-result") continue;

    const half: OccurrenceIdentity = { turnId: item.turnId, callId: item.callId, name: item.name };
    const known = occurrences.get(item.invocationId) ?? {};
    if (item.kind === "tool-call") {
      // A second call for one occurrence is a duplicate; a call whose
      // occurrence already holds a result has to be the result's own call,
      // however many items apart they arrived.
      if (known.call !== undefined) return false;
      if (known.result !== undefined && !sameOccurrence(known.result, half)) return false;
      known.call = half;
    } else {
      if (known.result !== undefined) return false;
      if (known.call !== undefined && !sameOccurrence(known.call, half)) return false;
      known.result = half;
    }
    occurrences.set(item.invocationId, known);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sessions.
// ---------------------------------------------------------------------------

const sessionSummarySchema: v.GenericSchema<SessionSummary> = v.pipe(
  v.object({
    sessionId: idSchema,
    generation: positiveSafeIntegerSchema,
    title: titleSchema,
    createdAt: clockSchema,
    updatedAt: clockSchema,
    status: v.union([v.literal("ready"), v.literal("blocked")]),
    blockedReason: v.union([v.null(), v.literal("unknown-execution"), v.literal("host-fault")]),
    metadataRevision: revisionSchema,
    historyRevision: revisionSchema,
    committedSeq: logPositionSchema,
    activeRunId: v.union([v.null(), idSchema]),
  }),
  v.check((session) => {
    // A blocked session always says why, and a ready one never does: the two
    // fields are the same fact, and a summary that disagrees with itself is not
    // a state this host can be in.
    if (session.status === "blocked") return session.blockedReason !== null;
    return session.blockedReason === null;
  }),
);

const sessionPageSchema: v.GenericSchema<SessionSummaryPage> = v.pipe(
  v.object({
    items: v.array(sessionSummarySchema),
    collectionRevision: revisionSchema,
    nextCursor: v.union([v.null(), idSchema]),
    hasMore: v.boolean(),
  }),
  v.check((page) => {
    // See the note on `runPageSchema`: a cursor implies more, not the reverse.
    if (page.nextCursor !== null && !page.hasMore) return false;
    const ids = new Set(page.items.map((session) => session.sessionId));
    return ids.size === page.items.length;
  }),
);

// ---------------------------------------------------------------------------
// History pages.
// ---------------------------------------------------------------------------

const historyCoverageSchema = v.object({
  fromSeq: logPositionSchema,
  toSeq: logPositionSchema,
});

const historyPageSchema: v.GenericSchema<HistoryPage> = v.pipe(
  v.object({
    storageId: idSchema,
    sessionId: idSchema,
    generation: positiveSafeIntegerSchema,
    historyRevision: revisionSchema,
    fenceSeq: logPositionSchema,
    direction: v.literal("backward"),
    items: v.array(canonicalItemSchema),
    coverage: historyCoverageSchema,
    startsAtTurnBoundary: v.boolean(),
    endsAtTurnBoundary: v.boolean(),
    atStart: v.boolean(),
    atFence: v.boolean(),
    nextCursor: v.union([v.null(), idSchema]),
  }),
  v.check((page) => {
    const { fromSeq, toSeq } = page.coverage;
    if (fromSeq > toSeq) return false;
    // A page never reads past its fence, and never claims history the session
    // does not have.
    if (toSeq > page.fenceSeq) return false;
    if (page.atFence !== (toSeq === page.fenceSeq)) return false;
    if (page.atStart !== (fromSeq === 0)) return false;
    // Reaching the start of history is the same fact as having no older page.
    if (page.atStart !== (page.nextCursor === null)) return false;

    // Every item falls inside the coverage the page reports, at a position of
    // its own: coverage is a range of committed positions, the item's `seq` is
    // the position it was projected from, and positions that project to no item
    // (a turn's own start and end records) are covered without being listed.
    // The items run in log order — an array that skips backwards would be a
    // page advertising coverage it does not have.
    for (let index = 0; index < page.items.length; index++) {
      const item = page.items[index];
      if (item === undefined) return false;
      if (item.seq < fromSeq || item.seq >= toSeq) return false;
      if (index > 0) {
        const previous = page.items[index - 1];
        if (previous === undefined || previous.seq >= item.seq) return false;
      }
    }
    if (page.items.length === 0 && fromSeq !== toSeq) return false;
    return canonicalItemsConsistent(page.items);
  }),
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
  acceptedAt: clockSchema,
  startedAt: v.union([v.null(), clockSchema]),
  endedAt: v.union([v.null(), clockSchema]),
} as const;

/**
 * A run's timestamps have to describe a possible order.
 *
 * A start before acceptance, or an end before either, is not a shape a host
 * could produce from its own clock — and a client reading it would be reading a
 * sequence that never happened.
 */
function runClockOrder(run: {
  readonly acceptedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}): boolean {
  if (run.startedAt !== null && run.startedAt < run.acceptedAt) return false;
  const earliestEnd = run.startedAt ?? run.acceptedAt;
  if (run.endedAt !== null && run.endedAt < earliestEnd) return false;
  return true;
}

const activeRunSchema: v.GenericSchema<ActiveRunSnapshot> = v.pipe(
  v.union([
    v.object({
      ...runBaseEntries,
      status: v.literal("accepted"),
      endReason: v.null(),
      error: v.null(),
      executionKnowledge: v.null(),
      live: v.array(liveItemSchema),
      liveTruncated: v.boolean(),
    }),
    v.object({
      ...runBaseEntries,
      status: v.literal("running"),
      endReason: v.null(),
      error: v.null(),
      executionKnowledge: v.null(),
      live: v.array(liveItemSchema),
      liveTruncated: v.boolean(),
    }),
  ]),
  v.check((run) => runClockOrder(run) && run.endedAt === null),
);

const terminalRunSchema: v.GenericSchema<TerminalRunSnapshot> = v.pipe(
  v.union([
    v.object({
      ...runBaseEntries,
      status: v.literal("completed"),
      endReason: v.literal("completed"),
      error: v.null(),
      executionKnowledge: v.null(),
      live: v.null(),
    }),
    v.object({
      ...runBaseEntries,
      status: v.literal("limited"),
      endReason: v.literal("max_steps"),
      error: v.null(),
      executionKnowledge: v.null(),
      live: v.null(),
    }),
    v.object({
      ...runBaseEntries,
      status: v.literal("cancelled"),
      endReason: v.literal("cancelled"),
      error: v.null(),
      executionKnowledge: v.null(),
      live: v.null(),
    }),
    v.object({
      ...runBaseEntries,
      status: v.literal("failed"),
      endReason: v.union([v.literal("error"), v.literal("host_error")]),
      error: protocolErrorSchema,
      executionKnowledge: v.null(),
      live: v.null(),
    }),
    v.object({
      ...runBaseEntries,
      status: v.literal("interrupted"),
      endReason: v.literal("interrupted"),
      error: v.null(),
      executionKnowledge: v.union([v.literal("not-started"), v.literal("unknown")]),
      live: v.null(),
    }),
  ]),
  // A terminal run says when it ended, and every earlier stamp is a real one.
  v.check((run) => run.endedAt !== null && runClockOrder(run)),
);

const runSnapshotSchema: v.GenericSchema<RunSnapshot> = v.union([
  activeRunSchema,
  terminalRunSchema,
]);

const runSummarySchema: v.GenericSchema<RunSummary> = v.pipe(
  v.object({
    ...runBaseEntries,
    status: v.union([
      v.literal("accepted"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("limited"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("interrupted"),
    ]),
    endReason: v.union([
      v.null(),
      v.literal("completed"),
      v.literal("max_steps"),
      v.literal("error"),
      v.literal("cancelled"),
      v.literal("host_error"),
      v.literal("interrupted"),
    ]),
    error: v.union([v.null(), protocolErrorSchema]),
    executionKnowledge: v.union([v.null(), v.literal("not-started"), v.literal("unknown")]),
  }),
  v.check((run) => {
    if (!runClockOrder(run)) return false;
    const active = run.status === "accepted" || run.status === "running";
    if (active) {
      // An unfinished run has no outcome, and no knowledge to claim either.
      return run.endReason === null && run.error === null && run.executionKnowledge === null && run.endedAt === null;
    }
    if (run.endedAt === null || run.endReason === null) return false;
    if (run.status === "interrupted") {
      return (
        run.endReason === "interrupted" &&
        run.error === null &&
        run.executionKnowledge !== null
      );
    }
    if (run.executionKnowledge !== null) return false;
    if (run.status === "failed") return run.error !== null;
    return run.error === null;
  }),
);

const runSummarySchemaList = v.pipe(
  v.array(runSummarySchema),
  v.check((runs) => new Set(runs.map((run) => run.runId)).size === runs.length),
);

const runPageSchema: v.GenericSchema<RunSummaryPage> = v.pipe(
  v.object({
    items: runSummarySchemaList,
    collectionRevision: revisionSchema,
    nextCursor: v.union([v.null(), idSchema]),
    hasMore: v.boolean(),
  }),
  // A continuation proves there is more; the converse is deliberately not
  // required, because a bounded window inside a snapshot can honestly report
  // `hasMore` with no single cursor that continues it (the runs window is
  // global, and `runs.list` continues one session at a time).
  v.check((page) => page.nextCursor === null || page.hasMore),
);

const collectionRevisionsSchema: v.GenericSchema<CollectionRevisions> = v.object({
  sessions: revisionSchema,
  runs: revisionSchema,
  plugins: revisionSchema,
});

// ---------------------------------------------------------------------------
// Snapshots.
// ---------------------------------------------------------------------------

const watermarkSchema = v.object({ streamId: idSchema, sequence: sequenceSchema });

const hostSnapshotSchema: v.GenericSchema<HostSnapshot> = v.pipe(
  v.object({
    hostInstanceId: idSchema,
    watermark: watermarkSchema,
    storage: storageIdentitySchema,
    collections: collectionRevisionsSchema,
    sessions: sessionPageSchema,
    runs: runPageSchema,
    plugins: v.array(pluginSummarySchema),
  }),
  // What the snapshot can prove about itself, and nothing more. The directory
  // and the run window are each bounded, so a run may legitimately outlive the
  // page its session fell off — but an unfinished run always has its session
  // in the window, because the host includes it, and every pointer that is
  // present has to agree.
  v.check((snapshot) => {
    const sessionIds = new Set(snapshot.sessions.items.map((session) => session.sessionId));
    const pluginIds = new Set(snapshot.plugins.map((plugin) => plugin.id));
    if (pluginIds.size !== snapshot.plugins.length) return false;
    const runIds = new Set(snapshot.runs.items.map((run) => run.runId));
    if (runIds.size !== snapshot.runs.items.length) return false;
    const submissionIds = new Set(snapshot.runs.items.map((run) => run.submissionId));
    if (submissionIds.size !== snapshot.runs.items.length) return false;

    const activeById = new Map<string, RunSummary>();
    for (const run of snapshot.runs.items) {
      if (run.status !== "accepted" && run.status !== "running") continue;
      activeById.set(run.runId, run);
    }

    const pointed = new Set<string>();
    for (const session of snapshot.sessions.items) {
      if (session.activeRunId === null) continue;
      const run = activeById.get(session.activeRunId);
      if (run === undefined) return false;
      if (run.sessionId !== session.sessionId) return false;
      if (pointed.has(run.runId)) return false;
      pointed.add(run.runId);
    }
    for (const runId of activeById.keys()) {
      if (!pointed.has(runId)) return false;
    }
    // A run whose session is in the window must belong to that session.
    for (const run of snapshot.runs.items) {
      if (!sessionIds.has(run.sessionId)) continue;
      const session = snapshot.sessions.items.find((candidate) => candidate.sessionId === run.sessionId);
      if (session === undefined) return false;
    }
    return true;
  }),
);

export {
  activeRunSchema,
  canonicalItemSchema,
  clientCapabilitiesSchema,
  clockSchema,
  collectionRevisionsSchema,
  displayInputSchema,
  finiteNumberSchema,
  generationStringSchema,
  hasNonWhitespaceSchema,
  historyPageSchema,
  hostCapabilitiesSchema,
  hostDescriptionSchema,
  hostLimitsSchema,
  hostSnapshotSchema,
  idSchema,
  JsonValueSchema,
  liveItemSchema,
  liveToolItemSchema,
  logPositionSchema,
  nonEmptyStringSchema,
  nonNegativeSafeIntegerSchema,
  plainJsonObjectSchema,
  plainStringSchema,
  pluginIdSchema,
  pluginSummarySchema,
  positiveSafeIntegerSchema,
  protocolErrorSchema,
  requestIdSchema,
  revisionSchema,
  runPageSchema,
  runSnapshotSchema,
  runSummarySchema,
  sequenceSchema,
  sessionPageSchema,
  sessionSummarySchema,
  storageIdentitySchema,
  terminalRunSchema,
  titleSchema,
  watermarkSchema,
};
