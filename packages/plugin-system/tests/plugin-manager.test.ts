import { createToolRegistry } from "@every-dagent/agent-core";
import type { Tool } from "@every-dagent/agent-core";
import { describe, expect, it } from "vitest";

import { createPluginManager } from "../src/index.js";
import type {
  Plugin,
  PluginCapabilities,
  PluginContext,
  PluginPermission,
  PluginStorage,
} from "../src/index.js";

function toolFrom(name: string): Tool {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    execute: async () => "ok",
  };
}

interface PluginOptions {
  readonly activate?: (context: PluginContext) => void | Promise<void>;
  readonly permissions?: readonly PluginPermission[];
  readonly name?: string;
}

function pluginFrom(id: string, options: PluginOptions = {}): Plugin {
  const manifest = { id, name: options.name ?? "Demo", version: "0.1.0" };
  return {
    manifest:
      options.permissions === undefined ? manifest : { ...manifest, permissions: options.permissions },
    activate: options.activate ?? (() => {}),
  };
}

function storageStub(): PluginStorage {
  return {
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
  };
}

describe("register", () => {
  it("registers a plugin as disabled without publishing anything", () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    let activations = 0;

    manager.register(
      pluginFrom("demo", {
        activate: () => {
          activations += 1;
        },
      }),
    );

    const info = manager.get("demo");
    expect(info?.manifest.id).toBe("demo");
    expect(info?.status).toBe("disabled");
    expect(info?.lastFailure).toBeUndefined();
    expect(activations).toBe(0);
    expect(registry.list()).toEqual([]);
    expect(manager.list()).toHaveLength(1);
  });

  it("keeps the manifest snapshot detached from the caller's object", () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    const manifest = {
      id: "demo",
      name: "Demo",
      version: "0.1.0",
      permissions: ["storage"] as PluginPermission[],
    };

    manager.register({ manifest, activate: () => {} });
    manifest.name = "Renamed";
    manifest.permissions.length = 0;

    const info = manager.get("demo");
    expect(info?.manifest.name).toBe("Demo");
    expect(info?.manifest.permissions).toEqual(["storage"]);
    expect(Object.isFrozen(info)).toBe(true);
    expect(Object.isFrozen(info?.manifest)).toBe(true);
    expect(Object.isFrozen(info?.manifest.permissions)).toBe(true);
  });

  it("rejects a duplicate id synchronously without replacing the first registration", () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    manager.register(pluginFrom("demo", { name: "First" }));

    expect(() => manager.register(pluginFrom("demo", { name: "Second" }))).toThrow(
      /plugin "demo" is already registered/,
    );
    expect(manager.get("demo")?.manifest.name).toBe("First");
    expect(manager.list()).toHaveLength(1);
  });

  it("rejects invalid manifests synchronously", () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });

    expect(() =>
      manager.register({ manifest: { id: "Demo", name: "Demo", version: "0.1.0" }, activate: () => {} }),
    ).toThrow(/plugin id must match/);
    expect(() =>
      manager.register({ manifest: { id: "demo", name: " ", version: "0.1.0" }, activate: () => {} }),
    ).toThrow(/non-blank string/);
    expect(() =>
      manager.register({
        manifest: {
          id: "demo",
          name: "Demo",
          version: "0.1.0",
          permissions: ["network"] as unknown as PluginPermission[],
        },
        activate: () => {},
      }),
    ).toThrow(/unsupported permission/);

    expect(manager.list()).toEqual([]);
  });

  it("rejects a value that is not a plugin object", () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });

    expect(() => manager.register(undefined as unknown as Plugin)).toThrow(/must be an object/);
  });
});

describe("directory snapshots", () => {
  it("returns undefined for an unknown id and preserves registration order", () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    manager.register(pluginFrom("alpha"));
    manager.register(pluginFrom("beta"));

    expect(manager.get("missing")).toBeUndefined();
    expect(manager.list().map((info) => info.manifest.id)).toEqual(["alpha", "beta"]);
    expect(Object.isFrozen(manager.list())).toBe(true);
  });

  it("reports only manifest, status and the last failure", () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    manager.register(pluginFrom("demo"));

    expect(Object.keys(manager.get("demo") ?? {})).toEqual(["manifest", "status"]);
  });

  it("does not show later transitions in an earlier snapshot", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    manager.register(pluginFrom("demo"));

    const before = manager.get("demo");
    await manager.enable("demo");

    expect(before?.status).toBe("disabled");
    expect(manager.get("demo")?.status).toBe("enabled");
  });
});

describe("enable and disable", () => {
  it("publishes every staged tool of a plugin together", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    manager.register(
      pluginFrom("demo", {
        activate: (context) => {
          context.tools.register(toolFrom("first-tool"));
          context.tools.register(toolFrom("second-tool"));
        },
      }),
    );

    await manager.enable("demo");

    expect(registry.list().map((tool) => tool.name)).toEqual(["first-tool", "second-tool"]);
    expect(manager.get("demo")?.status).toBe("enabled");
  });

  it("gives an undeclared plugin no capabilities and never calls the storage factory", async () => {
    const registry = createToolRegistry();
    let factoryCalls = 0;
    const manager = createPluginManager({
      tools: registry,
      storage: () => {
        factoryCalls += 1;
        return storageStub();
      },
    });
    let capabilities: PluginCapabilities | undefined;
    manager.register(
      pluginFrom("demo", {
        activate: (context) => {
          capabilities = context.capabilities;
        },
      }),
    );

    await manager.enable("demo");

    expect(capabilities).toBeDefined();
    expect(Object.keys(capabilities ?? {})).toEqual([]);
    expect(capabilities?.storage).toBeUndefined();
    expect(factoryCalls).toBe(0);
  });

  it("treats enable on an enabled plugin as a no-op", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    let activations = 0;
    manager.register(
      pluginFrom("demo", {
        activate: (context) => {
          activations += 1;
          context.tools.register(toolFrom("demo-tool"));
        },
      }),
    );

    await manager.enable("demo");
    await manager.enable("demo");

    expect(activations).toBe(1);
    expect(registry.list().map((tool) => tool.name)).toEqual(["demo-tool"]);
  });

  it("removes the plugin's tools on disable and treats a second disable as a no-op", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    let cleanups = 0;
    manager.register(
      pluginFrom("demo", {
        activate: (context) => {
          context.tools.register(toolFrom("demo-tool"));
          context.onDispose(() => {
            cleanups += 1;
          });
        },
      }),
    );

    await manager.enable("demo");
    await manager.disable("demo");

    expect(registry.list()).toEqual([]);
    expect(manager.get("demo")?.status).toBe("disabled");
    expect(cleanups).toBe(1);

    await manager.disable("demo");
    expect(cleanups).toBe(1);
  });

  it("keeps another plugin's tools when one plugin is disabled", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    manager.register(
      pluginFrom("first", {
        activate: (context) => {
          context.tools.register(toolFrom("first-tool"));
        },
      }),
    );
    manager.register(
      pluginFrom("second", {
        activate: (context) => {
          context.tools.register(toolFrom("second-tool"));
        },
      }),
    );

    await manager.enable("first");
    await manager.enable("second");
    await manager.disable("first");

    expect(registry.list().map((tool) => tool.name)).toEqual(["second-tool"]);
    expect(manager.get("first")?.status).toBe("disabled");
    expect(manager.get("second")?.status).toBe("enabled");
  });

  it("rejects enable and disable for an unknown id and ignores unregister", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });

    await expect(manager.enable("missing")).rejects.toThrow(/plugin "missing" is not registered/);
    await expect(manager.disable("missing")).rejects.toThrow(/plugin "missing" is not registered/);
    await expect(manager.unregister("missing")).resolves.toBeUndefined();
  });
});

describe("unregister", () => {
  it("removes a disabled plugin without activating it", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    let activations = 0;
    manager.register(
      pluginFrom("demo", {
        activate: () => {
          activations += 1;
        },
      }),
    );

    await manager.unregister("demo");

    expect(manager.get("demo")).toBeUndefined();
    expect(activations).toBe(0);
  });

  it("releases an enabled plugin's registrations before deleting the record", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    const order: string[] = [];
    manager.register(
      pluginFrom("demo", {
        activate: (context) => {
          context.tools.register(toolFrom("demo-tool"));
          context.onDispose(() => {
            order.push(`disposed:registry-empty=${registry.list().length === 0}`);
          });
        },
      }),
    );

    await manager.enable("demo");
    await manager.unregister("demo");

    expect(order).toEqual(["disposed:registry-empty=true"]);
    expect(manager.get("demo")).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("keeps the record in the error state when unregister cleanup fails", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    manager.register(
      pluginFrom("demo", {
        activate: (context) => {
          context.onDispose(() => {
            throw new Error("dispose boom");
          });
        },
      }),
    );

    await manager.enable("demo");
    await expect(manager.unregister("demo")).rejects.toThrow(/cleanup failed/);

    const info = manager.get("demo");
    expect(info?.status).toBe("error");
    expect(info?.lastFailure).toEqual({
      operation: "disable",
      phase: "dispose",
      message: 'cleanup failed for plugin "demo"',
      cleanupErrors: ["dispose boom"],
    });
  });
});

describe("activation failure", () => {
  it("returns to disabled with a failure record when activation throws", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    manager.register(
      pluginFrom("demo", {
        activate: (context) => {
          context.tools.register(toolFrom("demo-tool"));
          throw new Error("activate boom");
        },
      }),
    );

    await expect(manager.enable("demo")).rejects.toThrow("activate boom");

    const info = manager.get("demo");
    expect(info?.status).toBe("disabled");
    expect(info?.lastFailure).toEqual({
      operation: "enable",
      phase: "activate",
      message: "activate boom",
      cleanupErrors: [],
    });
    expect(registry.list()).toEqual([]);
  });

  it("clears the failure record when a later enable succeeds", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    let attempts = 0;
    manager.register(
      pluginFrom("demo", {
        activate: (context) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("first attempt failed");
          }
          context.tools.register(toolFrom("demo-tool"));
        },
      }),
    );

    await expect(manager.enable("demo")).rejects.toThrow("first attempt failed");
    expect(manager.get("demo")?.lastFailure?.message).toBe("first attempt failed");

    await manager.enable("demo");

    expect(manager.get("demo")?.status).toBe("enabled");
    expect(manager.get("demo")?.lastFailure).toBeUndefined();
    expect(registry.list().map((tool) => tool.name)).toEqual(["demo-tool"]);
  });

  it("enters the error state when the rollback cleanup also fails", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    manager.register(
      pluginFrom("demo", {
        activate: (context) => {
          context.onDispose(() => {
            throw new Error("dispose boom");
          });
          throw new Error("activate boom");
        },
      }),
    );

    await expect(manager.enable("demo")).rejects.toThrow("activate boom");

    const info = manager.get("demo");
    expect(info?.status).toBe("error");
    expect(info?.lastFailure).toEqual({
      operation: "enable",
      phase: "activate",
      message: "activate boom",
      cleanupErrors: ["dispose boom"],
    });
  });

  it("rejects every lifecycle request in the error state without retrying cleanup", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    let disposals = 0;
    manager.register(
      pluginFrom("demo", {
        activate: (context) => {
          context.onDispose(() => {
            disposals += 1;
            throw new Error("dispose boom");
          });
          throw new Error("activate boom");
        },
      }),
    );

    await expect(manager.enable("demo")).rejects.toThrow("activate boom");

    await expect(manager.enable("demo")).rejects.toThrow(/is in the error state/);
    await expect(manager.disable("demo")).rejects.toThrow(/is in the error state/);
    await expect(manager.unregister("demo")).rejects.toThrow(/is in the error state/);

    expect(disposals).toBe(1);
    expect(manager.get("demo")?.status).toBe("error");
  });

  it("keeps the failure record when other requests are rejected", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    manager.register(
      pluginFrom("demo", {
        activate: () => {
          throw new Error("activate boom");
        },
      }),
    );

    await expect(manager.enable("demo")).rejects.toThrow("activate boom");

    expect(() => manager.register(pluginFrom("demo"))).toThrow(/already registered/);
    await expect(manager.enable("other")).rejects.toThrow(/not registered/);
    await manager.disable("demo");

    expect(manager.get("demo")?.lastFailure?.message).toBe("activate boom");
  });

  it("normalises a non-Error throw into the failure record", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    const unprintable = Object.create(null) as object;
    manager.register(
      pluginFrom("string-throw", {
        activate: () => {
          throw "plain failure";
        },
      }),
    );
    manager.register(
      pluginFrom("unprintable-throw", {
        activate: () => {
          throw unprintable;
        },
      }),
    );

    await expect(manager.enable("string-throw")).rejects.toBe("plain failure");
    expect(manager.get("string-throw")?.lastFailure?.message).toBe("plain failure");

    await expect(manager.enable("unprintable-throw")).rejects.toBe(unprintable);
    expect(manager.get("unprintable-throw")?.lastFailure?.message).toBe(
      "<unprintable thrown value>",
    );
  });
});

describe("permission policy", () => {
  it("refuses storage that the host never granted", async () => {
    const registry = createToolRegistry();
    let factoryCalls = 0;
    const manager = createPluginManager({
      tools: registry,
      storage: () => {
        factoryCalls += 1;
        return storageStub();
      },
    });
    let activations = 0;
    manager.register(
      pluginFrom("demo", {
        permissions: ["storage"],
        activate: () => {
          activations += 1;
        },
      }),
    );

    await expect(manager.enable("demo")).rejects.toThrow(/declares storage but the host has not granted/);

    expect(factoryCalls).toBe(0);
    expect(activations).toBe(0);
    expect(manager.get("demo")?.status).toBe("disabled");
    expect(manager.get("demo")?.lastFailure?.phase).toBe("permissions");
  });

  it("refuses storage when the host has no implementation", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry, grants: { demo: ["storage"] } });
    let activations = 0;
    manager.register(
      pluginFrom("demo", {
        permissions: ["storage"],
        activate: () => {
          activations += 1;
        },
      }),
    );

    await expect(manager.enable("demo")).rejects.toThrow(/provides no storage implementation/);

    expect(activations).toBe(0);
    expect(manager.get("demo")?.lastFailure?.phase).toBe("permissions");
  });
});
