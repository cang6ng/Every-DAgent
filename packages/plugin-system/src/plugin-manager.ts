import type { Tool, ToolRegistry } from "@every-dagent/agent-core";

import { createActivationScope } from "./activation-scope.js";
import type { ActivationScope } from "./activation-scope.js";
import { PluginBusyError, normalizeThrownValue } from "./errors.js";
import { normalizeManifest } from "./manifest.js";
import { normalizeGrants } from "./permissions.js";
import type { PluginPermission } from "./permissions.js";
import type {
  Plugin,
  PluginCapabilities,
  PluginContext,
  PluginDisposer,
  PluginManifest,
  PluginStorage,
} from "./plugin.js";

/**
 * `enabling` and `disabling` are observable states, not bookkeeping: while a
 * plugin is in either one, every lifecycle request for it is rejected with
 * PluginBusyError instead of being queued.
 */
export type PluginStatus = "disabled" | "enabling" | "enabled" | "disabling" | "error";

/** The most recent lifecycle failure, kept for diagnostics. */
export interface PluginFailure {
  readonly operation: "enable" | "disable";
  readonly phase: "permissions" | "activate" | "commit" | "dispose";
  readonly message: string;
  readonly cleanupErrors: readonly string[];
}

export interface PluginInfo {
  readonly manifest: PluginManifest;
  readonly status: PluginStatus;
  readonly lastFailure?: PluginFailure;
}

export interface PluginManagerOptions {
  readonly tools: ToolRegistry;
  readonly grants?: Readonly<Record<string, readonly PluginPermission[]>>;
  readonly storage?: (pluginId: string) => PluginStorage;
}

export interface PluginManager {
  register(plugin: Plugin): void;
  unregister(id: string): Promise<void>;
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  get(id: string): PluginInfo | undefined;
  list(): readonly PluginInfo[];
}

interface Entry {
  readonly manifest: PluginManifest;
  readonly plugin: Plugin;
  readonly granted: readonly PluginPermission[];
  status: PluginStatus;
  scope?: ActivationScope;
  lastFailure?: PluginFailure;
}

const NO_PERMISSIONS: readonly PluginPermission[] = Object.freeze([]);

function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export function createPluginManager(options: PluginManagerOptions): PluginManager {
  const registry = options.tools;
  const grants = normalizeGrants(options.grants);
  const storageFactory = options.storage;
  const entries = new Map<string, Entry>();

  function infoOf(entry: Entry): PluginInfo {
    return Object.freeze({
      manifest: entry.manifest,
      status: entry.status,
      ...(entry.lastFailure === undefined ? {} : { lastFailure: entry.lastFailure }),
    });
  }

  function recordFailure(entry: Entry, failure: PluginFailure): void {
    entry.lastFailure = Object.freeze({
      operation: failure.operation,
      phase: failure.phase,
      message: failure.message,
      cleanupErrors: Object.freeze([...failure.cleanupErrors]),
    });
  }

  function requireEntry(id: string): Entry {
    const entry = entries.get(id);
    if (entry === undefined) {
      throw new Error(`plugin "${id}" is not registered`);
    }
    return entry;
  }

  function rejectErrorState(entry: Entry): never {
    const failure = entry.lastFailure;
    const detail =
      failure === undefined
        ? ""
        : ` after ${failure.operation} failed in ${failure.phase}: ${failure.message}`;
    throw new Error(
      `plugin "${entry.manifest.id}" is in the error state and cannot be operated on${detail}`,
    );
  }

  /**
   * Applies the permission policy for one activation. Everything a plugin
   * declared must also be granted by the host and backed by a host
   * implementation; anything less is refused before `activate` runs.
   */
  function resolveCapabilities(entry: Entry): PluginCapabilities {
    const declared = entry.manifest.permissions ?? NO_PERMISSIONS;

    if (declared.includes("storage")) {
      if (!entry.granted.includes("storage")) {
        throw new Error(
          `plugin "${entry.manifest.id}" declares storage but the host has not granted it`,
        );
      }
      if (storageFactory === undefined) {
        throw new Error(
          `plugin "${entry.manifest.id}" was granted storage but the host provides no storage implementation`,
        );
      }
      throw new Error(
        `plugin "${entry.manifest.id}" cannot be enabled: the storage capability is not implemented yet`,
      );
    }

    return {};
  }

  function createContext(
    entry: Entry,
    scope: ActivationScope,
    capabilities: PluginCapabilities,
  ): PluginContext {
    return {
      pluginId: entry.manifest.id,
      tools: {
        register: (tool: Tool) => {
          scope.stageTool(tool);
        },
      },
      capabilities,
      onDispose: (disposer: PluginDisposer) => {
        scope.registerDisposer(disposer);
      },
    };
  }

  /**
   * Preflight is the last check before publishing; the final word still belongs
   * to `registry.register`. The loop below performs no `await`, so the batch is
   * either fully published or fully compensated as one synchronous step.
   */
  function commitStagedTools(entry: Entry, scope: ActivationScope): void {
    const staged = scope.stagedTools();
    const reserved = new Set<string>();

    for (const tool of staged) {
      if (reserved.has(tool.name)) {
        throw new Error(`plugin "${entry.manifest.id}" staged two tools named "${tool.name}"`);
      }
      if (registry.get(tool.name) !== undefined) {
        throw new Error(`tool "${tool.name}" is already owned by another registration`);
      }
      reserved.add(tool.name);
    }

    for (const tool of staged) {
      scope.ownRegistration(registry.register(tool));
    }
  }

  /**
   * Runs this activation's cleanup and records a `dispose` failure when any
   * part of it failed. Returns the failure, or undefined when cleanup was clean.
   */
  async function release(entry: Entry): Promise<PluginFailure | undefined> {
    const scope = entry.scope;
    entry.scope = undefined;
    const cleanupErrors = scope === undefined ? [] : await scope.cleanup();

    if (cleanupErrors.length === 0) {
      return undefined;
    }

    const failure: PluginFailure = {
      operation: "disable",
      phase: "dispose",
      message: `cleanup failed for plugin "${entry.manifest.id}"`,
      cleanupErrors,
    };
    recordFailure(entry, failure);
    return failure;
  }

  function register(plugin: Plugin): void {
    if (plugin === null || typeof plugin !== "object") {
      throw new Error("plugin must be an object with a manifest and an activate function");
    }

    const manifest = normalizeManifest(plugin.manifest);

    if (entries.has(manifest.id)) {
      throw new Error(`plugin "${manifest.id}" is already registered`);
    }

    entries.set(manifest.id, {
      manifest,
      plugin,
      granted: grants.get(manifest.id) ?? NO_PERMISSIONS,
      status: "disabled",
    });
  }

  async function enable(id: string): Promise<void> {
    const entry = requireEntry(id);

    if (entry.status === "enabled") {
      return;
    }
    if (entry.status === "enabling" || entry.status === "disabling") {
      throw new PluginBusyError(id);
    }
    if (entry.status === "error") {
      rejectErrorState(entry);
    }

    // Busy is observable before any await or plugin callback runs.
    entry.status = "enabling";

    const scope = createActivationScope();
    entry.scope = scope;
    let phase: PluginFailure["phase"] = "permissions";

    try {
      const capabilities = resolveCapabilities(entry);
      phase = "activate";
      const activation = entry.plugin.activate(createContext(entry, scope, capabilities));
      if (isPromiseLike(activation)) {
        await activation;
      }
      // A synchronous activation is sealed on the spot: no extra await is
      // introduced between its return and the closing of the entry points.
      scope.seal();
      phase = "commit";
      commitStagedTools(entry, scope);
    } catch (error) {
      scope.seal();
      entry.scope = undefined;
      const cleanupErrors = await scope.cleanup();
      recordFailure(entry, {
        operation: "enable",
        phase,
        message: normalizeThrownValue(error),
        cleanupErrors,
      });
      entry.status = cleanupErrors.length === 0 ? "disabled" : "error";
      throw error;
    }

    entry.status = "enabled";
    entry.lastFailure = undefined;
  }

  async function disable(id: string): Promise<void> {
    const entry = requireEntry(id);

    if (entry.status === "disabled") {
      return;
    }
    if (entry.status === "enabling" || entry.status === "disabling") {
      throw new PluginBusyError(id);
    }
    if (entry.status === "error") {
      rejectErrorState(entry);
    }

    entry.status = "disabling";
    const failure = await release(entry);

    if (failure === undefined) {
      entry.status = "disabled";
      return;
    }

    entry.status = "error";
    throw new Error(failure.message);
  }

  async function unregister(id: string): Promise<void> {
    const entry = entries.get(id);
    if (entry === undefined) {
      return;
    }
    if (entry.status === "enabling" || entry.status === "disabling") {
      throw new PluginBusyError(id);
    }
    if (entry.status === "error") {
      rejectErrorState(entry);
    }

    if (entry.status === "disabled") {
      entries.delete(id);
      return;
    }

    // The cleanup stays on the same path a disable would take, but the record
    // is removed outright: there is no window in which the plugin is disabled
    // and could be enabled again.
    entry.status = "disabling";
    const failure = await release(entry);

    if (failure === undefined) {
      entries.delete(id);
      return;
    }

    entry.status = "error";
    throw new Error(failure.message);
  }

  function get(id: string): PluginInfo | undefined {
    const entry = entries.get(id);
    return entry === undefined ? undefined : infoOf(entry);
  }

  function list(): readonly PluginInfo[] {
    return Object.freeze([...entries.values()].map(infoOf));
  }

  return { register, unregister, enable, disable, get, list };
}
