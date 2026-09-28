import type { PluginManifest } from "./plugin.js";
import { normalizePermissions } from "./permissions.js";

/**
 * Lowercase identifiers only, matched case-sensitively. Nothing is trimmed or
 * normalized: an id a caller would not recognize in `get`/`list` is rejected
 * rather than silently rewritten.
 */
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9._-]*$/;

function requireNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`plugin manifest ${field} must be a non-blank string`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`plugin manifest ${field} must be a string when provided`);
  }
  return value;
}

/**
 * Copies a caller-supplied manifest into the frozen snapshot the manager owns.
 * Only documented fields survive; the id, name and version are kept exactly as
 * supplied, and the permissions array becomes a frozen copy.
 */
export function normalizeManifest(manifest: PluginManifest): PluginManifest {
  if (manifest === null || typeof manifest !== "object") {
    throw new Error("plugin manifest must be an object");
  }

  const { id, name, version, description, permissions } = manifest;

  if (typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) {
    const received = typeof id === "string" ? JSON.stringify(id) : typeof id;
    throw new Error(`plugin id must match ${PLUGIN_ID_PATTERN.source}: ${received}`);
  }

  const snapshot: PluginManifest = {
    id,
    name: requireNonBlankString(name, "name"),
    version: requireNonBlankString(version, "version"),
    ...(description === undefined ? {} : { description: requireString(description, "description") }),
    ...(permissions === undefined
      ? {}
      : { permissions: normalizePermissions(permissions, `plugin "${id}" permissions`) }),
  };

  return Object.freeze(snapshot);
}
