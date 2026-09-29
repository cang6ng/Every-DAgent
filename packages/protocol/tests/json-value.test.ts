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
      __proto__: 1,
      constructor: "c",
      prototype: [2],
      toString: { deep: true },
    };
    const result = validateJsonValue(value);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.getPrototypeOf(result.output)).toBeNull();
      expect(JSON.stringify(result.output)).toBe(
        JSON.stringify({ __proto__: 1, constructor: "c", prototype: [2], toString: { deep: true } }),
      );
    }
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
