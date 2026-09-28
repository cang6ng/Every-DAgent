import { createToolRegistry } from "@every-dagent/agent-core";
import type { RuntimeContext, Tool } from "@every-dagent/agent-core";
import { createPluginManager } from "@every-dagent/plugin-system";
import { describe, expect, it } from "vitest";

import { createCalculatorPlugin, createCalculatorTool } from "../src/index.js";

const context: RuntimeContext = { sessionId: "s-1", signal: new AbortController().signal };

describe("calculator plugin", () => {
  it("declares the calculator plugin without permissions", () => {
    const plugin = createCalculatorPlugin();

    expect(plugin.manifest.id).toBe("calculator");
    expect(plugin.manifest.name).toBe("Calculator");
    expect(plugin.manifest.version).toBe("0.1.0");
    expect(plugin.manifest.permissions).toBeUndefined();
  });

  it("publishes the calculator tool while it is enabled", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    manager.register(createCalculatorPlugin());

    await manager.enable("calculator");

    expect(registry.list().map((tool) => tool.name)).toEqual(["calculator"]);
    await expect(registry.get("calculator")?.execute({ a: 21, b: 2 }, context)).resolves.toBe(42);

    await manager.disable("calculator");

    expect(registry.list()).toEqual([]);
  });

  it("stages the same tool contract the package exports", async () => {
    const staged: Tool[] = [];
    await createCalculatorPlugin().activate({
      pluginId: "calculator",
      tools: {
        register: (tool) => {
          staged.push(tool);
        },
      },
      capabilities: {},
      onDispose: () => {},
    });

    const direct = createCalculatorTool();
    expect(staged).toHaveLength(1);
    expect(staged[0]?.name).toBe(direct.name);
    expect(staged[0]?.inputSchema).toEqual(direct.inputSchema);
  });
});
