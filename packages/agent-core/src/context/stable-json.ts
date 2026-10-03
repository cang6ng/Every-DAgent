/**
 * The one textual representation this Core measures and compares with.
 *
 * Everything a request costs is counted in UTF-8 bytes of a stable JSON text:
 * deterministic (object keys in sorted order, one escaping rule), honest (a
 * value that JSON cannot carry is refused, never approximated), and free of
 * side effects (properties are read from their own data descriptors, so no
 * accessor runs and no `toJSON` is ever consulted). Two requests that differ
 * only in property order cost the same; two that differ in content never do.
 *
 * The serializer is also the Core's ownership boundary. `ownJsonValue` performs
 * the same traversal and, instead of counting what it finds, copies it into
 * plain frozen data — so what a builder produced can be measured, stored and
 * re-measured without the producer being able to change it in between.
 */

import { InvalidModelRequestError } from "../errors.js";

/**
 * The bytes a string occupies once encoded.
 *
 * Lone surrogates count as the three bytes their replacement character takes,
 * which is what every encoder on the path will actually write.
 */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * The JSON string token for one string, escaped exactly as JSON defines it.
 *
 * Written out rather than delegated so that the measurement never depends on
 * whatever a host did to `JSON`, and so that a lone surrogate costs its six
 * `\uXXXX` bytes — the conservative reading, and the same one a well-formed
 * stringifier produces.
 */
function writeString(text: string, out: string[]): void {
  let chunk = '"';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    switch (code) {
      case 0x22:
        chunk += '\\"';
        continue;
      case 0x5c:
        chunk += "\\\\";
        continue;
      case 0x08:
        chunk += "\\b";
        continue;
      case 0x0c:
        chunk += "\\f";
        continue;
      case 0x0a:
        chunk += "\\n";
        continue;
      case 0x0d:
        chunk += "\\r";
        continue;
      case 0x09:
        chunk += "\\t";
        continue;
      default:
        break;
    }
    if (code < 0x20) {
      chunk += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        chunk += text[index] + text[index + 1];
        index += 1;
      } else {
        chunk += `\\u${code.toString(16).padStart(4, "0")}`;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      chunk += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    chunk += text[index];
  }
  out.push(`${chunk}"`);
}

/** How deep a value may nest before this program refuses to represent it. */
const MAX_STABLE_DEPTH = 64;

/** The failure every traversal in this module raises, whatever it tripped on. */
function refused(what: string): InvalidModelRequestError {
  return new InvalidModelRequestError(what);
}

/** One property, read only if reading it cannot run code. */
function plainField(owner: object, name: string, what: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(owner, name);
  } catch {
    throw refused(`${what} is not a value this Core can read`);
  }
  if (descriptor === undefined) return undefined;
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    throw refused(`${what} has a property that would have to run to be read`);
  }
  return descriptor.value;
}

function writeValue(value: unknown, depth: number, ancestors: Set<object>, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "string":
      writeString(value, out);
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw refused("a request carries a number JSON cannot reproduce");
      }
      out.push(String(value));
      return;
    case "object":
      break;
    default:
      throw refused(`a request carries a ${typeof value}, which JSON cannot carry`);
  }

  if (depth >= MAX_STABLE_DEPTH) throw refused("a request nests deeper than this Core represents");
  const container = value as object;
  if (ancestors.has(container)) throw refused("a request contains a cycle");
  ancestors.add(container);
  try {
    if (Array.isArray(container)) {
      writeArray(container, depth, ancestors, out);
      return;
    }
    writeObject(container, depth, ancestors, out);
  } finally {
    ancestors.delete(container);
  }
}

function writeArray(array: object, depth: number, ancestors: Set<object>, out: string[]): void {
  const proto = Object.getPrototypeOf(array) as object | null;
  if (proto !== Array.prototype && proto !== null) {
    throw refused("a request contains an array with a prototype JSON cannot reproduce");
  }
  if (ownSymbolsOf(array).length > 0) throw refused("a request contains symbol-keyed data");

  const length = plainField(array, "length", "an array in a request");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw refused("a request contains an array whose length is not a whole number");
  }
  const names = Object.getOwnPropertyNames(array).filter((name) => name !== "length");
  if (names.length !== length) {
    throw refused("a request contains a sparse array, which JSON cannot reproduce");
  }

  out.push("[");
  for (let index = 0; index < length; index += 1) {
    if (index > 0) out.push(",");
    const element = plainField(array, String(index), "an array element in a request");
    if (element === undefined) throw refused("a request contains a hole JSON cannot reproduce");
    writeValue(element, depth + 1, ancestors, out);
  }
  out.push("]");
}

function writeObject(object: object, depth: number, ancestors: Set<object>, out: string[]): void {
  const proto = Object.getPrototypeOf(object) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    throw refused("a request contains a value with a prototype JSON cannot reproduce");
  }
  if (ownSymbolsOf(object).length > 0) throw refused("a request contains symbol-keyed data");

  const names: string[] = [];
  for (const name of Object.getOwnPropertyNames(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (descriptor === undefined) continue;
    if (descriptor.enumerable !== true) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw refused("a request has a property that would have to run to be read");
    }
    if (descriptor.value === undefined) continue;
    names.push(name);
  }
  names.sort();

  out.push("{");
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index] as string;
    if (index > 0) out.push(",");
    writeString(name, out);
    out.push(":");
    writeValue(plainField(object, name, "a request property"), depth + 1, ancestors, out);
  }
  out.push("}");
}

function ownSymbolsOf(value: object): readonly symbol[] {
  try {
    return Object.getOwnPropertySymbols(value);
  } catch {
    throw refused("a request carries a value this Core cannot inspect");
  }
}

/**
 * The stable JSON text of a value.
 *
 * Deterministic by construction: keys are sorted, numbers are written in their
 * shortest exact form, and the escaping is JSON's own. A value it cannot
 * represent is refused with a fixed message rather than coerced into something
 * that would measure and serialize differently from what was written.
 */
export function stableJSON(value: unknown): string {
  const out: string[] = [];
  writeValue(value, 0, new Set<object>(), out);
  return out.join("");
}

/** What one value costs as stable JSON: the bytes a provider would have to carry. */
export function neutralBytes(value: unknown): number {
  return utf8Bytes(stableJSON(value));
}

/** What one string costs as its escaped JSON token, quotes included. */
export function escapedStringBytes(text: string): number {
  const out: string[] = [];
  writeString(text, out);
  return utf8Bytes(out.join(""));
}

/**
 * How deep a value nests: zero for a primitive, one more for each container.
 *
 * The walk is the serializer's, so it refuses the same shapes for the same
 * reasons. It exists separately because depth is a different question from
 * size: a value can be small and still nest past what an adapter will accept,
 * and a resource bound that only counted bytes would let it through.
 */
export function jsonDepthOf(value: unknown): number {
  return depthOf(value, 0, new Set<object>());
}

function depthOf(value: unknown, depth: number, ancestors: Set<object>): number {
  if (value === null || typeof value !== "object") return depth;
  if (depth >= MAX_STABLE_DEPTH) throw refused("a value nests deeper than this Core represents");

  const container = value as object;
  if (ancestors.has(container)) throw refused("a value contains a cycle");
  ancestors.add(container);
  try {
    let deepest = depth + 1;
    if (Array.isArray(container)) {
      const length = plainField(container, "length", "an array");
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        throw refused("an array's length is not a whole number");
      }
      for (let index = 0; index < length; index += 1) {
        const element = plainField(container, String(index), "an array element");
        if (element === undefined) throw refused("an array has a hole JSON cannot reproduce");
        deepest = Math.max(deepest, depthOf(element, depth + 1, ancestors));
      }
      return deepest;
    }
    for (const name of Object.getOwnPropertyNames(container)) {
      const descriptor = Object.getOwnPropertyDescriptor(container, name);
      if (descriptor === undefined || descriptor.enumerable !== true) continue;
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw refused("a value has a property that would have to run to be read");
      }
      if (descriptor.value === undefined) continue;
      deepest = Math.max(deepest, depthOf(descriptor.value, depth + 1, ancestors));
    }
    return deepest;
  } finally {
    ancestors.delete(container);
  }
}

/**
 * This Core's own copy of a value: plain, frozen, and detached from its source.
 *
 * The traversal is the serializer's, so a value that could not be measured is
 * refused here as well — and one that can be is copied into fresh objects,
 * arrays and primitives, then frozen all the way down. From here on the value
 * cannot change under a request that was already measured, whatever the builder
 * that produced it does next.
 */
export function ownJsonValue(value: unknown, what: string): unknown {
  return own(value, 0, new Set<object>(), what);
}

function own(value: unknown, depth: number, ancestors: Set<object>, what: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw refused(`${what} carries a number JSON cannot reproduce`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw refused(`${what} carries a ${typeof value}, which JSON cannot carry`);
  }
  if (depth >= MAX_STABLE_DEPTH) throw refused(`${what} nests deeper than this Core represents`);

  const container = value as object;
  if (ancestors.has(container)) throw refused(`${what} contains a cycle`);
  ancestors.add(container);
  try {
    if (Array.isArray(container)) {
      const proto = Object.getPrototypeOf(container) as object | null;
      if (proto !== Array.prototype && proto !== null) {
        throw refused(`${what} contains an array with a prototype JSON cannot reproduce`);
      }
      if (ownSymbolsOf(container).length > 0) throw refused(`${what} contains symbol-keyed data`);
      const length = plainField(container, "length", what);
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        throw refused(`${what} contains an array whose length is not a whole number`);
      }
      if (Object.getOwnPropertyNames(container).filter((name) => name !== "length").length !== length) {
        throw refused(`${what} contains a sparse array, which JSON cannot reproduce`);
      }
      const copy: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const element = plainField(container, String(index), what);
        if (element === undefined) throw refused(`${what} contains a hole JSON cannot reproduce`);
        copy.push(own(element, depth + 1, ancestors, what));
      }
      return Object.freeze(copy);
    }

    const proto = Object.getPrototypeOf(container) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      throw refused(`${what} contains a value with a prototype JSON cannot reproduce`);
    }
    if (ownSymbolsOf(container).length > 0) throw refused(`${what} contains symbol-keyed data`);

    const copy: Record<string, unknown> = {};
    for (const name of Object.getOwnPropertyNames(container)) {
      const descriptor = Object.getOwnPropertyDescriptor(container, name);
      if (descriptor === undefined) continue;
      if (descriptor.enumerable !== true) continue;
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw refused(`${what} has a property that would have to run to be read`);
      }
      if (descriptor.value === undefined) continue;
      // Defined, never assigned: `copy[name] = value` would send a legal own
      // `"__proto__"` into the prototype setter instead of keeping it as the
      // data property every other JSON key is, and the clone would silently
      // lose the very key it was asked for.
      Object.defineProperty(copy, name, {
        value: own(descriptor.value, depth + 1, ancestors, what),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(container);
  }
}
