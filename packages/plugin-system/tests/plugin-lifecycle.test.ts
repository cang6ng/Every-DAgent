import { createToolRegistry } from "@every-dagent/agent-core";
import type { Tool } from "@every-dagent/agent-core";
import { describe, expect, it } from "vitest";

import { PluginBusyError, createPluginManager } from "../src/index.js";
import type { Plugin, PluginContext, PluginStorage } from "../src/index.js";
import { createMemoryStorage } from "./helpers/memory-storage.js";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Attaches a handler straight away so a rejection is never left unhandled. */
function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => ({ status: "fulfilled" }),
    (error: unknown) => ({ status: "rejected", error }),
  );
}

function toolFrom(name: string): Tool {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    execute: async () => "ok",
  };
}

function pluginFrom(
  id: string,
  activate: (context: PluginContext) => void | Promise<void>,
): Plugin {
  return { manifest: { id, name: "Demo", version: "0.1.0" }, activate };
}

describe("busy rejection", () => {
  it("rejects every lifecycle request while an activation is in flight", async () => {
    const gate = deferred();
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    const rejections: Promise<unknown>[] = [];
    let activations = 0;

    manager.register(
      pluginFrom("demo", async (context) => {
        activations += 1;
        context.tools.register(toolFrom("demo-tool"));
        await gate.promise;
      }),
    );

    const enabling = manager.enable("demo");
    expect(manager.get("demo")?.status).toBe("enabling");
    expect(registry.list()).toEqual([]);

    rejections.push(
      outcomeOf(manager.enable("demo")),
      outcomeOf(manager.disable("demo")),
      outcomeOf(manager.unregister("demo")),
    );

    gate.resolve();
    await enabling;

    expect(activations).toBe(1);
    expect(registry.list().map((tool) => tool.name)).toEqual(["demo-tool"]);
    expect(manager.get("demo")?.status).toBe("enabled");

    for (const outcome of await Promise.all(rejections)) {
      expect(outcome).toEqual({ status: "rejected", error: expect.any(PluginBusyError) });
    }
  });

  it("rejects every lifecycle request while a disable is in flight", async () => {
    const gate = deferred();
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    const rejections: Promise<unknown>[] = [];
    let cleanups = 0;

    manager.register(
      pluginFrom("demo", (context) => {
        context.tools.register(toolFrom("demo-tool"));
        context.onDispose(async () => {
          cleanups += 1;
          await gate.promise;
        });
      }),
    );

    await manager.enable("demo");
    const disabling = manager.disable("demo");

    expect(manager.get("demo")?.status).toBe("disabling");
    expect(registry.list()).toEqual([]);

    rejections.push(
      outcomeOf(manager.enable("demo")),
      outcomeOf(manager.disable("demo")),
      outcomeOf(manager.unregister("demo")),
    );

    gate.resolve();
    await disabling;

    expect(cleanups).toBe(1);
    expect(manager.get("demo")?.status).toBe("disabled");

    for (const outcome of await Promise.all(rejections)) {
      expect(outcome).toEqual({ status: "rejected", error: expect.any(PluginBusyError) });
    }
  });

  it("is busy before activate runs, so reentrant requests are rejected", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    const reentrant: Promise<unknown>[] = [];
    let activations = 0;

    manager.register(
      pluginFrom("demo", () => {
        activations += 1;
        reentrant.push(outcomeOf(manager.enable("demo")), outcomeOf(manager.disable("demo")));
      }),
    );

    await manager.enable("demo");

    expect(activations).toBe(1);
    for (const outcome of await Promise.all(reentrant)) {
      expect(outcome).toEqual({ status: "rejected", error: expect.any(PluginBusyError) });
    }
  });

  it("lets two plugins activate independently", async () => {
    const first = deferred();
    const second = deferred();
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });

    manager.register(
      pluginFrom("first", async () => {
        await first.promise;
      }),
    );
    manager.register(
      pluginFrom("second", async () => {
        await second.promise;
      }),
    );

    const enablingFirst = manager.enable("first");
    const enablingSecond = manager.enable("second");

    second.resolve();
    await enablingSecond;
    expect(manager.get("second")?.status).toBe("enabled");
    expect(manager.get("first")?.status).toBe("enabling");

    first.resolve();
    await enablingFirst;
    expect(manager.get("first")?.status).toBe("enabled");
  });
});

describe("tool staging and commit", () => {
  it("keeps staged tools invisible until the activation finishes", async () => {
    const gate = deferred();
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });

    manager.register(
      pluginFrom("demo", async (context) => {
        context.tools.register(toolFrom("demo-tool"));
        await gate.promise;
      }),
    );

    const enabling = manager.enable("demo");
    expect(registry.get("demo-tool")).toBeUndefined();

    gate.resolve();
    await enabling;

    expect(registry.get("demo-tool")).toBeDefined();
  });

  it("refuses an activation that stages the same tool name twice", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });

    manager.register(
      pluginFrom("demo", (context) => {
        context.tools.register(toolFrom("duplicate"));
        context.tools.register(toolFrom("duplicate"));
      }),
    );

    await expect(manager.enable("demo")).rejects.toThrow(/staged two tools named "duplicate"/);

    expect(registry.list()).toEqual([]);
    expect(manager.get("demo")?.status).toBe("disabled");
    expect(manager.get("demo")?.lastFailure?.phase).toBe("commit");
  });

  it("refuses to overwrite a tool owned by another registration", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    const existing = toolFrom("shared");
    registry.register(existing);
    manager.register(
      pluginFrom("demo", (context) => {
        context.tools.register(toolFrom("shared"));
      }),
    );

    await expect(manager.enable("demo")).rejects.toThrow(
      /already owned by another registration/,
    );

    expect(registry.get("shared")).toBe(existing);
    expect(manager.get("demo")?.status).toBe("disabled");
  });

  it("gives a contested tool name to whichever plugin commits first", async () => {
    const gate = deferred();
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });

    manager.register(
      pluginFrom("first", (context) => {
        context.tools.register(toolFrom("shared"));
      }),
    );
    manager.register(
      pluginFrom("second", async (context) => {
        context.tools.register(toolFrom("shared"));
        await gate.promise;
      }),
    );

    const enablingSecond = manager.enable("second");
    await manager.enable("first");
    gate.resolve();

    await expect(enablingSecond).rejects.toThrow(/already owned by another registration/);
    expect(registry.get("shared")).toBeDefined();
    expect(manager.get("first")?.status).toBe("enabled");
    expect(manager.get("second")?.status).toBe("disabled");
  });

  it("rolls back the tools it already published when a later registration fails", async () => {
    const registry = createToolRegistry();
    const register = registry.register.bind(registry);
    const published: string[] = [];
    let calls = 0;
    registry.register = (tool: Tool) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("registry refused the second tool");
      }
      published.push(tool.name);
      return register(tool);
    };

    const manager = createPluginManager({ tools: registry });
    manager.register(
      pluginFrom("demo", (context) => {
        context.tools.register(toolFrom("first-tool"));
        context.tools.register(toolFrom("second-tool"));
      }),
    );

    await expect(manager.enable("demo")).rejects.toThrow("registry refused the second tool");

    expect(published).toEqual(["first-tool"]);
    expect(registry.list()).toEqual([]);
    expect(manager.get("demo")?.status).toBe("disabled");
    expect(manager.get("demo")?.lastFailure?.phase).toBe("commit");
  });

  it("rolls back already published tools in reverse order", async () => {
    const registry = createToolRegistry();
    const register = registry.register.bind(registry);
    const rolledBack: string[] = [];
    let calls = 0;
    registry.register = (tool: Tool) => {
      calls += 1;
      if (calls === 3) {
        throw new Error("registry refused the third tool");
      }
      const dispose = register(tool);
      return () => {
        rolledBack.push(tool.name);
        dispose();
      };
    };

    const manager = createPluginManager({ tools: registry });
    manager.register(
      pluginFrom("demo", (context) => {
        context.tools.register(toolFrom("first-tool"));
        context.tools.register(toolFrom("second-tool"));
        context.tools.register(toolFrom("third-tool"));
      }),
    );

    await expect(manager.enable("demo")).rejects.toThrow("registry refused the third tool");

    expect(rolledBack).toEqual(["second-tool", "first-tool"]);
    expect(registry.list()).toEqual([]);
  });
});

describe("cleanup", () => {
  it("releases plugin resources newest first, after the tools are gone", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    const order: string[] = [];
    const toolsGone: boolean[] = [];

    manager.register(
      pluginFrom("demo", (context) => {
        context.tools.register(toolFrom("demo-tool"));
        context.onDispose(() => {
          toolsGone.push(registry.get("demo-tool") === undefined);
          order.push("first");
        });
        context.onDispose(() => {
          order.push("second");
        });
      }),
    );

    await manager.enable("demo");
    await manager.disable("demo");

    expect(order).toEqual(["second", "first"]);
    expect(toolsGone).toEqual([true]);
  });

  it("waits for each disposer before starting the next one", async () => {
    const gate = deferred();
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    const order: string[] = [];

    manager.register(
      pluginFrom("demo", (context) => {
        context.onDispose(() => {
          order.push("fast");
        });
        context.onDispose(() => {
          order.push("slow:start");
          return gate.promise.then(() => {
            order.push("slow:end");
          });
        });
      }),
    );

    await manager.enable("demo");
    const disabling = manager.disable("demo");

    expect(order).toEqual(["slow:start"]);

    gate.resolve();
    await disabling;

    expect(order).toEqual(["slow:start", "slow:end", "fast"]);
  });

  it("continues the remaining cleanup after a disposer throws and enters the error state", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    const order: string[] = [];

    manager.register(
      pluginFrom("demo", (context) => {
        context.tools.register(toolFrom("demo-tool"));
        context.onDispose(() => {
          order.push("first");
        });
        context.onDispose(() => {
          throw new Error("dispose boom");
        });
        context.onDispose(() => {
          order.push("third");
        });
      }),
    );

    await manager.enable("demo");
    await expect(manager.disable("demo")).rejects.toThrow(/cleanup failed/);

    const info = manager.get("demo");
    expect(order).toEqual(["third", "first"]);
    expect(registry.list()).toEqual([]);
    expect(info?.status).toBe("error");
    expect(info?.lastFailure).toEqual({
      operation: "disable",
      phase: "dispose",
      message: 'cleanup failed for plugin "demo"',
      cleanupErrors: ["dispose boom"],
    });
  });

  it("keeps the plugin cleanup running when a tool disposer throws", async () => {
    const registry = createToolRegistry();
    const register = registry.register.bind(registry);
    registry.register = (tool: Tool) => {
      register(tool);
      return () => {
        throw new Error("tool disposer boom");
      };
    };

    const manager = createPluginManager({ tools: registry });
    let pluginCleanup = false;
    manager.register(
      pluginFrom("demo", (context) => {
        context.tools.register(toolFrom("demo-tool"));
        context.onDispose(() => {
          pluginCleanup = true;
        });
      }),
    );

    await manager.enable("demo");
    await expect(manager.disable("demo")).rejects.toThrow(/cleanup failed/);

    expect(pluginCleanup).toBe(true);
    expect(manager.get("demo")?.lastFailure?.cleanupErrors).toEqual(["tool disposer boom"]);
  });
});

describe("sealed registration entry points", () => {
  it("rejects late registration after a successful activation", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    let context: PluginContext | undefined;

    manager.register(
      pluginFrom("demo", (ctx) => {
        context = ctx;
      }),
    );
    await manager.enable("demo");

    expect(() => (context as PluginContext).tools.register(toolFrom("late-tool"))).toThrow(/sealed/);
    expect(() => (context as PluginContext).onDispose(() => {})).toThrow(/sealed/);
    expect(registry.list()).toEqual([]);
  });

  it("rejects late registration after a failed activation", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    let context: PluginContext | undefined;

    manager.register(
      pluginFrom("demo", (ctx) => {
        context = ctx;
        throw new Error("activate boom");
      }),
    );
    await expect(manager.enable("demo")).rejects.toThrow("activate boom");

    expect(() => (context as PluginContext).tools.register(toolFrom("late-tool"))).toThrow(/sealed/);
    expect(registry.list()).toEqual([]);
  });

  it("rejects registration from inside cleanup", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    let context: PluginContext | undefined;

    manager.register(
      pluginFrom("demo", (ctx) => {
        context = ctx;
        ctx.onDispose(() => {
          (context as PluginContext).tools.register(toolFrom("too-late"));
        });
      }),
    );

    await manager.enable("demo");
    await expect(manager.disable("demo")).rejects.toThrow(/cleanup failed/);

    expect(manager.get("demo")?.lastFailure?.cleanupErrors).toEqual([
      "tools.register is sealed: this activation already finished",
    ]);
    expect(registry.list()).toEqual([]);
  });
});

describe("storage handle lifetime", () => {
  function storagePlugin(
    id: string,
    activate?: (context: PluginContext) => void | Promise<void>,
  ): { readonly plugin: Plugin; readonly handles: PluginStorage[] } {
    const handles: PluginStorage[] = [];
    return {
      handles,
      plugin: {
        manifest: { id, name: "Demo", version: "0.1.0", permissions: ["storage"] },
        activate: (context) => {
          handles.push(context.capabilities.storage as PluginStorage);
          return activate?.(context);
        },
      },
    };
  }

  function storageManager(
    registry: ReturnType<typeof createToolRegistry>,
    storage: ReturnType<typeof createMemoryStorage>,
  ) {
    return createPluginManager({
      tools: registry,
      grants: { demo: ["storage"] },
      storage: storage.view,
    });
  }

  it("keeps the handle usable while cleanup runs", async () => {
    const storage = createMemoryStorage();
    const registry = createToolRegistry();
    const manager = storageManager(registry, storage);
    const observed: (string | undefined)[] = [];
    const { plugin } = storagePlugin("demo", (context) => {
      context.onDispose(async () => {
        await context.capabilities.storage?.set("closed", "yes");
        observed.push(await context.capabilities.storage?.get("closed"));
      });
    });
    manager.register(plugin);

    await manager.enable("demo");
    await manager.disable("demo");

    expect(observed).toEqual(["yes"]);
    expect(storage.entries("demo").get("closed")).toBe("yes");
  });

  it("rejects every method of a stale handle once cleanup has finished", async () => {
    const storage = createMemoryStorage();
    const registry = createToolRegistry();
    const manager = storageManager(registry, storage);
    const { plugin, handles } = storagePlugin("demo");
    manager.register(plugin);

    await manager.enable("demo");
    const handle = handles[0] as PluginStorage;
    await handle.set("key", "value");
    await manager.disable("demo");

    await expect(handle.get("key")).rejects.toThrow(/no longer valid/);
    await expect(handle.set("key", "other")).rejects.toThrow(/no longer valid/);
    await expect(handle.delete("key")).rejects.toThrow(/no longer valid/);
    expect(storage.entries("demo").get("key")).toBe("value");
  });

  it("hands out a fresh handle on re-enable and keeps the old one invalid", async () => {
    const storage = createMemoryStorage();
    const registry = createToolRegistry();
    const manager = storageManager(registry, storage);
    const { plugin, handles } = storagePlugin("demo");
    manager.register(plugin);

    await manager.enable("demo");
    const first = handles[0] as PluginStorage;
    await first.set("key", "value");
    await manager.disable("demo");
    await manager.enable("demo");
    const second = handles[1] as PluginStorage;

    expect(second).not.toBe(first);
    await expect(first.get("key")).rejects.toThrow(/no longer valid/);
    expect(await second.get("key")).toBe("value");
  });

  it("rejects a stale handle after a failed activation", async () => {
    const storage = createMemoryStorage();
    const registry = createToolRegistry();
    const manager = storageManager(registry, storage);
    const { plugin, handles } = storagePlugin("demo", () => {
      throw new Error("activate boom");
    });
    manager.register(plugin);

    await expect(manager.enable("demo")).rejects.toThrow("activate boom");

    await expect((handles[0] as PluginStorage).get("key")).rejects.toThrow(/no longer valid/);
  });

  it("rejects a stale handle after a cleanup failure", async () => {
    const storage = createMemoryStorage();
    const registry = createToolRegistry();
    const manager = storageManager(registry, storage);
    const { plugin, handles } = storagePlugin("demo", (context) => {
      context.onDispose(() => {
        throw new Error("dispose boom");
      });
    });
    manager.register(plugin);

    await manager.enable("demo");
    await expect(manager.disable("demo")).rejects.toThrow(/cleanup failed/);

    expect(manager.get("demo")?.status).toBe("error");
    await expect((handles[0] as PluginStorage).get("key")).rejects.toThrow(/no longer valid/);
  });
});
