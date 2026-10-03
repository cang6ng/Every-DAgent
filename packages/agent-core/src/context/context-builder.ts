import type { ModelBudget, ModelLimits } from "./model-budget.js";
import type { ModelRequest, ToolSchema } from "../model/model-client.js";
import type { RuntimeContext } from "../runtime/runtime-context.js";
import type { Session } from "../session/session.js";
import type { Tool } from "../tools/tool.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

/** The fixed part of a request: what the composition declares, for one step. */
export interface FixedContext {
  readonly systemPrompt?: string;
  readonly tools: readonly ToolSchema[];
}

export interface FixedContextInput {
  readonly tools: ToolRegistry;
  readonly context: RuntimeContext;
}

export interface ContextBuilderInput extends FixedContextInput {
  readonly session: Session;
  /** The turn being answered: the open turn of the loaded window. */
  readonly turnId: string;
  readonly limits: ModelLimits;
  readonly budget: ModelBudget;
  /**
   * The authoritative fixed context for this step, read from the live registry
   * by the Core immediately before this call. A builder uses these rather than
   * reading the registry again, so that the context it built from and the
   * context the guard checks against are the same reading.
   */
  readonly fixed: FixedContext;
}

/**
 * Decides what the model sees on each call. The seam exists so that retrieval,
 * compaction or tool filtering can be added later without touching AgentLoop.
 *
 * Two methods, because a request is built twice in a turn's life. `build` may do
 * anything a context source needs to — await a retrieval, consult the session —
 * and returns the candidate the Core will then take over. `getFixedContext` is
 * the part that must be available synchronously and without side effects: the
 * system prompt and the tools the session currently offers, which is all the
 * admission preflight needs to decide whether a run can be sent at all, before
 * anything durable or expensive has happened.
 */
export interface ContextBuilder {
  build(input: ContextBuilderInput): Promise<ModelRequest>;
  getFixedContext(input: FixedContextInput): FixedContext;
}

/**
 * v0.2 does three things: system prompt, the loaded window's messages, and the
 * current registry's tool schemas.
 *
 * The `async` signature is part of the contract, not an accident — a future
 * builder awaits retrieval here without any call site changing.
 */
export function createDefaultContextBuilder(systemPrompt?: string): ContextBuilder {
  const fixedContext = ({ tools }: FixedContextInput): FixedContext => ({
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    tools: tools.list().map(toToolSchema),
  });

  return {
    getFixedContext: fixedContext,
    async build({ session, budget, fixed }: ContextBuilderInput): Promise<ModelRequest> {
      return {
        ...(fixed.systemPrompt === undefined ? {} : { systemPrompt: fixed.systemPrompt }),
        messages: session.deriveMessages(),
        tools: fixed.tools,
        maxOutputTokens: budget.reservedOutput,
      };
    },
  };
}

/** The projection that keeps host-only capability out of the request. */
function toToolSchema(tool: Tool): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
