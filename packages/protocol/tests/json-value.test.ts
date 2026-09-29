import { describe, expect, it } from "vitest";

import { validateJsonValue } from "@every-dagent/protocol";

/**
 * The strict JSON boundary matrix. Each rejected value must fail for the
 * reason the guard exists — before any schema or stringification runs.
 */

function accepts(value: unknown): void {
  const result = validateJsonValue(value);
  expect(result.success).toBe(true);
  if (result.success) expect(result.output).toEqual(value);
}

function rejects(value: unknown): void {
  const result = validateJsonValue(value);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.failure.reason).toBe("NON_JSON_VALUE");
}

describe("strict JsonValue guard — accepted", () => {
  it("accepts null, booleans, plain numbers and strings", () => {
    accepts(null);
    accepts(false);
    accepts(true);
    accepts(0);
    accepts(-1.5);
    accepts(2 ** 60);
    accepts(1e21);
    accepts("");
    accepts("toJSON");
  });

  it("accepts nested arrays and objects", () => {
    accepts({ a: [1, { b: [null, true, "x"] }] });
    accepts([]);
    accepts({});
  });

  it("accepts legal JSON dictionary keys that a record schema would drop", () => {
    const value = {
      ["__proto__"]: 1,
      constructor: "c",
      prototype: [2],
      toString: { deep: true },
    };
    const result = validateJsonValue(value);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.getPrototypeOf(result.output)).toBeNull();
      // The output keeps the own `__proto__` key; the literal on the right
      // cannot (its `__proto__:` would set a prototype), so spell it out.
      expect(JSON.stringify(result.output)).toBe(
        JSON.stringify({ ["__proto__"]: 1, constructor: "c", prototype: [2], toString: { deep: true } }),
      );
    }
  });

  it("keeps a REAL own __proto__ data key as data (regression: never drop or pollute)", () => {
    // JSON.parse is the honest way to build an own `__proto__` property: an
    // object literal's `__proto__:` sets the prototype instead.
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "own", "toString": 5, "nested": {"__proto__": 7}}');
    const result = validateJsonValue(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      const output = result.output as Record<string, unknown>;
      // The key survives as an own data property...
      expect(Object.getOwnPropertyNames(output)).toContain("__proto__");
      expect(Object.getOwnPropertyNames(output)).toContain("constructor");
      expect(Object.getOwnPropertyNames(output)).toContain("toString");
      // ...the output object itself stays clean (no prototype pollution)...
      expect(Object.getPrototypeOf(output)).toBeNull();
      expect((output["__proto__"] as Record<string, unknown>)["polluted"]).toBe(true);
      expect(output["constructor"]).toBe("own");
      expect(output["toString"]).toBe(5);
      expect(Object.getOwnPropertyNames(output["nested"] as object)).toContain("__proto__");
      // ...and the whole thing round-trips through JSON unchanged.
      expect(JSON.parse(JSON.stringify(output))).toEqual(parsed);
    }
  });

  it("rejects non-enumerable own properties (they would silently vanish in JSON)", () => {
    const hidden = { visible: 1 };
    Object.defineProperty(hidden, "secret", { value: 2, enumerable: false, writable: true, configurable: true });
    rejects(hidden);
  });

  it("accepts null-prototype objects and frozen inputs", () => {
    accepts(Object.assign(Object.create(null), { a: 1 }));
    accepts(Object.freeze({ b: [Object.freeze({ c: 2 })] }));
  });

  it("accepts shared (acyclic) references without treating them as cycles", () => {
    const shared = { x: 1 };
    accepts({ first: shared, second: shared, list: [shared, shared] });
  });

  it("accepts a plain data property that merely happens to be named toJSON", () => {
    accepts({ toJSON: "not a function" });
  });
});

describe("strict JsonValue guard — rejected", () => {
  it("rejects undefined, bigint, function and symbol values", () => {
    rejects(undefined);
    rejects(1n);
    rejects(() => 1);
    rejects(Symbol("s"));
  });

  it("rejects NaN, both infinities and negative zero", () => {
    rejects(Number.NaN);
    rejects(Number.POSITIVE_INFINITY);
    rejects(Number.NEGATIVE_INFINITY);
    rejects(-0);
  });

  it("rejects cyclic structures", () => {
    const cycle: Record<string, unknown> = { name: "root" };
    cycle["self"] = cycle;
    rejects(cycle);

    const inner: Record<string, unknown> = {};
    const outer = { inner };
    inner["outer"] = outer;
    rejects(outer);
  });

  it("accepts a genuinely dense empty array and dense nested arrays", () => {
    accepts(new Array(0));
    accepts([[], [1, [2]], [[[[3]]]]]);
  });

  it("rejects fully hollow arrays instead of truncating them to []", () => {
    // Regression: own names are just ["length"]; the old walk silently
    // produced []. The own length descriptor must demand indices 0..length-1.
    rejects(new Array(3));
    rejects(new Array(1));
  });

  it("rejects trailing holes created by extending length", () => {
    const trailing: unknown[] = [1];
    trailing.length = 3;
    rejects(trailing);

    const widened: unknown[] = [1, 2];
    widened.length = 5;
    rejects(widened);
  });

  it("rejects sparse arrays nested inside valid structures", () => {
    const sparse: unknown[] = new Array(2);
    sparse[0] = 1;
    rejects({ outer: { inner: [1, sparse] } });

    const trailing: unknown[] = [1];
    trailing.length = 2;
    rejects([trailing, [trailing]]);
  });

  it("rejects sparse arrays and arrays with extra non-index properties", () => {
    const sparse: unknown[] = new Array(3);
    sparse[1] = 1;
    rejects(sparse);

    const extra: unknown[] = [1, 2];
    (extra as unknown as Record<string, unknown>)["extra"] = true;
    rejects(extra);
  });

  it("rejects Date, Map, Set and class instances", () => {
    rejects(new Date(0));
    rejects(new Map());
    rejects(new Set());
    class Wrapped {
      value = 1;
    }
    rejects(new Wrapped());
  });

  it("rejects accessor properties without invoking them", () => {
    let reads = 0;
    const hostile = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        reads += 1;
        return 42;
      },
    });
    rejects(hostile);
    expect(reads).toBe(0);
  });

  it("rejects function-valued custom toJSON without calling it", () => {
    let calls = 0;
    const sneaky = {
      toJSON() {
        calls += 1;
        return { replaced: true };
      },
    };
    rejects(sneaky);
    expect(calls).toBe(0);
  });

  it("rejects symbol-keyed properties", () => {
    const symbolic = { a: 1 };
    (symbolic as Record<string | symbol, unknown>)[Symbol("k")] = 2;
    rejects(symbolic);
  });

  it("rejects hostile proxies by failing safe, without throwing", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    rejects(hostile);
  });

  it("rejects proxies whose descriptor access throws mid-walk", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === "late") throw new Error("boom");
          return { value: 1, enumerable: true, writable: true, configurable: true };
        },
        ownKeys() {
          return ["first", "late"];
        },
      },
    );
    rejects(hostile);
  });

  it("rejects a proxy descriptor chain that would inject a cycle", () => {
    const hostile: Record<string, unknown> = new Proxy(
      {} as Record<string, unknown>,
      {
        getOwnPropertyDescriptor() {
          // The descriptor hands the guard the proxy itself: a cycle that a
          // naive snapshot stage could still hit.
          return { value: hostile, enumerable: true, writable: true, configurable: true };
        },
        ownKeys() {
          return ["self"];
        },
      },
    );
    rejects(hostile);
  });
});

describe("strict JsonValue guard — single-pass injection protection", () => {
  it("never reads through [[Get]]: a value-getting proxy must stay untouched", () => {
    let getCalls = 0;
    const undercover = new Proxy(
      { honest: { value: 1 } } as Record<string, unknown>,
      {
        get(target, key) {
          getCalls += 1;
          // Injection payload: what a re-reading implementation would see
          // instead of the validated descriptor values.
          if (key === "honest") return { value: -0 };
          return target[key as string];
        },
      },
    );
    const result = validateJsonValue(undercover);
    expect(result.success).toBe(true);
    if (result.success) {
      const nested = (result.output as Record<string, { value: number }>)["honest"];
      expect(nested["value"]).toBe(1);
    }
    // The mutation guard: any check-then-re-read design would trip this.
    expect(getCalls).toBe(0);
  });

  it("cannot have -0, NaN or new cycles injected after validation", () => {
    let step = 0;
    const shapeshifter = new Proxy(
      {} as Record<string, unknown>,
      {
        // Deterministic per-key descriptors: one poisoned branch of each kind.
        getOwnPropertyDescriptor(_target, key) {
          step += 1;
          if (key === "negative") {
            return { value: -0, enumerable: true, writable: true, configurable: true };
          }
          if (key === "notNumber") {
            return { value: Number.NaN, enumerable: true, writable: true, configurable: true };
          }
          return { value: 1, enumerable: true, writable: true, configurable: true };
        },
        ownKeys() {
          return ["first", "negative", "notNumber"];
        },
      },
    );
    rejects(shapeshifter);
  });
});

describe("strict JsonValue guard — isolation", () => {
  it("returns output that no longer reacts to later mutations of the input", () => {
    const input: Record<string, unknown> = { nested: { value: 1 } };
    const result = validateJsonValue(input);
    expect(result.success).toBe(true);
    if (result.success) {
      (input.nested as Record<string, unknown>)["value"] = 999;
      input["added"] = true;
      expect((result.output as Record<string, unknown>)["added"]).toBeUndefined();
      const nested = (result.output as Record<string, { value: number }>)["nested"];
      expect(nested["value"]).toBe(1);
    }
  });

  it("never shares a mutated object identity with the caller", () => {
    const input = { a: [1] };
    const result = validateJsonValue(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.output).not.toBe(input);
  });
});
