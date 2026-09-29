/**
 * Model scripts and a plugin with a real tool, built at the composition root.
 *
 * These are root-level fixtures on purpose: the integration tests reach every
 * package through its public entry, and a scripted model that lived inside a
 * package's own tests would be a second way in.
 */

import type { ModelClient, ModelEvent, ModelRequest, RuntimeContext, Tool } from "@every-dagent/agent-core";
import type { Plugin, PluginContext } from "@every-dagent/plugin-system";

export type ModelReply =
  | readonly ModelEvent[]
  | ((request: ModelRequest, context: RuntimeContext) => AsyncIterable<ModelEvent>);

export interface ScriptedModel {
  readonly client: ModelClient;
  readonly requests: ModelRequest[];
}

/**
 * Replays one reply per `stream()` call.
 *
 * The script is never recycled, so a host that calls the model once more than
 * the test planned fails loudly instead of quietly repeating an answer.
 */
export function scriptedModel(replies: readonly ModelReply[]): ScriptedModel {
  const requests: ModelRequest[] = [];
  let calls = 0;

  const client: ModelClient = {
    stream(request: ModelRequest, context: RuntimeContext): AsyncIterable<ModelEvent> {
      requests.push(request);
      const reply = replies[calls];
      calls += 1;
      if (reply === undefined) throw new Error("the scripted model client ran out of replies");
      return typeof reply === "function" ? reply(request, context) : replay(reply);
    },
  };

  return { client, requests };
}

async function* replay(events: readonly ModelEvent[]): AsyncGenerator<ModelEvent> {
  yield* events;
}

/** One step that asks for a tool. */
export function toolReply(callId: string, name: string, input: unknown): readonly ModelEvent[] {
  return [
    { type: "tool-call", call: { callId, name, input } },
    { type: "done" },
  ];
}

/** One step that answers with text. */
export function textReply(text: string): readonly ModelEvent[] {
  return [
    { type: "text-delta", text },
    { type: "done" },
  ];
}

/**
 * A step that says something and then waits for the turn to be aborted: the
 * draft that must not become history.
 */
export function partialThenAbortReply(text: string): ModelReply {
  return async function* (_request: ModelRequest, context: RuntimeContext): AsyncGenerator<ModelEvent> {
    yield { type: "text-delta", text };
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) {
        resolve();
        return;
      }
      context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
}

/**
 * A step that waits for a gate this test controls, then answers.
 *
 * The run is genuinely in flight while the client is not looking, which is what
 * the disconnect and response-loss scenarios need.
 */
export function gatedReply(gate: Promise<void>, then: readonly ModelEvent[]): ModelReply {
  return async function* (): AsyncGenerator<ModelEvent> {
    await gate;
    yield* then;
  };
}

/** A plugin that registers one tool and counts its executions. */
export interface DemoPlugin {
  readonly plugin: Plugin;
  readonly executions: { readonly input: unknown }[];
}

export function demoPlugin(pluginId: string, toolName: string, answer = "tool answered"): DemoPlugin {
  const executions: { input: unknown }[] = [];

  const tool: Tool = {
    name: toolName,
    description: `The ${toolName} tool.`,
    inputSchema: { type: "object" },
    execute: async (input: unknown) => {
      executions.push({ input });
      return answer;
    },
  };

  return {
    plugin: {
      manifest: {
        id: pluginId,
        name: `Plugin ${pluginId}`,
        version: "1.0.0",
        description: "A demo plugin with one tool.",
      },
      activate: (context: PluginContext): void => {
        context.tools.register(tool);
      },
    },
    executions,
  };
}
