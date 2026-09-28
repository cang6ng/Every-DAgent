import { createToolRegistry } from "@every-dagent/agent-core";
import type { Tool, ToolRegistry } from "@every-dagent/agent-core";
import { describe, expect, it } from "vitest";

import { PluginBusyError } from "../src/errors.js";
import * as pluginSystem from "../src/index.js";
import type {
  Plugin,
  PluginCapabilities,
  PluginContext,
  PluginFailure,
  PluginInfo,
  PluginManifest,
  PluginManager,
  PluginManagerOptions,
  PluginPermission,
  PluginStatus,
  PluginStorage,
  ScopedToolRegistrar,
} from "../src/index.js";
import { normalizeManifest } from "../src/manifest.js";
import { normalizeGrants, normalizePermissions } from "../src/permissions.js";

/**
 * Compile-time contract check. `tsc` is what enforces it: the callback body must
 * fail to typecheck, and the callback is never executed, so a rejected write
 * cannot mutate the value under test.
 */
function typeOnly(checks: () => void): void {
  expect(checks).toBeInstanceOf(Function);
}

function toolFrom(name: string): Tool {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    execute: async () => "ok",
  };
}

function pluginFrom(id: string): Plugin {
  return { manifest: { id, name: "Demo", version: "0.1.0" }, activate: () => {} };
}

describe("plugin contract: permissions", () => {
  it("names storage as the only permission", () => {
    const permission: PluginPermission = "storage";
    expect(permission).toBe("storage");

    // @ts-expect-error the union holds no speculative network capability
    const network: PluginPermission = "network";
    // @ts-expect-error the union holds no speculative credentials capability
    const credentials: PluginPermission = "credentials";
    expect([network, credentials]).toEqual(["network", "credentials"]);
  });

  it("rejects permission values outside the contract", () => {
    expect(() => normalizePermissions(["network"], "test permissions")).toThrow(
      /unsupported permission: "network"/,
    );
    expect(() => normalizePermissions([1], "test permissions")).toThrow(
      /unsupported permission: number/,
    );
    expect(() =>
      normalizePermissions("storage" as unknown as readonly unknown[], "test permissions"),
    ).toThrow(/must be an array/);
  });

  it("collapses duplicates into a frozen copy", () => {
    const declared: PluginPermission[] = ["storage", "storage"];
    const normalized = normalizePermissions(declared, "test permissions");

    expect(normalized).toEqual(["storage"]);
    expect(normalized).not.toBe(declared);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it("keeps grants isolated from later caller mutations", () => {
    const granted: PluginPermission[] = ["storage"];
    const record: Record<string, readonly PluginPermission[]> = { demo: granted };
    const grants = normalizeGrants(record);

    granted.push("storage");
    record.demo = [];

    expect(grants.get("demo")).toEqual(["storage"]);
    expect(grants.get("demo")).not.toBe(granted);
  });

  it("rejects unsupported grant values and defaults to an empty policy", () => {
    const unsupported = {
      demo: ["network"],
    } as unknown as Record<string, readonly PluginPermission[]>;

    expect(() => normalizeGrants(unsupported)).toThrow(/unsupported permission: "network"/);
    expect(() =>
      normalizeGrants({ demo: "storage" as unknown as readonly PluginPermission[] }),
    ).toThrow(/must be an array/);
    expect(normalizeGrants(undefined).size).toBe(0);
  });
});

describe("plugin contract: manifest", () => {
  it("accepts a minimal manifest and freezes the snapshot", () => {
    const manifest = normalizeManifest({ id: "demo-plugin", name: "Demo", version: "0.1.0" });

    expect(Object.keys(manifest).sort()).toEqual(["id", "name", "version"]);
    expect(Object.isFrozen(manifest)).toBe(true);
  });

  it("keeps declared permissions as a frozen copy", () => {
    const declared: PluginPermission[] = ["storage", "storage"];
    const manifest = normalizeManifest({
      id: "demo",
      name: "Demo",
      version: "0.1.0",
      permissions: declared,
    });

    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.permissions).not.toBe(declared);
    expect(Object.isFrozen(manifest.permissions)).toBe(true);
  });

  it("keeps the description and drops undocumented fields", () => {
    const manifest = normalizeManifest({
      id: "demo",
      name: "Demo",
      version: "0.1.0",
      description: "A demo plugin.",
      author: "nobody",
    } as unknown as PluginManifest);

    expect(Object.keys(manifest).sort()).toEqual(["description", "id", "name", "version"]);
    expect(manifest.description).toBe("A demo plugin.");
  });

  it("rejects ids that are not lowercase identifiers", () => {
    for (const id of ["Demo", "1demo", "-demo", "demo plugin", "demo ", "", "demo/tool"]) {
      expect(() => normalizeManifest({ id, name: "Demo", version: "0.1.0" })).toThrow(
        /plugin id must match/,
      );
    }
  });

  it("accepts ids with dots, digits, dashes and underscores", () => {
    expect(normalizeManifest({ id: "nav.deep-1_2", name: "Demo", version: "0.1.0" }).id).toBe(
      "nav.deep-1_2",
    );
  });

  it("rejects blank or non-string name and version", () => {
    expect(() => normalizeManifest({ id: "demo", name: "  ", version: "0.1.0" })).toThrow(
      /manifest name must be a non-blank string/,
    );
    expect(() => normalizeManifest({ id: "demo", name: "Demo", version: "" })).toThrow(
      /manifest version must be a non-blank string/,
    );
    expect(() =>
      normalizeManifest({ id: "demo", name: 7 as unknown as string, version: "0.1.0" }),
    ).toThrow(/manifest name must be a non-blank string/);
  });

  it("rejects a non-string description and non-array permissions", () => {
    expect(() =>
      normalizeManifest({
        id: "demo",
        name: "Demo",
        version: "0.1.0",
        description: 7 as unknown as string,
      }),
    ).toThrow(/manifest description must be a string/);
    expect(() =>
      normalizeManifest({
        id: "demo",
        name: "Demo",
        version: "0.1.0",
        permissions: "storage" as unknown as PluginPermission[],
      }),
    ).toThrow(/permissions must be an array/);
  });

  it("rejects a manifest that is not an object", () => {
    expect(() => normalizeManifest(undefined as unknown as PluginManifest)).toThrow(
      /must be an object/,
    );
  });
});

describe("plugin contract: activation surface", () => {
  it("hands the plugin a scoped registrar instead of the shared registry", () => {
    const registered: Tool[] = [];
    const tools: ScopedToolRegistrar = {
      register: (tool) => {
        registered.push(tool);
      },
    };
    const context: PluginContext = {
      pluginId: "demo",
      tools,
      capabilities: {},
      onDispose: () => {},
    };

    context.tools.register(toolFrom("calculator"));

    expect(registered.map((tool) => tool.name)).toEqual(["calculator"]);
    expect(Object.keys(context).sort()).toEqual(["capabilities", "onDispose", "pluginId", "tools"]);

    // @ts-expect-error the plugin context carries no bare ToolRegistry
    context.registry;
    // @ts-expect-error the plugin context carries no runtime
    context.runtime;
    // @ts-expect-error the lifecycle has no deactivate hook
    context.deactivate;
  });

  it("describes a plugin as a manifest plus activate(context)", async () => {
    const contexts: PluginContext[] = [];
    const plugin: Plugin = {
      manifest: { id: "demo", name: "Demo", version: "0.1.0" },
      activate: (context) => {
        contexts.push(context);
      },
    };

    await plugin.activate({
      pluginId: "demo",
      tools: { register: () => {} },
      capabilities: {},
      onDispose: () => {},
    });

    expect(contexts).toHaveLength(1);

    // @ts-expect-error a plugin has no deactivate hook
    plugin.deactivate;
  });

  it("exposes storage only through the injected capabilities", async () => {
    const storage: PluginStorage = {
      get: async (key) => (key === "greeting" ? "hello" : undefined),
      set: async () => {},
      delete: async () => {},
    };
    const capabilities: PluginCapabilities = { storage };

    expect(await capabilities.storage?.get("greeting")).toBe("hello");
    expect(await capabilities.storage?.get("missing")).toBeUndefined();
    expect(await capabilities.storage?.set("greeting", "hi")).toBeUndefined();

    typeOnly(() => {
      // @ts-expect-error the manager, not the caller, injects capabilities
      capabilities.storage = undefined;
    });
  });
});

describe("plugin contract: manager surface", () => {
  it("keeps the manager to six operations", async () => {
    const calls: string[] = [];
    const manager: PluginManager = {
      register: () => {
        calls.push("register");
      },
      unregister: async () => {
        calls.push("unregister");
      },
      enable: async () => {
        calls.push("enable");
      },
      disable: async () => {
        calls.push("disable");
      },
      get: () => undefined,
      list: () => [],
    };

    manager.register(pluginFrom("demo"));
    await manager.unregister("demo");
    await manager.enable("demo");
    await manager.disable("demo");

    expect(manager.get("demo")).toBeUndefined();
    expect(manager.list()).toEqual([]);
    expect(calls).toEqual(["register", "unregister", "enable", "disable"]);

    // @ts-expect-error there is no force reset or recovery operation
    manager.reset;
  });

  it("declares the five statuses and the four failure phases", () => {
    const statuses: readonly PluginStatus[] = [
      "disabled",
      "enabling",
      "enabled",
      "disabling",
      "error",
    ];
    const failure: PluginFailure = {
      operation: "enable",
      phase: "commit",
      message: "registration was rejected",
      cleanupErrors: ["disposer failed"],
    };

    expect(statuses).toHaveLength(5);
    expect(failure.cleanupErrors).toEqual(["disposer failed"]);

    // @ts-expect-error only enable and disable are lifecycle operations
    const unknownOperation: PluginFailure["operation"] = "unregister";
    // @ts-expect-error permissions, activate, commit and dispose are the only phases
    const unknownPhase: PluginFailure["phase"] = "register";
    // @ts-expect-error a sixth status is not part of the contract
    const unknownStatus: PluginStatus = "active";

    expect([unknownOperation, unknownPhase, unknownStatus]).toEqual([
      "unregister",
      "register",
      "active",
    ]);
  });

  it("reports failures and info as read-only snapshots", () => {
    const failure: PluginFailure = {
      operation: "disable",
      phase: "dispose",
      message: "cleanup failed",
      cleanupErrors: ["disposer failed"],
    };
    const info: PluginInfo = {
      manifest: normalizeManifest({ id: "demo", name: "Demo", version: "0.1.0" }),
      status: "disabled",
      lastFailure: failure,
    };

    expect(info.lastFailure?.cleanupErrors).toEqual(["disposer failed"]);

    typeOnly(() => {
      // @ts-expect-error cleanup errors are a read-only list
      failure.cleanupErrors.push("late");
      // @ts-expect-error the manager owns status transitions
      info.status = "enabled";
      // @ts-expect-error a plugin cannot swap its manifest snapshot
      info.manifest = info.manifest;
      // @ts-expect-error a failure record is replaced by the manager, not reassigned
      info.lastFailure = undefined;
    });

    expect(failure.cleanupErrors).toEqual(["disposer failed"]);
    expect(info.status).toBe("disabled");
  });
});

describe("plugin contract: public exports", () => {
  it("exports only the documented runtime API", () => {
    expect(Object.keys(pluginSystem).sort()).toEqual(["PluginBusyError", "createPluginManager"]);
  });

  it("names the busy rejection after the plugin", () => {
    const error = new PluginBusyError("demo");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PluginBusyError");
    expect(error.message).toContain("demo");
  });

  it("fails fast while the lifecycle manager is unimplemented", () => {
    const storage: PluginStorage = {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
    };
    const registry: ToolRegistry = createToolRegistry();
    const options: PluginManagerOptions = {
      tools: registry,
      grants: { demo: ["storage"] },
      storage: () => storage,
    };

    expect(() => pluginSystem.createPluginManager(options)).toThrow(/not implemented/);
  });
});
