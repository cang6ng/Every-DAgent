/**
 * The operation set v2: the durable-state and pagination surface frozen by
 * SPEC §14.3, minus the profiles that belong to later milestones.
 *
 * What is here is exactly what this host implements: sessions (list, create,
 * get, history, rename, delete), runs (start, get, list, cancel), plugins
 * (list, enable, disable), settings (get, update) and subscriptions. There is
 * no `tools.execute`, no `runs.resume`, no `approvals.*`, no credential
 * operation, no plugin install and no arbitrary RPC. The approval profiles are
 * declared in the frozen v2 inventory but are not implemented by this
 * milestone, so they are absent rather than stubbed — an unimplemented method
 * answers METHOD_NOT_FOUND, which is the truth. `settings.*` is by namespace,
 * never a key/value store: an update replaces one namespace's whole value
 * against a revision, and there is no way to write an arbitrary key.
 *
 * `OperationMap` is the single source of truth for both the public TypeScript
 * contract and the runtime schemas: the schemas in this module are keyed by
 * the same literals, and the tests pin the key sets so a schema and its type
 * cannot drift apart.
 */

import * as v from "valibot";

import type {
  HistoryPage,
  HostDescription,
  HostSnapshot,
  Id,
  JsonValue,
  PluginSummary,
  ProtocolError,
  Revision,
  RunSnapshot,
  RunSummaryPage,
  SessionSummary,
  SessionSummaryPage,
  SettingsSnapshot,
} from "./contracts.js";
import { MAX_PAGE_ITEMS } from "./contracts.js";
import {
  clientCapabilitiesSchema,
  generationStringSchema,
  hasNonWhitespaceSchema,
  JsonValueSchema,
  historyPageSchema,
  hostDescriptionSchema,
  hostSnapshotSchema,
  idSchema,
  nonEmptyStringSchema,
  plainJsonObjectSchema,
  pluginIdSchema,
  pluginSummarySchema,
  protocolErrorSchema,
  requestIdSchema,
  revisionSchema,
  runPageSchema,
  runSnapshotSchema,
  sessionPageSchema,
  sessionSummarySchema,
  settingsSnapshotSchema,
  titleSchema,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Public DTO shapes that only operations speak (reachable via OperationMap).
// ---------------------------------------------------------------------------

/** `host.describe` params. Note: a describe request carries NO `hostInstanceId`. */
export interface DescribeParams {
  readonly supportedProtocolVersions: readonly string[];
  readonly client: { readonly name: string; readonly version: string };
  readonly capabilities: { readonly reverseRequests: boolean };
}

/** A params object that must carry nothing. */
export type EmptyParams = {
  readonly [key: string]: never;
};

/** One bounded read of a collection: how far, and from where. */
export interface PageParams {
  /** An opaque continuation from the previous page. Absent means "the first page". */
  readonly cursor?: Id;
  /** How many items the caller wants; never more than one page may carry. */
  readonly limit?: number;
}

export interface SessionsListResult {
  readonly sessions: SessionSummaryPage;
}
export interface SessionResult {
  readonly session: SessionSummary;
}
export interface SessionsHistoryResult {
  readonly page: HistoryPage;
}
export interface SessionsDeleteResult {
  readonly sessionId: Id;
  readonly generation: number;
  readonly deleted: true;
}
export interface RunResult {
  readonly run: RunSnapshot;
}
export interface RunsListResult {
  readonly runs: RunSummaryPage;
}
export interface PluginsListResult {
  readonly plugins: readonly PluginSummary[];
}
export interface PluginResult {
  readonly plugin: PluginSummary;
}
export interface SettingsResult {
  readonly settings: SettingsSnapshot;
}
export interface SubscriptionsOpenResult {
  readonly snapshot: HostSnapshot;
}
export interface SubscriptionsCloseResult {
  readonly closed: boolean;
}

// ---------------------------------------------------------------------------
// Envelope bases (internal). The wire never repeats the method on a response.
// ---------------------------------------------------------------------------

interface RequestBase<M extends string, P> {
  readonly kind: "client-request";
  readonly protocolVersion: "2";
  readonly requestId: Id;
  readonly method: M;
  readonly params: P;
}

interface HostResponseBase {
  readonly kind: "host-response";
  readonly protocolVersion: "2";
  readonly hostInstanceId: Id;
  readonly requestId: Id;
}

interface ClientResponseBase {
  readonly kind: "client-response";
  readonly protocolVersion: "2";
  readonly hostInstanceId: Id;
  readonly streamId: Id;
  readonly requestId: Id;
}

/**
 * Exactly one of `result` / `error`. The `?: never` halves make both-present
 * and both-absent uninhabitable at the type level; the runtime check enforces
 * the same XOR on the snapshot before any field is stripped.
 */
type SuccessBody<T> = { readonly result: T; readonly error?: never };
type FailureBody = { readonly error: ProtocolError; readonly result?: never };
type ResponseXor<T> = SuccessBody<T> | FailureBody;

/**
 * The error-only response used to answer unknown methods and bootstrap
 * failures. Kept internal on purpose (it is the input type of the methodless
 * `host-response` encoding path); callers construct it structurally.
 */
export type HostErrorResponse = HostResponseBase & FailureBody;

// ---------------------------------------------------------------------------
// The frozen operation map.
// ---------------------------------------------------------------------------

export interface OperationMap {
  "host.describe": { params: DescribeParams; result: HostDescription };
  "sessions.list": { params: PageParams; result: SessionsListResult };
  "sessions.create": { params: EmptyParams; result: SessionResult };
  "sessions.get": { params: { readonly sessionId: Id }; result: SessionResult };
  "sessions.history": {
    params: { readonly sessionId: Id; readonly cursor?: Id; readonly limit?: number };
    result: SessionsHistoryResult;
  };
  "sessions.rename": {
    params: { readonly sessionId: Id; readonly expectedRevision: Revision; readonly title: string };
    result: SessionResult;
  };
  "sessions.delete": {
    params: { readonly sessionId: Id; readonly expectedRevision: Revision };
    result: SessionsDeleteResult;
  };
  "runs.start": {
    params: { readonly sessionId: Id; readonly submissionId: Id; readonly text: string };
    result: RunResult;
  };
  "runs.get": {
    params:
      | { readonly runId: Id; readonly submissionId?: never }
      | { readonly submissionId: Id; readonly runId?: never };
    result: RunResult;
  };
  "runs.list": {
    params: { readonly sessionId: Id; readonly cursor?: Id; readonly limit?: number };
    result: RunsListResult;
  };
  "runs.cancel": { params: { readonly runId: Id }; result: RunResult };
  "plugins.list": { params: EmptyParams; result: PluginsListResult };
  "plugins.enable": { params: { readonly pluginId: Id }; result: PluginResult };
  "plugins.disable": { params: { readonly pluginId: Id }; result: PluginResult };
  "settings.get": { params: { readonly namespace: Id }; result: SettingsResult };
  "settings.update": {
    params: {
      readonly namespace: Id;
      readonly expectedRevision: Revision;
      /** The full replacement value; a namespace is replaced, never patched. */
      readonly value: JsonValue;
    };
    result: SettingsResult;
  };
  "subscriptions.open": { params: EmptyParams; result: SubscriptionsOpenResult };
  "subscriptions.close": { params: { readonly streamId: Id }; result: SubscriptionsCloseResult };
}

export type OperationName = keyof OperationMap;

export type ClientRequestFor<M extends OperationName> = RequestBase<
  M,
  OperationMap[M]["params"]
> &
  (M extends "host.describe"
    ? // The bootstrap must NOT carry an instance id: there is no instance yet.
      { readonly hostInstanceId?: never }
    : // Every other request carries the id `host.describe` returned.
      { readonly hostInstanceId: Id });

export type ClientRequest = {
  [M in OperationName]: ClientRequestFor<M>;
}[OperationName];

export type HostResponse<M extends OperationName> = HostResponseBase &
  ResponseXor<OperationMap[M]["result"]>;

export type HostRequest = {
  readonly kind: "host-request";
  readonly protocolVersion: "2";
  readonly requestId: Id;
  /** Any string: an unknown reverse method is answered METHOD_NOT_FOUND, never ignored. */
  readonly method: string;
  readonly params: JsonValue;
  readonly hostInstanceId: Id;
  readonly streamId: Id;
  readonly timeoutMs: number;
};

export type ClientResponse<R = JsonValue> = ClientResponseBase & ResponseXor<R>;

// ---------------------------------------------------------------------------
// Runtime schemas (internal). Keyed by exactly the OperationName literals.
// ---------------------------------------------------------------------------

const emptyParamsSchema = v.pipe(
  // The raw guard runs before stripping: `v.object({})` alone would accept an
  // array and launder it into a fresh empty object.
  plainJsonObjectSchema,
  v.object({}),
);

/**
 * A bounded page request: an optional continuation and an optional size.
 *
 * The size is capped here rather than clamped, because a page larger than
 * `MAX_PAGE_ITEMS` is not something this protocol can express — and silently
 * shrinking it would answer a different question than the one asked.
 */
const pageParamsEntries = {
  cursor: v.optional(idSchema),
  limit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(MAX_PAGE_ITEMS))),
} as const;

const pageParamsSchema = v.pipe(
  plainJsonObjectSchema,
  v.object(pageParamsEntries),
);

const runsGetParamsSchema = v.pipe(
  v.object({
    runId: v.optional(idSchema),
    submissionId: v.optional(idSchema),
  }),
  // Exactly one selector. Checked on the snapshot before anything is stripped:
  // both fields are known, so stripping could never hide the conflict.
  v.check((value) => (value.runId !== undefined) !== (value.submissionId !== undefined)),
);

const describeParamsSchema = v.pipe(
  v.pipe(
    plainJsonObjectSchema,
    v.object({
      supportedProtocolVersions: v.pipe(
        v.array(generationStringSchema),
        v.check((versions) => versions.length > 0),
        v.check((versions) => new Set(versions).size === versions.length),
      ),
      client: v.object({ name: nonEmptyStringSchema, version: nonEmptyStringSchema }),
      capabilities: clientCapabilitiesSchema,
      // Present-but-populated is rejected by `v.never` (the JSON guard already
      // ruled out `undefined` values, so absence is the only way past).
      hostInstanceId: v.optional(v.never()),
    }),
  ),
);

const paramsSchemas = {
  "host.describe": describeParamsSchema,
  "sessions.list": pageParamsSchema,
  "sessions.create": emptyParamsSchema,
  "sessions.get": v.object({ sessionId: idSchema }),
  "sessions.history": v.pipe(
    v.object({ sessionId: idSchema, ...pageParamsEntries }),
  ),
  "sessions.rename": v.object({
    sessionId: idSchema,
    expectedRevision: revisionSchema,
    title: titleSchema,
  }),
  "sessions.delete": v.object({ sessionId: idSchema, expectedRevision: revisionSchema }),
  "runs.start": v.object({
    sessionId: idSchema,
    submissionId: idSchema,
    text: hasNonWhitespaceSchema,
  }),
  "runs.get": runsGetParamsSchema,
  "runs.list": v.object({ sessionId: idSchema, ...pageParamsEntries }),
  "runs.cancel": v.object({ runId: idSchema }),
  "plugins.list": emptyParamsSchema,
  "plugins.enable": v.object({ pluginId: pluginIdSchema }),
  "plugins.disable": v.object({ pluginId: pluginIdSchema }),
  "settings.get": v.object({ namespace: idSchema }),
  "settings.update": v.object({
    namespace: idSchema,
    expectedRevision: revisionSchema,
    // The protocol checks that this *is* a JSON value; what a value may mean is
    // the host's own schema, and a mismatch there is SETTINGS_INVALID.
    value: JsonValueSchema,
  }),
  "subscriptions.open": emptyParamsSchema,
  "subscriptions.close": v.object({ streamId: idSchema }),
} as const;

const resultSchemas = {
  "host.describe": hostDescriptionSchema,
  "sessions.list": v.object({ sessions: sessionPageSchema }),
  "sessions.create": v.pipe(
    v.object({ session: sessionSummarySchema }),
    // A create result is a brand-new session by definition: no history, no run,
    // and nothing blocking it.
    v.check(
      (value) =>
        value.session.status === "ready" &&
        value.session.activeRunId === null &&
        value.session.committedSeq === 0 &&
        value.session.historyRevision === 0 &&
        value.session.generation === 1,
    ),
  ),
  "sessions.get": v.object({ session: sessionSummarySchema }),
  "sessions.history": v.object({ page: historyPageSchema }),
  "sessions.rename": v.object({ session: sessionSummarySchema }),
  "sessions.delete": v.pipe(
    v.object({
      sessionId: idSchema,
      generation: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
      deleted: v.literal(true),
    }),
  ),
  "runs.start": v.object({ run: runSnapshotSchema }),
  "runs.get": v.object({ run: runSnapshotSchema }),
  "runs.list": v.object({ runs: runPageSchema }),
  "runs.cancel": v.object({ run: runSnapshotSchema }),
  "plugins.list": v.object({ plugins: v.array(pluginSummarySchema) }),
  "plugins.enable": v.object({ plugin: pluginSummarySchema }),
  "plugins.disable": v.object({ plugin: pluginSummarySchema }),
  "settings.get": v.object({ settings: settingsSnapshotSchema }),
  "settings.update": v.object({ settings: settingsSnapshotSchema }),
  "subscriptions.open": v.pipe(
    v.object({ snapshot: hostSnapshotSchema }),
    // The initial watermark always starts the stream at zero.
    v.check((value) => value.snapshot.watermark.sequence === 0),
  ),
  "subscriptions.close": v.object({ closed: v.boolean() }),
} as const;

/**
 * The full v2 response schema for one known method: base envelope plus the
 * result/error XOR. Both fields are known entries, so the `check` sees the
 * pre-strip snapshot and a both-present conflict can never hide.
 */
function responseSchemaFor<const M extends OperationName>(method: M) {
  return v.pipe(
    v.object({
      kind: v.literal("host-response"),
      protocolVersion: v.literal("2"),
      hostInstanceId: idSchema,
      requestId: requestIdSchema,
      result: v.optional(resultSchemas[method]),
      error: v.optional(protocolErrorSchema),
    }),
    v.check((value) => (value.result !== undefined) !== (value.error !== undefined)),
  );
}

/** The error-only response for unknown methods and bootstrap failures. */
const hostErrorResponseSchema = v.object({
  kind: v.literal("host-response"),
  protocolVersion: v.literal("2"),
  hostInstanceId: idSchema,
  requestId: requestIdSchema,
  error: protocolErrorSchema,
  // A success result has no way to travel on this target.
  result: v.optional(v.never()),
});

const requestSchemas = {
  "host.describe": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("host.describe"),
    params: paramsSchemas["host.describe"],
    hostInstanceId: v.optional(v.never()),
  }),
  "sessions.list": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("sessions.list"),
    params: paramsSchemas["sessions.list"],
    hostInstanceId: idSchema,
  }),
  "sessions.create": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("sessions.create"),
    params: paramsSchemas["sessions.create"],
    hostInstanceId: idSchema,
  }),
  "sessions.get": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("sessions.get"),
    params: paramsSchemas["sessions.get"],
    hostInstanceId: idSchema,
  }),
  "sessions.history": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("sessions.history"),
    params: paramsSchemas["sessions.history"],
    hostInstanceId: idSchema,
  }),
  "sessions.rename": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("sessions.rename"),
    params: paramsSchemas["sessions.rename"],
    hostInstanceId: idSchema,
  }),
  "sessions.delete": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("sessions.delete"),
    params: paramsSchemas["sessions.delete"],
    hostInstanceId: idSchema,
  }),
  "runs.start": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("runs.start"),
    params: paramsSchemas["runs.start"],
    hostInstanceId: idSchema,
  }),
  "runs.get": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("runs.get"),
    params: paramsSchemas["runs.get"],
    hostInstanceId: idSchema,
  }),
  "runs.list": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("runs.list"),
    params: paramsSchemas["runs.list"],
    hostInstanceId: idSchema,
  }),
  "runs.cancel": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("runs.cancel"),
    params: paramsSchemas["runs.cancel"],
    hostInstanceId: idSchema,
  }),
  "plugins.list": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("plugins.list"),
    params: paramsSchemas["plugins.list"],
    hostInstanceId: idSchema,
  }),
  "plugins.enable": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("plugins.enable"),
    params: paramsSchemas["plugins.enable"],
    hostInstanceId: idSchema,
  }),
  "plugins.disable": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("plugins.disable"),
    params: paramsSchemas["plugins.disable"],
    hostInstanceId: idSchema,
  }),
  "settings.get": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("settings.get"),
    params: paramsSchemas["settings.get"],
    hostInstanceId: idSchema,
  }),
  "settings.update": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("settings.update"),
    params: paramsSchemas["settings.update"],
    hostInstanceId: idSchema,
  }),
  "subscriptions.open": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("subscriptions.open"),
    params: paramsSchemas["subscriptions.open"],
    hostInstanceId: idSchema,
  }),
  "subscriptions.close": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("2"),
    requestId: requestIdSchema,
    method: v.literal("subscriptions.close"),
    params: paramsSchemas["subscriptions.close"],
    hostInstanceId: idSchema,
  }),
} as const;

const clientRequestSchema = v.variant("method", Object.values(requestSchemas));

type ParamSchemas = typeof paramsSchemas;
type ResultSchemas = typeof resultSchemas;
type RequestSchemas = typeof requestSchemas;
// Compile-time exactness: the schema maps and the public map must have the
// same key sets, in both directions, or the build stops here.
type _ExactKeys<A extends PropertyKey, B extends PropertyKey> =
  [Exclude<A, B>] extends [never] ? ([Exclude<B, A>] extends [never] ? true : never) : never;
const _paramsExact: _ExactKeys<keyof ParamSchemas, OperationName> = true;
const _resultsExact: _ExactKeys<keyof ResultSchemas, OperationName> = true;
const _requestsExact: _ExactKeys<keyof RequestSchemas, OperationName> = true;
void _paramsExact;
void _resultsExact;
void _requestsExact;

export {
  clientRequestSchema,
  hostErrorResponseSchema,
  paramsSchemas,
  requestSchemas,
  responseSchemaFor,
  resultSchemas,
};
