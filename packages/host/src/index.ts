/**
 * The public surface of `@every-dagent/host`.
 *
 * An explicit whitelist, never `export *`: a host is used by composing it and
 * attaching channels, and nothing else about it is another package's business.
 * Directories, the registry gate, the projection functions and the dispatcher
 * are internals — a second way in would be a second way around the gate.
 */

export { createHost } from "./host.js";
export type { Host, HostOptions, PersistenceOptions } from "./host.js";
export type {
  BootstrapSettings,
  ComposeInput,
  ComposedExecution,
  ModelSettingsCheck,
  SettingsRevisions,
  TrustedComposition,
} from "./composition.js";
export type { HostSettings } from "./settings.js";
export type { ToolPolicy, ToolPolicyDecision, ToolPolicyView } from "./policy.js";
