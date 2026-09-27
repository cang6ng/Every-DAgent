import type { RuntimeContext } from "../runtime/runtime-context.js";

/**
 * The uniform contract every capability implements.
 *
 * `execute` is deliberately declared with method syntax rather than as a
 * property holding a function type: TypeScript checks method parameters
 * bivariantly, which is what lets a narrowed `Tool<string, number>` be passed
 * to `ToolRegistry.register(tool: Tool)`. Declaring it as a property would make
 * the parameter contravariant and reject every narrowed tool.
 */
export interface Tool<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  execute(input: Input, context: RuntimeContext): Promise<Output>;
}

/**
 * A failed execution is still a result, not an exception: the message goes back
 * to the model as an observation so it can explain the failure or try another
 * route.
 */
export type ToolExecutionResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };
