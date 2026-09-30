/**
 * The second runtime plugin: a real tool, registered by a real plugin, with no
 * relation to the calculator.
 *
 * The acceptance matrix needs a plugin that proves the platform is not a
 * calculator demo: the same generic card has to show its tool, its activation
 * has to change what the model is offered, and disabling it has to take the
 * tool away. It is a root fixture because it is registered by a Host
 * composition — product code must not know this plugin exists.
 */

import type { Tool } from "@every-dagent/agent-core";
import type { Plugin, PluginContext } from "@every-dagent/plugin-system";

export interface TextStats {
  readonly characters: number;
  readonly words: number;
}

export interface TextStatsPluginFixture {
  readonly plugin: Plugin;
  /** Every input the tool really received, in order. */
  readonly executions: readonly unknown[];
}

export function textStatsPlugin(): TextStatsPluginFixture {
  const executions: unknown[] = [];

  const tool: Tool<{ readonly text: string }, string> = {
    name: "text-stats",
    description: "Counts the characters and words of a text and returns them as JSON.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The text to measure." } },
      required: ["text"],
    },
    async execute(input: { readonly text: string }): Promise<string> {
      executions.push(input);
      const text = input?.text;
      if (typeof text !== "string") throw new Error("text-stats expects { text: string }");
      const stats: TextStats = {
        characters: [...text].length,
        words: text.trim() === "" ? 0 : text.trim().split(/\s+/).length,
      };
      return JSON.stringify(stats);
    },
  };

  return {
    plugin: {
      manifest: {
        id: "text-stats",
        name: "Text Stats",
        version: "1.0.0",
        description: "Measures a text: characters and words.",
      },
      activate(context: PluginContext): void {
        context.tools.register(tool);
      },
    },
    executions,
  };
}
