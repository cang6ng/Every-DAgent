/**
 * The plugin system's own JSON profile, and the one way a configuration value
 * becomes owned.
 *
 * It exists so that this package can validate and freeze a configuration
 * without importing the protocol (which is the wire) or the host (which is the
 * composition): a plugin contract that depended on either would put the wire in
 * the middle of an in-process lifecycle.
 *
 * The walk is descriptor-based, like every other JSON boundary in this
 * repository: a property's value is read from its own data descriptor, never
 * through `[[Get]]`, so an accessor is refused instead of executed, and a Proxy
 * that lies about its descriptors cannot hand the copy a different value than
 * the one that was checked. What comes back is a fresh, deep-frozen tree that
 * shares nothing with the input.
 */

import type { PluginConfigValue } from "./plugin.js";

/** Internal signal for "this value is not a configuration value". */
const REJECTED: unique symbol = Symbol("every-dagent.plugin-config-rejected");

function isPlainObjectPrototype(prototype: unknown): boolean {
  return prototype === Object.prototype || prototype === null;
}

/** The child values of one object's own properties, read from their descriptors. */
function ownValues(value: object): unknown[] {
  if (Object.getOwnPropertySymbols(value).length > 0) throw REJECTED;
  const names = Object.getOwnPropertyNames(value);
  const values: unknown[] = [];
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw REJECTED;
    }
    values.push(descriptor.value);
  }
  return values;
}

function copy(value: unknown, depth: number): PluginConfigValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;

  if (typeof value === "number") {
    // `NaN` and `Infinity` are not JSON, and `-0` would read back as `0`.
    if (!Number.isFinite(value) || Object.is(value, -0)) throw REJECTED;
    return value;
  }

  if (typeof value !== "object") throw REJECTED;
  // A configuration is a tree, not a graph: a value that contains itself — or
  // nests past any depth a reader could carry — is refused rather than walked
  // forever.
  if (depth > 64) throw REJECTED;

  if (Array.isArray(value)) {
    if (!isPlainObjectPrototype(Object.getPrototypeOf(value))) throw REJECTED;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || typeof lengthDescriptor.value !== "number") throw REJECTED;
    const length = lengthDescriptor.value as number;
    const children = ownValues(value);
    if (children.length !== length) throw REJECTED;
    const copyArray: PluginConfigValue[] = [];
    for (const child of children) copyArray.push(copy(child, depth + 1));
    return Object.freeze(copyArray);
  }

  if (!isPlainObjectPrototype(Object.getPrototypeOf(value))) throw REJECTED;
  const copyObject: Record<string, PluginConfigValue> = Object.create(null);
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw REJECTED;
    }
    copyObject[name] = copy(descriptor.value, depth + 1);
  }
  const frozen: { readonly [key: string]: PluginConfigValue } = Object.freeze(copyObject);
  return frozen;
}

/**
 * Judges one value against this package's profile and returns an owned copy.
 *
 * `undefined` is a refusal, never an empty configuration: a value that is not
 * what a plugin configuration may be is not replaced by a legal one anywhere
 * in this package.
 */
export function ownPluginConfigValue(value: unknown): PluginConfigValue | undefined {
  try {
    return copy(value, 0);
  } catch (error) {
    if (error === REJECTED) return undefined;
    // A hostile Proxy can throw from any reflection step; that is a refusal too.
    return undefined;
  }
}

/** Whether a value is one a plugin configuration may hold. */
export function isPluginConfigValue(value: unknown): value is PluginConfigValue {
  return ownPluginConfigValue(value) !== undefined;
}
