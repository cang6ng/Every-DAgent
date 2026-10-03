/**
 * The bounded implementation profile for persistent configuration.
 *
 * These are the numbers this build enforces, in one place because they are one
 * set of facts: the repository refuses a namespace or a value that does not fit
 * them, and the host's own settings validation refuses a system prompt that
 * does not. They are deliberately *not* protocol constants — a later build may
 * choose different numbers without a wire change — which is exactly why they
 * are written down once here instead of being spelled out at each check that
 * needs one.
 *
 * None of them is a cap on how much configuration may exist: they bound one
 * namespace's name, one namespace's encoded value and one system prompt.
 */

/** The namespace this host's own settings live in. */
export const HOST_NAMESPACE = "host";

/** The namespace the model profile lives in. */
export const MODEL_NAMESPACE = "model";

/** The largest encoded value one settings namespace may hold. */
export const MAX_SETTINGS_VALUE_BYTES = 16 * 1024;

/** The largest a namespace name may be, measured as UTF-8 bytes. */
export const MAX_SETTINGS_NAMESPACE_BYTES = 128;

/** The largest effective system prompt, measured as UTF-8 bytes. */
export const MAX_SYSTEM_PROMPT_BYTES = 8 * 1024;

/**
 * The exact namespace shape a managed configuration may have.
 *
 * `host` and `model` are this host's own two fixed namespaces; every other one
 * belongs to one registered plugin, named by its plugin id. The pattern is
 * strict on purpose: a namespace is an identity that gets stored, published and
 * compared, so a name that differs by case, spacing or encoding would be a
 * second identity for the same intent.
 */
export const SETTINGS_NAMESPACE_PATTERN = /^(?:host|model|plugin:[a-z][a-z0-9._-]*)$/;

/** Whether one string is a namespace this build will store and serve. */
export function isSettingsNamespace(namespace: unknown): namespace is string {
  if (typeof namespace !== "string" || namespace.length === 0) return false;
  if (Buffer.byteLength(namespace, "utf8") > MAX_SETTINGS_NAMESPACE_BYTES) return false;
  return SETTINGS_NAMESPACE_PATTERN.test(namespace);
}

/** The namespace one plugin's configuration lives in. */
export function pluginNamespace(pluginId: string): string {
  return `plugin:${pluginId}`;
}
