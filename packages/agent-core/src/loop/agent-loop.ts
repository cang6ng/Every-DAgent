import type { ContextBuilder } from "../context/context-builder.js";
import type { ToolCall } from "../model/message.js";
import type { ModelClient, ModelRequest } from "../model/model-client.js";
import type { RuntimeContext } from "../runtime/runtime-context.js";
import type { Session } from "../session/session.js";
import type { ToolExecutionResult } from "../tools/tool.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

export interface AgentLoopDeps {
  readonly modelClient: ModelClient;
  readonly tools: ToolRegistry;
  readonly contextBuilder: ContextBuilder;
}

export interface AgentLoopInput {
  readonly session: Session;
  readonly turnId: string;
  readonly context: RuntimeContext;
}

/**
 * The ReAct orchestrator: it consumes the other Core modules and reimplements
 * none of them.
 *
 * It owns everything inside a turn — one `message/assistant` per model step, the
 * `tool/call` dispatch record and the `tool/result` observation. The turn
 * boundary itself (`turn/start`, `message/user`, `turn/end`) belongs to the
 * AgentRuntime, which is also the only producer of `turnId`.
 */
export interface AgentLoop {
  /**
   * Runs one turn to completion and returns the final assistant text.
   *
   * The turn must already be framed (`turn/start`) with its input recorded. The
   * loop never reads the log itself: every step re-derives the request through
   * the ContextBuilder, so the session log stays the single source of truth.
   */
  runTurn(input: AgentLoopInput): Promise<string>;
}

export function createAgentLoop(deps: AgentLoopDeps): AgentLoop {
  return { runTurn: (input: AgentLoopInput): Promise<string> => runTurn(deps, input) };
}

async function runTurn(deps: AgentLoopDeps, { session, turnId, context }: AgentLoopInput): Promise<string> {
  for (;;) {
    const request: ModelRequest = await deps.contextBuilder.build({
      session,
      tools: deps.tools,
      context,
    });

    const step = await runModelStep(deps.modelClient, request, context);

    session.append({
      type: "message/assistant",
      turnId,
      data: { text: step.text, toolCalls: step.toolCalls },
    });

    // No tool call is the one and only termination condition: the step that asks
    // for nothing carries the final answer.
    if (step.toolCalls.length === 0) return step.text;

    for (const call of step.toolCalls) {
      session.append({
        type: "tool/call",
        turnId,
        data: { callId: call.callId, name: call.name, input: call.input },
      });

      // v0.1 runs tools one at a time, and each call is fully settled before the
      // next one starts, so the log reads as alternating call/result pairs.
      const result = await deps.tools.execute(call.name, call.input, context);

      session.append({
        type: "tool/result",
        turnId,
        data: {
          callId: call.callId,
          name: call.name,
          ok: result.ok,
          content: toolResultContent(result),
        },
      });
    }
  }
}

interface AssistantStep {
  readonly text: string;
  readonly toolCalls: ToolCall[];
}

/**
 * Consumes one model step. `done` terminates the step; a stream that ends
 * without it is just as complete, which keeps a lenient adapter within contract.
 */
async function runModelStep(
  modelClient: ModelClient,
  request: ModelRequest,
  context: RuntimeContext,
): Promise<AssistantStep> {
  let text = "";
  const toolCalls: ToolCall[] = [];

  modelStep: for await (const event of modelClient.stream(request, context)) {
    switch (event.type) {
      case "text-delta":
        text += event.text;
        break;

      case "tool-call":
        // Shallow copy: a client that keeps its own reference to the call it
        // emitted must not be able to reach back into what this step recorded.
        // `input` stays by reference, exactly as Session.deriveMessages treats it.
        toolCalls.push({ ...event.call });
        break;

      case "done":
        break modelStep;
    }
  }

  return { text, toolCalls };
}

/**
 * Where a tool outcome becomes model-visible text — the only place, since
 * `content` is a string while a tool may return anything.
 *
 * Deliberately total: JSON cannot represent `undefined` (it yields `undefined`
 * rather than a string) and refuses circular structures. Letting either escape
 * would undo the registry's "never throws at the caller" contract one layer up.
 */
function toolResultContent(result: ToolExecutionResult): string {
  if (!result.ok) return result.error;
  if (typeof result.value === "string") return result.value;

  try {
    return JSON.stringify(result.value) ?? String(result.value);
  } catch {
    return "<unserializable tool result>";
  }
}
