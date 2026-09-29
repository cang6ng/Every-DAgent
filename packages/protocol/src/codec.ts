/**
 * Frame codec: string in, validated contract out — and the reverse.
 *
 * `decodeFrame` is deliberately only the *base* layer: JSON parse, strict
 * JSON check, generic envelope and the result/error XOR. It must be able to
 * recognize an unknown method or an unsupported generation as a well-formed
 * envelope, because the upper layer has to answer those with a proper error
 * instead of dropping the frame. Full v1 semantics live in
 * `validateMessage`; only a `validateMessage` output is a contract message.
 *
 * `encodeFrame` re-runs the full validation before serializing: a TypeScript
 * parameter type is never accepted as proof that a value is wire-safe.
 */

import * as v from "valibot";

import type { Id, JsonValue } from "./contracts.js";
import { guardJsonSnapshot, isStrictJsonValue } from "./json-value.js";
import { idSchema } from "./schemas.js";
import {
  validateMessageCore,
  type RequestCorrelation,
  type ValidationFailureReason,
  type ValidationTarget,
} from "./validation.js";
import type {
  ClientRequest,
  ClientResponse,
  HostErrorResponse,
  HostRequest,
  HostResponse,
  OperationName,
} from "./operations.js";
import type { HostEvent } from "./events.js";

/** A decoded error is only loosely shaped: full `ProtocolError` checks happen in v1 validation. */
interface DecodedError {
  readonly code: string;
  readonly message: string;
}

type DecodedResponseXor =
  | { readonly result: JsonValue; readonly error?: never }
  | { readonly error: DecodedError; readonly result?: never };

/**
 * What `decodeFrame` hands back: the base envelope of one message, stripped
 * of nothing, aware of nothing beyond its shape. Not a v1 contract message.
 */
export type DecodedEnvelope =
  | {
      readonly kind: "client-request";
      readonly protocolVersion: string;
      readonly requestId: Id;
      readonly method: string;
      readonly params: JsonValue;
      readonly hostInstanceId?: Id;
    }
  | ({
      readonly kind: "host-response";
      readonly protocolVersion: string;
      readonly requestId: Id;
      readonly hostInstanceId: Id;
    } & DecodedResponseXor)
  | ({
      readonly kind: "client-response";
      readonly protocolVersion: string;
      readonly requestId: Id;
      readonly hostInstanceId: Id;
      readonly streamId: Id;
    } & DecodedResponseXor)
  | {
      readonly kind: "host-event";
      readonly protocolVersion: string;
      readonly hostInstanceId: Id;
      readonly streamId: Id;
      readonly sequence: number;
      readonly scope: JsonValue;
      readonly type: string;
      readonly payload: JsonValue;
    }
  | {
      readonly kind: "host-request";
      readonly protocolVersion: string;
      readonly requestId: Id;
      readonly method: string;
      readonly params: JsonValue;
      readonly hostInstanceId: Id;
      readonly streamId: Id;
      readonly timeoutMs: number;
    };

const failure = (reason: ValidationFailureReason) => ({ success: false as const, failure: { reason } });

// Base envelope schemas. `protocolVersion` must be a well-formed generation
// string so an unknown-but-legal generation survives to the version gate;
// events keep their sequence unclamped (0 is rejected in v1 validation).
const generationStringSchema = v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/));
const baseEntries = { protocolVersion: generationStringSchema } as const;

const looseErrorSchema = v.object({ code: v.string(), message: v.string() });

const JsonValueLoose: v.GenericSchema<JsonValue> = v.custom<JsonValue>(isStrictJsonValue);

const decodeSchemas = {
  "client-request": v.object({
    kind: v.literal("client-request"),
    ...baseEntries,
    requestId: idSchema,
    method: v.string(),
    params: JsonValueLoose,
    hostInstanceId: v.optional(idSchema),
  }),
  "host-response": v.pipe(
    v.object({
      kind: v.literal("host-response"),
      ...baseEntries,
      requestId: idSchema,
      hostInstanceId: idSchema,
      result: v.optional(JsonValueLoose),
      error: v.optional(looseErrorSchema),
    }),
    v.check((value) => (value.result !== undefined) !== (value.error !== undefined)),
  ),
  "client-response": v.pipe(
    v.object({
      kind: v.literal("client-response"),
      ...baseEntries,
      requestId: idSchema,
      hostInstanceId: idSchema,
      streamId: idSchema,
      result: v.optional(JsonValueLoose),
      error: v.optional(looseErrorSchema),
    }),
    v.check((value) => (value.result !== undefined) !== (value.error !== undefined)),
  ),
  "host-event": v.object({
    kind: v.literal("host-event"),
    ...baseEntries,
    hostInstanceId: idSchema,
    streamId: idSchema,
    sequence: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    scope: JsonValueLoose,
    type: v.string(),
    payload: JsonValueLoose,
  }),
  "host-request": v.object({
    kind: v.literal("host-request"),
    ...baseEntries,
    requestId: idSchema,
    method: v.string(),
    params: JsonValueLoose,
    hostInstanceId: idSchema,
    streamId: idSchema,
    timeoutMs: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  }),
} as const;

const KINDS = ["client-request", "host-response", "client-response", "host-event", "host-request"] as const;
type DecodedKind = (typeof KINDS)[number];

/**
 * Decodes one wire frame into its base envelope.
 *
 * On failure the reason is fixed and local. For request-direction frames a
 * safely-extractable correlation may be present so the upper layer can still
 * answer INVALID_REQUEST; correlation is never recovered from a frame that
 * failed to parse, and never includes method, params or raw input.
 */
export function decodeFrame(frame: string): { success: true; output: DecodedEnvelope } | { success: false; failure: { reason: ValidationFailureReason; correlation?: { kind: "client-request" | "host-request"; requestId: Id } } } {
  if (typeof frame !== "string") return failure("INVALID_JSON");

  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return failure("INVALID_JSON");
  }
  if (typeof parsed !== "object" || parsed === null) return failure("INVALID_ENVELOPE");

  // `JSON.parse` can still produce non-JSON values: `1e999` becomes
  // `Infinity`, `[-0]` keeps its sign, and a literal `-0` survives. The
  // single-pass guard is what makes the wire boundary honest, not the parser.
  const guarded = guardJsonSnapshot(parsed);
  if (!guarded.ok) return failure("NON_JSON_VALUE");
  const snapshot = guarded.snapshot;

  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return failure("INVALID_ENVELOPE");
  }
  const kind = (snapshot as Record<string, JsonValue>)["kind"];
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    return failure("INVALID_ENVELOPE");
  }

  const correlation = correlationOf(kind, snapshot);

  const schema = decodeSchemas[kind as DecodedKind];
  const parsedEnvelope = v.safeParse(schema, snapshot);
  if (!parsedEnvelope.success) {
    return {
      success: false,
      failure: { reason: "INVALID_ENVELOPE", ...(correlation === undefined ? {} : { correlation }) },
    };
  }

  return { success: true, output: parsedEnvelope.output as DecodedEnvelope };
}

/**
 * The smallest safely-readable request correlation, shared with
 * `validateMessage`: kind plus non-empty requestId from own data properties
 * of the isolated snapshot.
 */
function correlationOf(
  kind: string,
  snapshot: JsonValue,
): { kind: "client-request" | "host-request"; requestId: Id } | undefined {
  if (kind !== "client-request" && kind !== "host-request") return undefined;
  if (typeof snapshot !== "object" || snapshot === null) return undefined;
  const requestId = (snapshot as Record<string, JsonValue>)["requestId"];
  if (typeof requestId !== "string" || requestId.length === 0) return undefined;
  return { kind, requestId };
}

/** One encode attempt's outcome. */
type EncodeFrameResult = {
  success: true;
  output: string;
} | {
  success: false;
  failure: { reason: ValidationFailureReason; correlation?: RequestCorrelation };
};

/**
 * Validates a message against the frozen v1 contract and serializes the
 * validated output.
 *
 * The `host-response` overloads are enumerated per method on purpose: the
 * target's method and the message's response type are correlated pair by
 * pair, so `encodeFrame({ kind: "host-response", method: "runs.get" }, some
 * HostResponse<"sessions.list">)` is a compile error — a generic `<M>`
 * overload would let inference widen the pair and defer the mismatch to
 * runtime. A union-typed target matches none of the overloads and must be
 * narrowed first. The methodless overload still takes only the error-only
 * response (the unknown-method / bootstrap path).
 */
export function encodeFrame(target: { readonly kind: "client-request" }, message: ClientRequest): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-request" }, message: HostRequest): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "client-response" }, message: ClientResponse): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-event" }, message: HostEvent): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-response"; readonly method: "host.describe" }, message: HostResponse<"host.describe">): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-response"; readonly method: "sessions.list" }, message: HostResponse<"sessions.list">): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-response"; readonly method: "sessions.create" }, message: HostResponse<"sessions.create">): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-response"; readonly method: "sessions.get" }, message: HostResponse<"sessions.get">): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-response"; readonly method: "runs.start" }, message: HostResponse<"runs.start">): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-response"; readonly method: "runs.get" }, message: HostResponse<"runs.get">): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-response"; readonly method: "runs.cancel" }, message: HostResponse<"runs.cancel">): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-response"; readonly method: "plugins.list" }, message: HostResponse<"plugins.list">): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-response"; readonly method: "plugins.enable" }, message: HostResponse<"plugins.enable">): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-response"; readonly method: "plugins.disable" }, message: HostResponse<"plugins.disable">): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-response"; readonly method: "subscriptions.open" }, message: HostResponse<"subscriptions.open">): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-response"; readonly method: "subscriptions.close" }, message: HostResponse<"subscriptions.close">): EncodeFrameResult;
export function encodeFrame(target: { readonly kind: "host-response"; readonly method?: never }, message: HostErrorResponse): EncodeFrameResult;
export function encodeFrame(target: ValidationTarget, message: unknown): EncodeFrameResult {
  const validated = validateMessageCore(target, message);
  if (!validated.success) return validated;
  try {
    return { success: true, output: JSON.stringify(validated.output) };
  } catch {
    // Unreachable for guarded snapshots; kept as the honest terminal state.
    return failure("INVALID_MESSAGE");
  }
}
