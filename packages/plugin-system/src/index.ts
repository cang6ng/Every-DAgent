export type { PluginPermission } from "./permissions.js";

export { isPluginConfigValue, ownPluginConfigValue } from "./config.js";

export type {
  Plugin,
  PluginCapabilities,
  PluginConfigValue,
  PluginConfiguration,
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
