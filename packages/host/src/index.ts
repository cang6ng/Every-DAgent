/**
 * The public surface of `@every-dagent/host`.
 *
 * An explicit whitelist, never `export *`: a host is used by composing it and
 * attaching channels, and nothing else about it is another package's business.
 * Directories, the registry gate, the projection functions and the dispatcher
 * are internals — a second way in would be a second way around the gate.
 */

export { createHost } from "./host.js";
export type { Host, HostOptions } from "./host.js";
