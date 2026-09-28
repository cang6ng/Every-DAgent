export type { PluginPermission } from "./permissions.js";

export type {
  Plugin,
  PluginCapabilities,
  PluginContext,
  PluginDisposer,
  PluginManifest,
  PluginStorage,
  ScopedToolRegistrar,
} from "./plugin.js";

export type {
  PluginFailure,
  PluginInfo,
  PluginManager,
  PluginManagerOptions,
  PluginStatus,
} from "./plugin-manager.js";

export { PluginBusyError } from "./errors.js";
export { createPluginManager } from "./plugin-manager.js";
