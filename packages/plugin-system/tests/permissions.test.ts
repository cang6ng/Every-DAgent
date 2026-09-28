import { createToolRegistry } from "@every-dagent/agent-core";
import type { Tool } from "@every-dagent/agent-core";
import { describe, expect, it } from "vitest";

import { createPluginManager } from "../src/index.js";
import type { Plugin, PluginCapabilities, PluginContext, PluginStorage } from "../src/index.js";
import { createMemoryStorage } from "./helpers/memory-storage.js";

function toolFrom(name: string): Tool {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    execute: async () => "ok",
  };
}

function storagePlugin(
  id: string,
  activate: (context: PluginContext) => void | Promise<void>,
): Plugin {
  return {
    manifest: { id, name: "Demo", version: "0.1.0", permissions: ["storage"] },
    activate,
  };
}

/** Captures the storage handle of every activation a plugin goes through. */
function capturingHandle(): {
  readonly handles: PluginStorage[];
  readonly activate: (context: PluginContext) => void;
} {
  const handles: PluginStorage[] = [];
  return {
    handles,
    activate: (context) => {
      handles.push(context.capabilities.storage as PluginStorage);
    },
  };
}

describe("storage capability", () => {
  it("injects a scoped view when declared, granted and provided", async () => {
    const storage = createMemoryStorage();
    const registry = createToolRegistry();
    const requested: string[] = [];
    const manager = createPluginManager({
      tools: registry,
      grants: { demo: ["storage"] },
      storage: (pluginId) => {
        requested.push(pluginId);
        return storage.view(pluginId);
      },
    });
    let capabilities: PluginCapabilities | undefined;
    manager.register(
      storagePlugin("demo", (context) => {
        capabilities = context.capabilities;
      }),
    );

    await manager.enable("demo");

    expect(requested).toEqual(["demo"]);
    expect(storage.factoryCalls()).toBe(1);
    const handle = capabilities?.storage as PluginStorage;

    await handle.set("greeting", "hello");
    expect(await handle.get("greeting")).toBe("hello");
    await handle.delete("greeting");
    expect(await handle.get("greeting")).toBeUndefined();
    expect(storage.entries("demo").size).toBe(0);
  });

  it("withholds storage unless declared, granted and provided", async () => {
    const registry = createToolRegistry();
    const storage = createMemoryStorage();

    // undeclared: no capability, and the host is never asked for a view
    const undeclared = createPluginManager({
      tools: registry,
      grants: { demo: ["storage"] },
      storage: storage.view,
    });
    let undeclaredCapabilities: PluginCapabilities | undefined;
    undeclared.register({
      manifest: { id: "demo", name: "Demo", version: "0.1.0" },
      activate: (context) => {
        undeclaredCapabilities = context.capabilities;
      },
    });
    await undeclared.enable("demo");

    expect(undeclaredCapabilities?.storage).toBeUndefined();
    expect(storage.factoryCalls()).toBe(0);

    // declared but not granted
    const ungranted = createPluginManager({ tools: registry, storage: storage.view });
    let ungrantedActivations = 0;
    ungranted.register(
      storagePlugin("demo", () => {
        ungrantedActivations += 1;
      }),
    );
    await expect(ungranted.enable("demo")).rejects.toThrow(/has not granted it/);

    expect(ungrantedActivations).toBe(0);
    expect(storage.factoryCalls()).toBe(0);

    // granted but not provided
    const unprovided = createPluginManager({ tools: registry, grants: { demo: ["storage"] } });
    let unprovidedActivations = 0;
    unprovided.register(
      storagePlugin("demo", () => {
        unprovidedActivations += 1;
      }),
    );
    await expect(unprovided.enable("demo")).rejects.toThrow(/provides no storage implementation/);

    expect(unprovidedActivations).toBe(0);
    expect(storage.factoryCalls()).toBe(0);
  });

  it("refuses the activation when the storage factory throws", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({
      tools: registry,
      grants: { demo: ["storage"] },
      storage: () => {
        throw new Error("factory boom");
      },
    });
    let activations = 0;
    manager.register(
      storagePlugin("demo", (context) => {
        activations += 1;
        context.tools.register(toolFrom("demo-tool"));
      }),
    );

    await expect(manager.enable("demo")).rejects.toThrow("factory boom");

    expect(activations).toBe(0);
    expect(registry.list()).toEqual([]);
    expect(manager.get("demo")?.status).toBe("disabled");
    expect(manager.get("demo")?.lastFailure).toEqual({
      operation: "enable",
      phase: "permissions",
      message: "factory boom",
      cleanupErrors: [],
    });
  });

  it("keeps each plugin's namespace isolated", async () => {
    const storage = createMemoryStorage();
    const registry = createToolRegistry();
    const manager = createPluginManager({
      tools: registry,
      grants: { alpha: ["storage"], beta: ["storage"] },
      storage: storage.view,
    });
    const handles = new Map<string, PluginStorage>();
    manager.register(
      storagePlugin("alpha", (context) => {
        handles.set("alpha", context.capabilities.storage as PluginStorage);
      }),
    );
    manager.register(
      storagePlugin("beta", (context) => {
        handles.set("beta", context.capabilities.storage as PluginStorage);
      }),
    );

    await manager.enable("alpha");
    await manager.enable("beta");

    const alpha = handles.get("alpha") as PluginStorage;
    const beta = handles.get("beta") as PluginStorage;
    await alpha.set("shared-key", "alpha-value");

    expect(await beta.get("shared-key")).toBeUndefined();

    await beta.set("shared-key", "beta-value");

    expect(await alpha.get("shared-key")).toBe("alpha-value");
    expect(storage.entries("alpha").get("shared-key")).toBe("alpha-value");
    expect(storage.entries("beta").get("shared-key")).toBe("beta-value");
  });

  it("keeps host data when a plugin is disabled or unregistered", async () => {
    const storage = createMemoryStorage();
    const registry = createToolRegistry();
    const manager = createPluginManager({
      tools: registry,
      grants: { demo: ["storage"] },
      storage: storage.view,
    });
    const capture = capturingHandle();
    manager.register(storagePlugin("demo", capture.activate));

    await manager.enable("demo");
    await capture.handles[0]?.set("kept", "value");
    await manager.disable("demo");

    expect(storage.entries("demo").get("kept")).toBe("value");

    await manager.enable("demo");
    await manager.unregister("demo");

    expect(storage.entries("demo").get("kept")).toBe("value");
  });

  it("propagates host storage failures as rejections", async () => {
    const registry = createToolRegistry();
    const failing: PluginStorage = {
      get: async () => {
        throw new Error("backend down");
      },
      set: async () => {
        throw new Error("backend down");
      },
      delete: async () => {
        throw new Error("backend down");
      },
    };
    const manager = createPluginManager({
      tools: registry,
      grants: { demo: ["storage"] },
      storage: () => failing,
    });
    const capture = capturingHandle();
    manager.register(storagePlugin("demo", capture.activate));

    await manager.enable("demo");
    const handle = capture.handles[0] as PluginStorage;

    await expect(handle.get("key")).rejects.toThrow("backend down");
    await expect(handle.set("key", "value")).rejects.toThrow("backend down");
    await expect(handle.delete("key")).rejects.toThrow("backend down");
  });

  it("turns a synchronous host throw into a rejection", async () => {
    const registry = createToolRegistry();
    const throwing = {
      get: () => {
        throw new Error("sync boom");
      },
      set: () => {
        throw new Error("sync boom");
      },
      delete: () => {
        throw new Error("sync boom");
      },
    } as unknown as PluginStorage;
    const manager = createPluginManager({
      tools: registry,
      grants: { demo: ["storage"] },
      storage: () => throwing,
    });
    const capture = capturingHandle();
    manager.register(storagePlugin("demo", capture.activate));

    await manager.enable("demo");

    await expect((capture.handles[0] as PluginStorage).get("key")).rejects.toThrow("sync boom");
  });
});
