/**
 * The operation set v1: exactly the twelve methods frozen by SPEC §8.1 — no
 * settings, no credentials, no `tools.execute`, no plugin install, no
 * arbitrary RPC.
 *
 * `OperationMap` is the single source of truth for both the public TypeScript
 * contract and the runtime schemas: the schemas in this module are keyed by
 * the same literals, and the tests pin the key sets so a schema and its type
 * cannot drift apart.
 */

import * as v from "valibot";

import type {
  HostDescription,
  HostSnapshot,
  Id,
  JsonValue,
  PluginSummary,
  ProtocolError,
  RunSnapshot,
  SessionSnapshot,
  SessionSummary,
} from "./contracts.js";
import {
  clientCapabilitiesSchema,
  generationStringSchema,
  hasNonWhitespaceSchema,
  hostDescriptionSchema,
  hostSnapshotSchema,
  idSchema,
  nonEmptyStringSchema,
  plainJsonObjectSchema,
  pluginSummarySchema,
  protocolErrorSchema,
  runSnapshotSchema,
  sessionSnapshotSchema,
  sessionSummarySchema,
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

// ---------------------------------------------------------------------------
// Envelope bases (internal). The wire never repeats the method on a response.
// ---------------------------------------------------------------------------

interface RequestBase<M extends string, P> {
  readonly kind: "client-request";
  readonly protocolVersion: "1";
  readonly requestId: Id;
  readonly method: M;
  readonly params: P;
}

interface HostResponseBase {
  readonly kind: "host-response";
  readonly protocolVersion: "1";
  readonly hostInstanceId: Id;
  readonly requestId: Id;
}

interface ClientResponseBase {
  readonly kind: "client-response";
  readonly protocolVersion: "1";
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
// Per-method result payloads.
// ---------------------------------------------------------------------------

export interface SessionsListResult {
  readonly sessions: readonly SessionSummary[];
}
export interface SessionResult {
  readonly session: SessionSnapshot;
}
export interface RunResult {
  readonly run: RunSnapshot;
}
export interface PluginsListResult {
  readonly plugins: readonly PluginSummary[];
}
export interface PluginResult {
  readonly plugin: PluginSummary;
}
export interface SubscriptionsOpenResult {
  readonly snapshot: HostSnapshot;
}
export interface SubscriptionsCloseResult {
  readonly closed: boolean;
}

// ---------------------------------------------------------------------------
// The frozen operation map.
// ---------------------------------------------------------------------------

export interface OperationMap {
  "host.describe": { params: DescribeParams; result: HostDescription };
  "sessions.list": { params: EmptyParams; result: SessionsListResult };
  "sessions.create": { params: EmptyParams; result: SessionResult };
  "sessions.get": { params: { readonly sessionId: Id }; result: SessionResult };
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
  "runs.cancel": { params: { readonly runId: Id }; result: RunResult };
  "plugins.list": { params: EmptyParams; result: PluginsListResult };
  "plugins.enable": { params: { readonly pluginId: Id }; result: PluginResult };
  "plugins.disable": { params: { readonly pluginId: Id }; result: PluginResult };
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
  readonly protocolVersion: "1";
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
  "sessions.list": emptyParamsSchema,
  "sessions.create": emptyParamsSchema,
  "sessions.get": v.object({ sessionId: idSchema }),
  "runs.start": v.object({
    sessionId: idSchema,
    submissionId: idSchema,
    text: hasNonWhitespaceSchema,
  }),
  "runs.get": runsGetParamsSchema,
  "runs.cancel": v.object({ runId: idSchema }),
  "plugins.list": emptyParamsSchema,
  "plugins.enable": v.object({ pluginId: idSchema }),
  "plugins.disable": v.object({ pluginId: idSchema }),
  "subscriptions.open": emptyParamsSchema,
  "subscriptions.close": v.object({ streamId: idSchema }),
} as const;

const resultSchemas = {
  "host.describe": hostDescriptionSchema,
  "sessions.list": v.object({ sessions: v.array(sessionSummarySchema) }),
  "sessions.create": v.pipe(
    v.object({ session: sessionSnapshotSchema }),
    // A create result is a brand-new session by definition.
    v.check(
      (value) =>
        value.session.status === "ready" &&
        value.session.activeRunId === null &&
        value.session.canonical.length === 0,
    ),
  ),
  "sessions.get": v.object({ session: sessionSnapshotSchema }),
  "runs.start": v.object({ run: runSnapshotSchema }),
  "runs.get": v.object({ run: runSnapshotSchema }),
  "runs.cancel": v.object({ run: runSnapshotSchema }),
  "plugins.list": v.object({ plugins: v.array(pluginSummarySchema) }),
  "plugins.enable": v.object({ plugin: pluginSummarySchema }),
  "plugins.disable": v.object({ plugin: pluginSummarySchema }),
  "subscriptions.open": v.pipe(
    v.object({ snapshot: hostSnapshotSchema }),
    // The initial watermark always starts the stream at zero.
    v.check((value) => value.snapshot.watermark.sequence === 0),
  ),
  "subscriptions.close": v.object({ closed: v.boolean() }),
} as const;

/**
 * The full v1 response schema for one known method: base envelope plus the
 * result/error XOR. Both fields are known entries, so the `check` sees the
 * pre-strip snapshot and a both-present conflict can never hide.
 */
function responseSchemaFor<const M extends OperationName>(method: M) {
  return v.pipe(
    v.object({
      kind: v.literal("host-response"),
      protocolVersion: v.literal("1"),
      hostInstanceId: idSchema,
      requestId: idSchema,
      result: v.optional(resultSchemas[method]),
      error: v.optional(protocolErrorSchema),
    }),
    v.check((value) => (value.result !== undefined) !== (value.error !== undefined)),
  );
}

/** The error-only response for unknown methods and bootstrap failures. */
const hostErrorResponseSchema = v.object({
  kind: v.literal("host-response"),
  protocolVersion: v.literal("1"),
  hostInstanceId: idSchema,
  requestId: idSchema,
  error: protocolErrorSchema,
  // A success result has no way to travel on this target.
  result: v.optional(v.never()),
});

const requestSchemas = {
  "host.describe": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("1"),
    requestId: idSchema,
    method: v.literal("host.describe"),
    params: paramsSchemas["host.describe"],
    hostInstanceId: v.optional(v.never()),
  }),
  "sessions.list": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("1"),
    requestId: idSchema,
    method: v.literal("sessions.list"),
    params: paramsSchemas["sessions.list"],
    hostInstanceId: idSchema,
  }),
  "sessions.create": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("1"),
    requestId: idSchema,
    method: v.literal("sessions.create"),
    params: paramsSchemas["sessions.create"],
    hostInstanceId: idSchema,
  }),
  "sessions.get": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("1"),
    requestId: idSchema,
    method: v.literal("sessions.get"),
    params: paramsSchemas["sessions.get"],
    hostInstanceId: idSchema,
  }),
  "runs.start": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("1"),
    requestId: idSchema,
    method: v.literal("runs.start"),
    params: paramsSchemas["runs.start"],
    hostInstanceId: idSchema,
  }),
  "runs.get": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("1"),
    requestId: idSchema,
    method: v.literal("runs.get"),
    params: paramsSchemas["runs.get"],
    hostInstanceId: idSchema,
  }),
  "runs.cancel": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("1"),
    requestId: idSchema,
    method: v.literal("runs.cancel"),
    params: paramsSchemas["runs.cancel"],
    hostInstanceId: idSchema,
  }),
  "plugins.list": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("1"),
    requestId: idSchema,
    method: v.literal("plugins.list"),
    params: paramsSchemas["plugins.list"],
    hostInstanceId: idSchema,
  }),
  "plugins.enable": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("1"),
    requestId: idSchema,
    method: v.literal("plugins.enable"),
    params: paramsSchemas["plugins.enable"],
    hostInstanceId: idSchema,
  }),
  "plugins.disable": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("1"),
    requestId: idSchema,
    method: v.literal("plugins.disable"),
    params: paramsSchemas["plugins.disable"],
    hostInstanceId: idSchema,
  }),
  "subscriptions.open": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("1"),
    requestId: idSchema,
    method: v.literal("subscriptions.open"),
    params: paramsSchemas["subscriptions.open"],
    hostInstanceId: idSchema,
  }),
  "subscriptions.close": v.object({
    kind: v.literal("client-request"),
    protocolVersion: v.literal("1"),
    requestId: idSchema,
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
