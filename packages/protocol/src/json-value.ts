/**
 * The strict JSON boundary.
 *
 * The validation library (Valibot) checks *structure* — which fields a DTO
 * has and which union branch applies. It cannot see the things that make a
 * value un-JSON: accessor properties, exotic prototypes, `-0`, `NaN`,
 * `bigint`, symbols, cycles. Those are decided here.
 *
 * There is exactly ONE traversal, and it is descriptor-based end to end:
 * validation and snapshotting happen in the same walk, and every value that
 * enters the snapshot is the `descriptor.value` that was just checked — the
 * walk never reads through `value[name]` / `value[i]`. That closes the
 * injection gap a check-then-re-read design would open: a hostile Proxy can
 * lie about its own descriptors, but it cannot show the guard one value and
 * hand the snapshot another, and a trap that throws anywhere turns into a
 * fixed guard failure instead of a raw exception.
 *
 * This module validates protocol values only. It never projects Core tool
 * inputs — turning an unknown internal value into `DisplayInput` is the
 * Host's job, and doing it here would change what tools were given.
 */

import type { JsonValue } from "./contracts.js";

/** Internal signal for "this value cannot travel the wire". Never escapes. */
const GUARD_FAILURE: unique symbol = Symbol("every-dagent.json-guard-failure");

type GuardResult = { readonly ok: true; readonly snapshot: JsonValue } | { readonly ok: false };

/**
 * Validates `value` and, on success, returns an isolated JSON-safe snapshot —
 * in one pass. Any failure (a non-JSON shape, a cycle, or a Proxy throwing in
 * any reflection step) resolves to `{ ok: false }`; raw exceptions never
 * propagate.
 */
export function guardJsonSnapshot(value: unknown): GuardResult {
  try {
    return { ok: true, snapshot: walk(value, new Set<object>(), new Map<object, JsonValue>()) };
  } catch (error) {
    // Both guard rejections and hostile-Proxy throws collapse into the same
    // fixed outcome; nothing rethrows.
    void error;
    return { ok: false };
  }
}

/** Boolean form of the same single-pass guard. */
export function isStrictJsonValue(value: unknown): boolean {
  return guardJsonSnapshot(value).ok;
}

function walk(
  value: unknown,
  ancestors: Set<object>,
  memo: Map<object, JsonValue>,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    // JSON cannot represent either: `NaN`/`Infinity` stringify as `null`, and
    // `-0` would be read back as `0`, silently changing the sender's value.
    if (!Number.isFinite(value) || Object.is(value, -0)) throw GUARD_FAILURE;
    return value;
  }

  // `undefined`, `bigint`, `function`, `symbol` have no JSON form at all.
  if (typeof value !== "object") throw GUARD_FAILURE;

  // Completed nodes are reused by later references (shared structure stays
  // shared); in-progress nodes are cycles. The ancestor check must come
  // first: a node on the current path is by definition not in the memo yet.
  if (ancestors.has(value)) throw GUARD_FAILURE;
  const memoized = memo.get(value);
  if (memoized !== undefined) return memoized;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return walkArray(value, ancestors, memo);
    return walkObject(value, ancestors, memo);
  } finally {
    ancestors.delete(value);
  }
}

function walkArray(
  array: object,
  ancestors: Set<object>,
  memo: Map<object, JsonValue>,
): JsonValue {
  const proto = Object.getPrototypeOf(array);
  if (proto !== Array.prototype && proto !== null) throw GUARD_FAILURE;
  if (Object.getOwnPropertySymbols(array).length > 0) throw GUARD_FAILURE;

  // The array's declared size comes from its own `length` DESCRIPTOR — never
  // from a `.length` read ([[Get]]). A missing or accessor length is not an
  // array the wire can reproduce.
  const lengthDescriptor = Object.getOwnPropertyDescriptor(array, "length");
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined
  ) {
    throw GUARD_FAILURE;
  }
  const length = lengthDescriptor.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw GUARD_FAILURE;
  }

  const copy: JsonValue[] = [];
  let index = 0;
  for (const name of Object.getOwnPropertyNames(array)) {
    if (name === "length") continue;
    // A dense array's own property names are exactly its canonical indices 0
    // .. length - 1, in order, and nothing else. This is what rejects
    // trailing holes (`x.length = 3`), fully hollow arrays (`new Array(3)`)
    // and stray non-index keys — none of which may be silently truncated.
    if (index >= length || name !== String(index)) throw GUARD_FAILURE;
    copy.push(walk(ownDataValue(array, name), ancestors, memo));
    index++;
  }
  if (index !== length) throw GUARD_FAILURE;

  memo.set(array, copy);
  return copy;
}

function walkObject(
  object: object,
  ancestors: Set<object>,
  memo: Map<object, JsonValue>,
): JsonValue {
  const proto = Object.getPrototypeOf(object);
  if (proto !== Object.prototype && proto !== null) throw GUARD_FAILURE;
  if (Object.getOwnPropertySymbols(object).length > 0) throw GUARD_FAILURE;

  // A null-prototype copy makes every legal JSON key — including a real own
  // `__proto__` — an ordinary data property on assignment instead of the
  // prototype setter.
  const copy: Record<string, JsonValue> = Object.create(null);
  for (const name of Object.getOwnPropertyNames(object)) {
    copy[name] = walk(ownDataValue(object, name), ancestors, memo);
  }

  memo.set(object, copy);
  return copy;
}

/**
 * The single source of every child value: the property's own data descriptor.
 *
 * Accessor properties are rejected outright (reading one could run arbitrary
 * code, and its value would not survive the wire); non-enumerable properties
 * are rejected because `JSON.stringify` would silently drop them; the value
 * itself is taken from `descriptor.value`, so no `[[Get]]` ever happens.
 */
function ownDataValue(owner: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    throw GUARD_FAILURE;
  }
  return descriptor.value;
}
