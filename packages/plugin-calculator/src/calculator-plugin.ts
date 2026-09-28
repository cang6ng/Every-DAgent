import type { Plugin } from "@every-dagent/plugin-system";

import { createCalculatorTool } from "./calculator.js";

/**
 * The calculator as a plugin: the tool exists exactly while the plugin is
 * enabled. The manager owns the registry disposer, so this activation has
 * nothing of its own to clean up.
 */
export function createCalculatorPlugin(): Plugin {
  return {
    manifest: {
      id: "calculator",
      name: "Calculator",
      version: "0.1.0",
    },
    activate(context) {
      context.tools.register(createCalculatorTool());
    },
  };
}
