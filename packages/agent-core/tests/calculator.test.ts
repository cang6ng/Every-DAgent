import { describe, expect, it } from "vitest";

import type { RuntimeContext } from "../src/runtime/runtime-context.js";
import { createCalculatorTool } from "../src/tools/calculator.js";
import type { Tool } from "../src/tools/tool.js";

const context: RuntimeContext = { sessionId: "s-1", signal: new AbortController().signal };

describe("calculator tool", () => {
  it("multiplies the numbers it is asked for", async () => {
    const tool: Tool = createCalculatorTool();

    await expect(tool.execute({ a: 21, b: 2 }, context)).resolves.toBe(42);
    // A second product, so the test pins multiplication rather than "42 for {21, 2}".
    await expect(tool.execute({ a: 5, b: 6 }, context)).resolves.toBe(30);
  });

  it("throws on anything that is not two numbers", async () => {
    const tool: Tool = createCalculatorTool();

    // Throwing is the contract for bad input: the registry turns it into an
    // observation instead of an exception.
    await expect(tool.execute({ a: "21", b: 2 }, context)).rejects.toThrow(
      /expects \{ a: number, b: number \}/,
    );
  });

  it("refuses a product it cannot hand the model as a number", async () => {
    const tool: Tool = createCalculatorTool();

    // JSON cannot represent an infinite number; a "successful" result of null would be
    // worse than a failure the model can see.
    await expect(tool.execute({ a: 1e308, b: 10 }, context)).rejects.toThrow(/not a finite number/);
  });

  it("declares the arguments the model has to send", () => {
    const tool = createCalculatorTool();

    expect(tool.name).toBe("calculator");
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    });
  });
});
