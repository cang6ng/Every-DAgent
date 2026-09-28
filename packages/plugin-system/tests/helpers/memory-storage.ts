import type { PluginStorage } from "../../src/index.js";

/**
 * A host-side storage fixture: one namespace per plugin id, so a test can check
 * both the plugin-facing contract and what the host actually kept.
 *
 * It stands in for whatever a real host would use; nothing here is meant to be
 * used outside tests.
 */
export interface MemoryStorage {
  /** The host factory: returns the scoped view for one plugin id. */
  view(pluginId: string): PluginStorage;
  /** How many times the host was asked for a view. */
  factoryCalls(): number;
  /** A copy of one plugin's namespace. */
  entries(pluginId: string): ReadonlyMap<string, string>;
}

export function createMemoryStorage(): MemoryStorage {
  const namespaces = new Map<string, Map<string, string>>();
  let calls = 0;

  function namespaceOf(pluginId: string): Map<string, string> {
    const existing = namespaces.get(pluginId);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Map<string, string>();
    namespaces.set(pluginId, created);
    return created;
  }

  return {
    view(pluginId) {
      calls += 1;
      const entries = namespaceOf(pluginId);
      return {
        get: async (key) => entries.get(key),
        set: async (key, value) => {
          entries.set(key, value);
        },
        delete: async (key) => {
          entries.delete(key);
        },
      };
    },

    factoryCalls() {
      return calls;
    },

    entries(pluginId) {
      return new Map(namespaceOf(pluginId));
    },
  };
}
