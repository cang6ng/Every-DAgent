import type { ToolRegistry } from "@every-dagent/agent-core";

import type { Plugin, PluginManifest, PluginStorage } from "./plugin.js";
import type { PluginPermission } from "./permissions.js";

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

export function createPluginManager(options: PluginManagerOptions): PluginManager {
  throw new Error("createPluginManager is not implemented yet");
}
