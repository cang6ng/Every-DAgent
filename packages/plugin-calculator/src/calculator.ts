import type { Tool } from "@every-dagent/agent-core";

export interface CalculatorInput {
  readonly a: number;
  readonly b: number;
}

/**
 * The plugin system's one real tool: it multiplies two numbers.
 *
 * It is production code rather than a fixture, because the acceptance path is a
 * real model calling a tool that a plugin registered, and it is deliberately
 * narrow: `inputSchema` is what the model sees when deciding to call it, and a
 * wrong argument set is thrown rather than tolerated — the registry turns a
 * throw into an observation, which is what gives the model a chance to correct
 * itself.
 */
export function createCalculatorTool(): Tool<CalculatorInput, number> {
  return {
    name: "calculator",
    description: "Multiplies two numbers and returns the product.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "The first factor." },
        b: { type: "number", description: "The second factor." },
      },
      required: ["a", "b"],
    },
    // The `Tool` contract also passes a RuntimeContext; this tool needs nothing from
    // it, and an implementation may declare fewer parameters than the contract.
    async execute(input: CalculatorInput): Promise<number> {
      const { a, b } = (input ?? {}) as Partial<CalculatorInput>;
      if (typeof a !== "number" || typeof b !== "number") {
        throw new Error("calculator expects { a: number, b: number }");
      }

      const product = a * b;
      // JSON has no notation for an infinite number: `JSON.stringify` would hand the
      // model `null` as a *successful* result, so a product it cannot represent is a
      // failure the model gets to see.
      if (!Number.isFinite(product)) {
        throw new Error("calculator result is not a finite number");
      }

      return product;
    },
  };
}
