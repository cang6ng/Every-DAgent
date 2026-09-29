/**
 * The strict JSON boundary.
 *
 * The validation library (Valibot) checks *structure* — which fields a DTO
 * has and which union branch applies. It cannot see the things that make a
 * value un-JSON: accessor properties, exotic prototypes, `-0`, `NaN`,
 * `bigint`, symbols, cycles. Those are decided here, before any schema runs
 * and before anything is serialized, because a stripped or stringified value
 * can no longer prove what the sender actually held.
 *
 * This module validates protocol values only. It never projects Core tool
 * inputs — turning an unknown internal value into `DisplayInput` is the
 * Host's job, and doing it here would change what tools were given.
 */

import type { JsonValue } from "./contracts.js";

/**
 * Whether `value` can travel the wire losslessly.
 *
 * Never throws, never reads through getters, never calls `toJSON`: every
 * property is inspected through its own descriptor. A hostile in-process
 * Proxy can still lie or throw — the `try/catch` turns that into "not
 * JSON-safe", which is honest: this is a value check, not a sandbox.
 */
export function isStrictJsonValue(value: unknown): boolean {
  try {
    return check(value, new Set());
  } catch {
    return false;
  }
}

function check(value: unknown, ancestors: Set<object>): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value === "number") {
    // JSON cannot represent either: `NaN`/`Infinity` stringify as `null`, and
    // `-0` would be read back as `0`, silently changing the sender's value.
    return Number.isFinite(value) && !Object.is(value, -0);
  }

  // `undefined`, `bigint`, `function`, `symbol` have no JSON form at all.
  if (typeof value !== "object") return false;

  if (Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Array.prototype && proto !== null) return false;
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    try {
      return checkArray(value, ancestors);
    } finally {
      ancestors.delete(value);
    }
  }

  // Everything else must be a plain (or null-prototype) object: this rejects
  // class instances, Date, Map, Set, boxed primitives and any custom wrapper.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    return checkObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function checkArray(array: readonly unknown[], ancestors: Set<object>): boolean {
  const names = Object.getOwnPropertyNames(array);
  let index = 0;
  for (const name of names) {
    if (name === "length") continue;
    // A dense array's own property names are exactly its canonical indices.
    // Anything else — sparse holes filled by nothing, extra non-index keys,
    // symbol keys (checked below) — cannot round-trip as a JSON array.
    if (name !== String(index)) return false;
    index++;
  }
  if (index !== array.length) return false;
  if (Object.getOwnPropertySymbols(array).length > 0) return false;

  for (let i = 0; i < array.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(array, i)) return false;
    if (!checkDescriptor(Object.getOwnPropertyDescriptor(array, i), ancestors)) return false;
  }
  return true;
}

function checkObject(object: object, ancestors: Set<object>): boolean {
  if (Object.getOwnPropertySymbols(object).length > 0) return false;

  const names = Object.getOwnPropertyNames(object);
  for (const name of names) {
    if (!checkDescriptor(Object.getOwnPropertyDescriptor(object, name), ancestors)) return false;
  }
  return true;
}

/**
 * One own property: must be a data property (never an accessor — reading one
 * could run arbitrary code and its value would not survive the wire) whose
 * value is itself JSON-safe.
 */
function checkDescriptor(
  descriptor: PropertyDescriptor | undefined,
  ancestors: Set<object>,
): boolean {
  if (descriptor === undefined) return false;
  if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
  return check(descriptor.value, ancestors);
}

/**
 * A deep, isolated copy of a value that `isStrictJsonValue` already accepted.
 *
 * The snapshot owns its data: later mutations of the original (which the Core
 * only shallow-isolates) cannot reach a published DTO through it. Objects are
 * built with null prototypes so every legal JSON key — including
 * `__proto__`, `constructor` and `prototype`, which a validation library's
 * `record` would silently drop — survives as a plain own property.
 *
 * Sharing without cycles is preserved as structure, not copied per reference;
 * `check`'s ancestor set has already ruled out cycles by the time this runs.
 */
export function safeJsonSnapshot(value: unknown): JsonValue {
  if (!isStrictJsonValue(value)) {
    throw new Error("safeJsonSnapshot requires a value that is a strict JsonValue");
  }
  return snapshot(value, new Map());
}

function snapshot(value: unknown, seen: Map<object, JsonValue>): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value as JsonValue;
  }

  if (Array.isArray(value)) {
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    const copy: JsonValue[] = [];
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) {
      copy.push(snapshot((value as unknown[])[i], seen));
    }
    return copy;
  }

  const cached = seen.get(value as object);
  if (cached !== undefined) return cached;
  // A null-prototype object makes `__proto__` an ordinary data key on
  // assignment instead of the prototype setter.
  const copy: Record<string, JsonValue> = Object.create(null);
  seen.set(value as object, copy);
  for (const name of Object.getOwnPropertyNames(value)) {
    copy[name] = snapshot((value as Record<string, unknown>)[name], seen);
  }
  return copy;
}
