import type { ModelRequest, ToolSchema } from "../model/model-client.js";
import type { RuntimeContext } from "../runtime/runtime-context.js";
import type { Session } from "../session/session.js";
import type { Tool } from "../tools/tool.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

export interface ContextBuilderInput {
  readonly session: Session;
  readonly tools: ToolRegistry;
  readonly context: RuntimeContext;
}

/**
 * Decides what the model sees on each call. The seam exists so that retrieval,
 * compaction or tool filtering can be added later without touching AgentLoop.
 */
export interface ContextBuilder {
  build(input: ContextBuilderInput): Promise<ModelRequest>;
}

/**
 * v0.1 does exactly three things: system prompt, session messages, tool schemas.
 *
 * The `async` signature is part of the contract, not an accident — a future
 * builder awaits retrieval here without any call site changing.
 */
export function createDefaultContextBuilder(systemPrompt?: string): ContextBuilder {
  return {
    async build({ session, tools }: ContextBuilderInput): Promise<ModelRequest> {
      return {
        systemPrompt,
        messages: session.deriveMessages(),
        tools: tools.list().map(toToolSchema),
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
