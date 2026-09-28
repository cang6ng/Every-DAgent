import type { Tool } from "@every-dagent/agent-core";

import type { PluginPermission } from "./permissions.js";

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly permissions?: readonly PluginPermission[];
}

/** A cleanup callback registered while the plugin is activating. */
export type PluginDisposer = () => void | Promise<void>;

/**
 * The only registration surface a plugin sees. Registrations are staged and
 * published by the manager, which also owns the real registry disposers, so a
 * plugin can neither see nor unregister another plugin's tools.
 */
export interface ScopedToolRegistrar {
  register(tool: Tool): void;
}

/**
 * A host-provided, plugin-scoped key/value view. The handle a plugin receives
 * belongs to one activation: once that activation's cleanup has run, the handle
 * rejects and a later enable hands out a new one.
 */
export interface PluginStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Capabilities the host injected for the current activation. */
export interface PluginCapabilities {
  readonly storage?: PluginStorage;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly tools: ScopedToolRegistrar;
  readonly capabilities: PluginCapabilities;
  onDispose(disposer: PluginDisposer): void;
}

export interface Plugin {
  readonly manifest: PluginManifest;
  activate(context: PluginContext): void | Promise<void>;
}
