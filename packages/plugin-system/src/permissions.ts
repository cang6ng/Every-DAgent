/**
 * The capabilities a host can hand to a plugin. The union only names
 * capabilities the host can actually provide today; a permission is added when
 * its implementation exists, never in advance.
 */
export type PluginPermission = "storage";

const KNOWN_PERMISSIONS: readonly PluginPermission[] = ["storage"];
const KNOWN_PERMISSION_SET: ReadonlySet<string> = new Set<string>(KNOWN_PERMISSIONS);

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : typeof value;
}

function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === "string" && KNOWN_PERMISSION_SET.has(value);
}

/**
 * Rejects unknown permission names instead of assuming they were granted, and
 * returns a frozen snapshot: duplicates collapse and later mutations of the
 * caller's array are not observable.
 */
export function normalizePermissions(
  values: readonly unknown[],
  source: string,
): readonly PluginPermission[] {
  if (!Array.isArray(values)) {
    throw new Error(`${source} must be an array`);
  }

  const declared = new Set<PluginPermission>();
  for (const value of values) {
    if (!isPluginPermission(value)) {
      throw new Error(`${source} contains an unsupported permission: ${describe(value)}`);
    }
    declared.add(value);
  }

  return Object.freeze([...declared]);
}

/**
 * Copies the host's grant table into manager-owned policy. Grants are matched by
 * plugin ID; anything a caller later does to the original record has no effect
 * on an existing manager.
 */
export function normalizeGrants(
  grants: Readonly<Record<string, readonly PluginPermission[]>> | undefined,
): ReadonlyMap<string, readonly PluginPermission[]> {
  const normalized = new Map<string, readonly PluginPermission[]>();

  for (const [pluginId, permissions] of Object.entries(grants ?? {})) {
    normalized.set(pluginId, normalizePermissions(permissions, `grants for plugin "${pluginId}"`));
  }

  return normalized;
}
