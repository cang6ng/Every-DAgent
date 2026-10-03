import type { ModelLimits } from "../context/model-budget.js";
import type { RuntimeContext } from "../runtime/runtime-context.js";
import type { ModelMessage, ToolCall } from "./message.js";

/**
 * The only part of a Tool the model ever sees.
 *
 * Kept as its own type rather than a subset of `Tool` so that `execute` cannot
 * travel to the model by accident: `Tool.list()` results must be projected
 * through this shape before they reach a request.
 */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface ModelRequest {
  readonly systemPrompt?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSchema[];
  /**
   * The effective output cap for this request, and the `R` of the budget it was
   * built against.
   *
   * It is required rather than optional because an omitted cap is not a neutral
   * default: a provider that is given no cap decides one itself, and the Core
   * would then be enforcing a reserve that the request never carried. A
   * ModelClient must send exactly this value as the provider's own output cap,
   * or refuse the request.
   */
  readonly maxOutputTokens: number;
}

/**
 * A tool call is emitted fully assembled, not as incremental deltas: the
 * provider's argument-delta accumulation belongs inside a ModelClient
 * implementation. That is what keeps AgentLoop free of any stream assembler.
 */
export type ModelEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly call: ToolCall }
  | { readonly type: "done" };

/**
 * Isolates the Core from any concrete provider.
 *
 * Failure contract — settled here so that no provider detail leaks upward:
 *
 * - A provider or transport failure surfaces as a throw, either from the call
 *   itself or mid-iteration; `stream` never reports failure through a
 *   `ModelEvent`. There is deliberately no error variant: the AgentLoop tells a
 *   cancellation from a failure by checking `context.signal.aborted`, and turns
 *   anything else it catches into an `error` turn end.
 * - Retrying is the AgentLoop's responsibility, not the adapter's, so that the two
 *   never multiply. A retry is silent while it can be — the loop only repeats a
 *   step that produced nothing — and an exhausted one is reported as the turn's
 *   own `error`. Phase 1 has no event kind for an attempt, so a retry that
 *   succeeded leaves no separate trace beyond the step it produced. A failure
 *   this adapter classifies as deterministic is thrown as a
 *   `NonRetryableModelError`, which tells the loop not to spend another attempt
 *   on an answer that cannot change.
 * - Implementations must honour `context.signal` and stop producing once it is
 *   aborted.
 * - `limits` is the finite capability the client will really call with. The Core
 *   derives its budget from these numbers alone and refuses anything that is not
 *   a usable capability, so an adapter that does not know its model's window
 *   must say so instead of declaring a larger one.
 */
export interface ModelClient {
  readonly limits: ModelLimits;
  stream(request: ModelRequest, context: RuntimeContext): AsyncIterable<ModelEvent>;
}
