import { describe, expect, it } from "vitest";

import type { RuntimeContext } from "../src/runtime/runtime-context.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import type { Tool, ToolExecutionResult } from "../src/tools/tool.js";

function context(signal?: AbortSignal): RuntimeContext {
  return { sessionId: "session-1", userId: "user-1", signal: signal ?? new AbortController().signal };
}

function toolFrom(
  name: string,
  execute: (input: unknown, context: RuntimeContext) => Promise<unknown>,
): Tool {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    execute,
  };
}

describe("ToolRegistry registration", () => {
  it("registers, looks up and lists tools", () => {
    const registry = createToolRegistry();
    const tool = toolFrom("echo", async () => "ok");

    registry.register(tool);

    expect(registry.get("echo")).toBe(tool);
    expect(registry.list()).toEqual([tool]);
    expect(registry.get("missing")).toBeUndefined();
  });

  it("unregisters through the returned disposer", () => {
    const registry = createToolRegistry();
    const dispose = registry.register(toolFrom("echo", async () => "ok"));

    dispose();

    expect(registry.get("echo")).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("allows the same name to be registered again after disposal", () => {
    const registry = createToolRegistry();
    registry.register(toolFrom("echo", async () => "first"))();
    const replacement = toolFrom("echo", async () => "second");

    registry.register(replacement);

    expect(registry.get("echo")).toBe(replacement);
  });

  it("does not let a stale disposer evict a later registration of the same name", () => {
    const registry = createToolRegistry();
    const dispose = registry.register(toolFrom("echo", async () => "first"));
    dispose();
    const replacement = toolFrom("echo", async () => "second");
    registry.register(replacement);

    dispose();

    expect(registry.get("echo")).toBe(replacement);
  });

  it("rejects a duplicate name rather than silently replacing it", () => {
    const registry = createToolRegistry();
    registry.register(toolFrom("echo", async () => "ok"));

    expect(() => registry.register(toolFrom("echo", async () => "other"))).toThrow(
      'tool "echo" is already registered',
    );
  });
});

describe("ToolRegistry execution", () => {
  it("returns the tool's value as a success", async () => {
    const registry = createToolRegistry();
    registry.register(toolFrom("answer", async () => 42));

    await expect(registry.execute("answer", {}, context())).resolves.toEqual({ ok: true, value: 42 });
  });

  it("passes the input and the runtime context straight through", async () => {
    const registry = createToolRegistry();
    const controller = new AbortController();
    const runtimeContext = context(controller.signal);
    let seenInput: unknown;
    let seenContext: RuntimeContext | undefined;
    registry.register(
      toolFrom("capture", async (input, received) => {
        seenInput = input;
        seenContext = received;
        return "ok";
      }),
    );

    await registry.execute("capture", { a: 21 }, runtimeContext);

    expect(seenInput).toEqual({ a: 21 });
    expect(seenContext).toBe(runtimeContext);
    expect(seenContext?.signal).toBe(controller.signal);
  });

  it("forwards any input verbatim, including values JSON cannot represent", async () => {
    const registry = createToolRegistry();
    const seen: unknown[] = [];
    registry.register(
      toolFrom("capture", async (input) => {
        seen.push(input);
        return "ok";
      }),
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const callable = () => 1;
    const inputs: unknown[] = [undefined, null, 42, "text", [], callable, circular, 10n];

    for (const input of inputs) {
      await expect(registry.execute("capture", input, context())).resolves.toEqual({ ok: true, value: "ok" });
    }

    expect(seen).toEqual(inputs);
  });

  it("reports an unknown tool as a failure instead of throwing", async () => {
    const registry = createToolRegistry();

    const result = await registry.execute("missing", {}, context());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("missing");
  });

  it("normalizes a thrown Error into a failed result", async () => {
    const registry = createToolRegistry();
    registry.register(
      toolFrom("boom", async () => {
        throw new Error("catalog is unavailable");
      }),
    );

    await expect(registry.execute("boom", {}, context())).resolves.toEqual({
      ok: false,
      error: "catalog is unavailable",
    });
  });

  it("normalizes a non-Error throw into a failed result", async () => {
    const registry = createToolRegistry();
    registry.register(
      toolFrom("boom", async () => {
        throw "plain string failure";
      }),
    );

    await expect(registry.execute("boom", {}, context())).resolves.toEqual({
      ok: false,
      error: "plain string failure",
    });
  });

  it("normalizes a thrown non-Error object carrying a message", async () => {
    const registry = createToolRegistry();
    registry.register(
      toolFrom("boom", async () => {
        throw { message: "quota exceeded", code: "QUOTA" };
      }),
    );

    await expect(registry.execute("boom", {}, context())).resolves.toEqual({
      ok: false,
      error: "quota exceeded",
    });
  });

  it("survives a tool that throws undefined", async () => {
    const registry = createToolRegistry();
    registry.register(
      toolFrom("boom", async () => {
        throw undefined;
      }),
    );

    const result = await registry.execute("boom", {}, context());

    expect(result.ok).toBe(false);
    expect(result.ok === false && typeof result.error).toBe("string");
  });

  it("keeps working after a failing call", async () => {
    const registry = createToolRegistry();
    registry.register(
      toolFrom("flaky", async (input) => {
        if (input === "bad") throw new Error("nope");
        return "good";
      }),
    );

    await registry.execute("flaky", "bad", context());

    await expect(registry.execute("flaky", "fine", context())).resolves.toEqual({ ok: true, value: "good" });
  });
});

describe("Core contract types", () => {
  it("accepts a narrowed Tool, because execute is declared as a method", () => {
    const lengthOf: Tool<string, number> = {
      name: "length_of",
      description: "Returns the length of a string.",
      inputSchema: { type: "string" },
      async execute(input: string): Promise<number> {
        return input.length;
      },
    };

    const registry = createToolRegistry();
    registry.register(lengthOf);

    expect(registry.get("length_of")).toBe(lengthOf);
  });

  it("narrows ToolExecutionResult on ok", () => {
    const describeOutcome = (result: ToolExecutionResult): string =>
      result.ok ? `value:${String(result.value)}` : `error:${result.error}`;

    expect(describeOutcome({ ok: true, value: 7 })).toBe("value:7");
    expect(describeOutcome({ ok: false, error: "boom" })).toBe("error:boom");
  });
});
