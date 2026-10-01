/**
 * The stateless validation entry points.
 *
 * Every call follows the same fixed order (SPEC §5 / Master Plan):
 *
 *   raw value → strict JSON guard → isolated snapshot
 *     → version gate → exact v2 schema → cross-field checks
 *
 * Failures carry a fixed local reason — never library issues, never raw
 * input, never exception text — plus, for request-shaped messages, the
 * smallest safely-extractable correlation so the upper layer can still answer
 * INVALID_REQUEST instead of dropping the frame. A correlation says "these
 * fields are trustworthy", nothing more: whether a reply is permitted and
 * where it goes is connection state, owned by the future Host/Client.
 */

import * as v from "valibot";

import type { Id, JsonValue } from "./contracts.js";
import { guardJsonSnapshot } from "./json-value.js";
import {
  clientRequestSchema,
  hostErrorResponseSchema,
  requestSchemas,
  responseSchemaFor,
  type OperationName,
  type ClientRequest,
  type ClientResponse,
  type HostErrorResponse,
  type HostRequest,
  type HostResponse,
} from "./operations.js";
import { eventSchemas, hostEventSchema, type HostEvent } from "./events.js";
import {
  idSchema,
  JsonValueSchema,
  positiveSafeIntegerSchema,
  protocolErrorSchema,
} from "./schemas.js";
import { PROTOCOL_VERSION } from "./contracts.js";

/** Fixed, local validation outcomes. These never appear on the wire. */
export type ValidationFailureReason =
  | "INVALID_JSON"
  | "NON_JSON_VALUE"
  | "INVALID_ENVELOPE"
  | "UNSUPPORTED_PROTOCOL"
  | "UNKNOWN_METHOD"
  | "UNKNOWN_EVENT"
  | "INVALID_MESSAGE"
  | "INVALID_TARGET"
  | "FRAME_TOO_LARGE";

/**
 * Request-direction correlation extracted only after the JSON guard and
 * snapshot succeeded. It exists so `INVALID_REQUEST` can still be routed;
 * it is not a claim that the message was otherwise valid.
 */
export type RequestCorrelation = {
  readonly kind: "client-request" | "host-request";
  readonly requestId: Id;
};

export interface ValidationFailure {
  readonly reason: ValidationFailureReason;
  readonly correlation?: RequestCorrelation;
}

export type ValidationResult<T> =
  | { readonly success: true; readonly output: T }
  | { readonly success: false; readonly failure: ValidationFailure };

/**
 * Which validator to run. A closed local selector — not a wire field.
 *
 * The methodless `host-response` target accepts only the error-only response
 * (the path that answers unknown methods and bootstrap failures); a method
 * present but not in `OperationMap` is an invalid target, never silently
 * downgraded.
 */
export type ValidationTarget =
  | { readonly kind: "client-request" }
  | { readonly kind: "host-request" }
  | { readonly kind: "client-response" }
  | { readonly kind: "host-event" }
  | { readonly kind: "host-response"; readonly method: OperationName }
  | { readonly kind: "host-response"; readonly method?: never };

const failure = (reason: ValidationFailureReason): ValidationResult<never> => ({
  success: false,
  failure: { reason },
});

const GENERATION_PATTERN = /^[1-9][0-9]*$/;

/**
 * The v2 host-request envelope. The method stays a plain string and params a
 * full `JsonValue`: an unknown reverse method is a valid envelope that the
 * Client answers with METHOD_NOT_FOUND — the production reverse business
 * registry is empty, and it is the Client's dispatch (P3.3), not validation,
 * that decides that.
 */
const hostRequestSchema = v.object({
  kind: v.literal("host-request"),
  protocolVersion: v.literal("2"),
  requestId: idSchema,
  method: v.string(),
  params: JsonValueSchema,
  hostInstanceId: idSchema,
  streamId: idSchema,
  timeoutMs: positiveSafeIntegerSchema,
});

/** The v2 client-response envelope: correlation ids, plus the result/error XOR. */
const clientResponseSchema = v.pipe(
  v.object({
    kind: v.literal("client-response"),
    protocolVersion: v.literal("2"),
    hostInstanceId: idSchema,
    streamId: idSchema,
    requestId: idSchema,
    result: v.optional(JsonValueSchema),
    error: v.optional(protocolErrorSchema),
  }),
  v.check((value) => (value.result !== undefined) !== (value.error !== undefined)),
);

/**
 * Guards and isolates `input`, returning the snapshot to validate. Every
 * downstream schema sees only this snapshot: published DTOs can never reach
 * back into the caller's objects.
 */
function guardedSnapshot(input: unknown): { ok: true; snapshot: JsonValue } | { ok: false } {
  if (typeof input !== "object") return { ok: false };
  return guardJsonSnapshot(input);
}

/**
 * The smallest safely-readable request correlation: kind plus non-empty
 * requestId, both read from the isolated snapshot's own data properties.
 * Nothing else (no method, no params) ever travels in a failure.
 */
function correlationOf(snapshot: JsonValue): RequestCorrelation | undefined {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return undefined;
  const record = snapshot as Record<string, JsonValue>;
  const kind = record["kind"];
  if (kind !== "client-request" && kind !== "host-request") return undefined;
  const requestId = record["requestId"];
  if (typeof requestId !== "string" || requestId.length === 0) return undefined;
  return { kind, requestId };
}

/**
 * v2 generation gate. The current generation proceeds; another well-formed one stops
 * with UNSUPPORTED_PROTOCOL (so the upper layer can answer it); a malformed
 * version string is just an invalid message.
 */
function versionGate(snapshot: JsonValue): { reason: ValidationFailureReason } | undefined {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return { reason: "INVALID_ENVELOPE" };
  }
  const version = (snapshot as Record<string, JsonValue>)["protocolVersion"];
  if (typeof version !== "string") return { reason: "INVALID_ENVELOPE" };
  if (version === PROTOCOL_VERSION) return undefined;
  return { reason: GENERATION_PATTERN.test(version) ? "UNSUPPORTED_PROTOCOL" : "INVALID_MESSAGE" };
}

/**
 * The core validator: one union-typed entry the overloads below delegate to.
 * Internal — callers use the overloaded `validateMessage`, and `codec.ts`
 * reuses this for `encodeFrame`.
 */
export function validateMessageCore(target: ValidationTarget, input: unknown): ValidationResult<ClientRequest | HostRequest | ClientResponse | HostEvent | HostResponse<OperationName> | HostErrorResponse> {
  if (typeof target !== "object" || target === null) return failure("INVALID_TARGET");
  const kind = (target as { kind?: unknown }).kind;
  if (
    kind !== "client-request" &&
    kind !== "host-request" &&
    kind !== "client-response" &&
    kind !== "host-event" &&
    kind !== "host-response"
  ) {
    return failure("INVALID_TARGET");
  }
  if (kind === "host-response") {
    const method = (target as { method?: unknown }).method;
    // Own-key check: `in` would hit Object.prototype and let "constructor" or
    // "toString" masquerade as a real operation selector.
    if (method !== undefined && !(typeof method === "string" && Object.hasOwn(requestSchemas, method))) {
      // A selector naming an unknown method is a caller bug: it must not be
      // quietly treated as the methodless error path.
      return failure("INVALID_TARGET");
    }
  }

  const guarded = guardedSnapshot(input);
  if (!guarded.ok) return failure("NON_JSON_VALUE");
  const snapshot = guarded.snapshot;
  const correlation = correlationOf(snapshot);

  const run = <T>(schema: v.GenericSchema<T>): ValidationResult<T> => {
    const parsed = v.safeParse(schema, snapshot);
    if (!parsed.success) return { success: false, failure: { reason: "INVALID_MESSAGE", ...(correlation === undefined ? {} : { correlation }) } };
    return { success: true, output: parsed.output };
  };

  const versionFailure = versionGate(snapshot);
  if (versionFailure !== undefined) {
    return {
      success: false,
      failure: { reason: versionFailure.reason, ...(correlation === undefined ? {} : { correlation }) },
    };
  }
  switch (kind) {
    case "client-request": {
      if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
        return failure("INVALID_ENVELOPE");
      }
      const method = (snapshot as Record<string, JsonValue>)["method"];
      // Own-key check — see the host-response selector above.
      if (typeof method !== "string" || !Object.hasOwn(requestSchemas, method)) {
        return {
          success: false,
          failure: { reason: "UNKNOWN_METHOD", ...(correlation === undefined ? {} : { correlation }) },
        };
      }
      return run(clientRequestSchema) as ValidationResult<ClientRequest>;
    }
    case "host-request":
      return run(hostRequestSchema) as ValidationResult<HostRequest>;
    case "client-response":
      return run(clientResponseSchema) as ValidationResult<ClientResponse>;
    case "host-event": {
      if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
        return failure("INVALID_ENVELOPE");
      }
      const type = (snapshot as Record<string, JsonValue>)["type"];
      // Own-key check — `in` would accept "toString" as an event type.
      if (typeof type !== "string" || !Object.hasOwn(eventSchemas, type)) {
        return { success: false, failure: { reason: "UNKNOWN_EVENT" } };
      }
      return run(hostEventSchema) as ValidationResult<HostEvent>;
    }
    case "host-response": {
      const method = (target as { method?: unknown }).method as OperationName | undefined;
      if (method === undefined) return run(hostErrorResponseSchema) as ValidationResult<HostErrorResponse>;
      return run(responseSchemaFor(method)) as ValidationResult<HostResponse<OperationName>>;
    }
  }
}

/** Validates that `input` is a strict `JsonValue`, returning an isolated snapshot. */
export function validateJsonValue(input: unknown): ValidationResult<JsonValue> {
  const guarded = guardJsonSnapshot(input);
  if (!guarded.ok) return failure("NON_JSON_VALUE");
  return { success: true, output: guarded.snapshot };
}

/**
 * Validates one message against the frozen v2 contract. Overloads keep the
 * target and the validated type tied together; an unknown method selector on
 * a `host-response` target is a compile-time and runtime error, not a silent
 * downgrade.
 */
export function validateMessage(target: { readonly kind: "client-request" }, input: unknown): ValidationResult<ClientRequest>;
export function validateMessage(target: { readonly kind: "host-request" }, input: unknown): ValidationResult<HostRequest>;
export function validateMessage(target: { readonly kind: "client-response" }, input: unknown): ValidationResult<ClientResponse>;
export function validateMessage(target: { readonly kind: "host-event" }, input: unknown): ValidationResult<HostEvent>;
export function validateMessage<M extends OperationName>(
  target: { readonly kind: "host-response"; readonly method: M },
  input: unknown,
): ValidationResult<HostResponse<M>>;
export function validateMessage(
  target: { readonly kind: "host-response"; readonly method?: never },
  input: unknown,
): ValidationResult<HostErrorResponse>;
export function validateMessage(target: ValidationTarget, input: unknown): ReturnType<typeof validateMessageCore> {
  return validateMessageCore(target, input);
}
