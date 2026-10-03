import type { Tool } from "@every-dagent/agent-core";
import type { Plugin } from "@every-dagent/plugin-system";

import { createCalculatorTool } from "./calculator.js";

/**
 * The calculator as a plugin: the tool exists exactly while the plugin is
 * enabled. The manager owns the registry disposer, so this activation has
 * nothing of its own to clean up.
 *
 * The tool may be handed in, and a trusted composition that classifies tools
 * *should* hand one in: a policy speaks about tool identities, so the object
 * the policy names and the object the plugin registers have to be the same
 * one. Called with no argument the plugin builds its own tool, which keeps
 * every existing composition working — it simply leaves the tool unclassifiable
 * by identity.
 */
export function createCalculatorPlugin(tool: Tool = createCalculatorTool()): Plugin {
  return {
    manifest: {
      id: "calculator",
      name: "Calculator",
      version: "0.1.0",
    },
    activate(context) {
      context.tools.register(tool);
    },
  };
}

export { createCalculatorTool };
