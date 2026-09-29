/**
 * The strict test-only reverse profile.
 *
 * `test.echo` exists nowhere but here: it is not in `OperationMap`, not in a
 * capability, and not reachable from the package index. It exists so the
 * generic mechanism can be driven end to end — a real host, a real frame
 * boundary, and a profile that rejects anything but its own exact shape.
 */

import type { JsonValue } from "@every-dagent/protocol";

import type { ReverseProfile } from "../../src/reverse.js";

export const ECHO_METHOD = "test.echo";

/** A field read that refuses everything a strict JSON object is not. */
function fieldOf(value: JsonValue, key: string): JsonValue | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  // `Object.entries` reads own enumerable data properties of both an object and
  // an array, so a non-object JSON scalar and a list are both refused here.
  for (const [name, field] of Object.entries(value)) {
    if (name === key) return field;
  }
  return undefined;
}

function echoParams(value: JsonValue): { readonly value: string } | undefined {
  const field = fieldOf(value, "value");
  if (typeof field !== "string") return undefined;
  return Object.freeze({ value: field });
}

function echoResult(value: JsonValue): { readonly echoed: string } | undefined {
  const field = fieldOf(value, "echoed");
  if (typeof field !== "string") return undefined;
  return Object.freeze({ echoed: field });
}

/** Params: exactly `{ value: string }`. Result: exactly `{ echoed: string }`. */
export function echoProfile(): ReverseProfile {
  return {
    method: ECHO_METHOD,
    acceptsParams: (params: JsonValue): boolean => echoParams(params) !== undefined,
    acceptsResult: (result: JsonValue): boolean => echoResult(result) !== undefined,
  };
}

/** Reads the echo answer, for assertions. */
export function echoedOf(result: JsonValue): string | undefined {
  return echoResult(result)?.echoed;
}

/** Reads an echo request's value, for a fixture that has to answer one. */
export function echoValueOf(params: JsonValue): string | undefined {
  return echoParams(params)?.value;
}

/** Builds the params of one echo request. */
export function echoParamsOf(value: string): JsonValue {
  return Object.freeze({ value });
}

/** Builds the answer to one echo request. */
export function echoAnswerOf(value: string): JsonValue {
  return Object.freeze({ echoed: value });
}
