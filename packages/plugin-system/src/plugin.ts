import type { Tool } from "@every-dagent/agent-core";

import type { PluginPermission } from "./permissions.js";

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly permissions?: readonly PluginPermission[];
}

/**
 * A value a plugin's own configuration may hold.
 *
 * This is this package's own JSON profile, deliberately not the protocol's and
 * certainly not a database's: a plugin contract that borrowed either would make
 * this layer depend on the wire it must not know about. It is the same shape a
 * settings value has — because both are JSON — but the type and the predicate
 * that enforces it live here.
 */
export type PluginConfigValue =
  | null
  | boolean
  | number
  | string
  | readonly PluginConfigValue[]
  | { readonly [key: string]: PluginConfigValue };

/**
 * A plugin's own configuration contract.
 *
 * `defaultValue` is used exactly once, by a startup that finds neither a stored
 * configuration nor a stored intent for a *registered* plugin. It is never a
 * fallback for a stored value that failed validation: a stored configuration is
 * either usable or the plugin does not start.
 *
 * `validate` is synchronous and total by contract. Returning `false` and
 * throwing are the same refusal — an invalid configuration — and the plugin's
 * own message is never propagated, because a validator's words can quote the
 * value it was given.
 */
export interface PluginConfiguration {
  readonly schemaVersion: number;
  readonly defaultValue: PluginConfigValue;
  validate(value: PluginConfigValue): boolean;
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
  /**
   * The immutable effective configuration bound to this activation.
   *
   * It is the value the manager owned when the plugin was registered, deep
   * frozen: an activation cannot observe a later mutation because there is no
   * later mutation — a configuration change is a new revision, and a new
   * revision only becomes effective at the next startup. `undefined` is a
   * plugin that declares no configuration contract at all.
   */
  readonly config: PluginConfigValue | undefined;
  onDispose(disposer: PluginDisposer): void;
}

export interface Plugin {
  readonly manifest: PluginManifest;
  /** The plugin's configuration contract, when it has one. */
  readonly configuration?: PluginConfiguration;
  activate(context: PluginContext): void | Promise<void>;
}
