import type { RuntimeContext } from "../../src/runtime/runtime-context.js";
import type { Tool } from "../../src/tools/tool.js";

export interface ToolCallRecord {
  readonly input: unknown;
  readonly context: RuntimeContext;
}

/**
 * The `echo` tool of the P1.2 flow, carrying the calls it received.
 *
 * Recording them is what makes "executed exactly once" and "the runtime context
 * reached the tool" observable from a test.
 */
export interface EchoTool extends Tool {
  /** Every execution it was asked for, in call order. */
  readonly calls: readonly ToolCallRecord[];
}

export function createEchoTool(): EchoTool {
  const calls: ToolCallRecord[] = [];

  return {
    name: "echo",
    description: 'Returns the "text" argument unchanged.',
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    calls,
    async execute(input: unknown, context: RuntimeContext): Promise<string> {
      calls.push({ input, context });

      const text = (input as { text?: unknown } | null)?.text;
      // Throwing is the tool's contract for bad input; the registry turns it into
      // a failed result, which is what the model would then see.
      if (typeof text !== "string") throw new Error("echo expects { text: string }");

      return text;
    },
  };
}
