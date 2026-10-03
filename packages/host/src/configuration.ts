/**
 * The configuration a host runs from.
 *
 * Three things live here, and they are deliberately one module: the durable
 * *desired* configuration the store holds, the *effective* configuration one
 * running instance consumed, and the single transaction that gives a store its
 * first configuration.
 *
 * The split between desired and effective is the whole design. Desired is what
 * a client asked for; it is durable, revisioned per namespace and readable at
 * any time. Effective is what this instance actually runs with; it is a fact
 * about a running host, holds no durable row, and can never be inherited from a
 * previous instance or inferred from a stored flag — the only way to have one
 * is to read the desired value, validate it and compose execution from it.
 *
 * Initialization is the one write that is not an update. A store that has no
 * configuration gets the trusted defaults exactly once, in one transaction;
 * after that the desired value is the client's, and a startup never rewrites
 * it. A store that holds *half* a configuration — one of the two namespaces and
 * not the other — is refused rather than completed, because completing it would
 * mean inventing which of two divergent truths is the missing one.
 */

import { ownPluginConfigValue } from "@every-dagent/plugin-system";
import type { Plugin, PluginConfigValue } from "@every-dagent/plugin-system";
import { validateJsonValue, type JsonValue } from "@every-dagent/protocol";

import type { BootstrapSettings, SettingsRevisions, TrustedComposition } from "./composition.js";
import type { Repository } from "./repository.js";
import { pluginNamespace } from "./settings-profile.js";
import { ownStoredSettingsValue, validateHostSettings, type HostSettings } from "./settings.js";

/** The namespace this host's own settings live in. */
export const HOST_NAMESPACE = "host";
/** The namespace the model profile lives in. */
export const MODEL_NAMESPACE = "model";

/**
 * The schema version of the two namespaces the host defines.
 *
 * A stored row whose version is not this one is refused rather than migrated:
 * M3 ships one version, and a value written by a future build under a different
 * schema is not something this build can claim to understand.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

/** One namespace's effective value, as this instance consumed it. */
export interface EffectiveNamespace {
  readonly namespace: string;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly value: JsonValue;
}

/** One registered plugin's configuration, as the startup read it. */
export interface LoadedPluginConfiguration {
  /** The durable desired-enabled intent; the restore step aims for this. */
  readonly desiredEnabled: boolean;
  /** The effective configuration the manager binds, or `undefined` when none is declared. */
  readonly config: PluginConfigValue | undefined;
  /** The revision of the value above; `null` for a plugin with no configuration contract. */
  readonly configRevision: number | null;
  /** The schema version the value was written under; `null` for a plugin with no contract. */
  readonly schemaVersion: number | null;
}

/** What one startup read, validated, and made effective. */
export interface LoadedConfiguration {
  readonly host: HostSettings;
  readonly model: JsonValue;
  readonly revisions: SettingsRevisions;
  /** The effective values, by namespace. Never mutated after startup. */
  readonly effective: ReadonlyMap<string, EffectiveNamespace>;
  /** One entry per registered plugin, by id. */
  readonly plugins: ReadonlyMap<string, LoadedPluginConfiguration>;
}

/**
 * A configuration this host will not run from.
 *
 * The message is a fixed sentence written here: a stored value may name a
 * provider, a URL or a model, and a startup failure is not a place any of them
 * travels into a log or an error report.
 */
export class ConfigurationError extends Error {
  constructor(reason: string) {
    super(`the persisted configuration cannot be run: ${reason}`);
    this.name = "ConfigurationError";
  }
}

/**
 * Reads, validates and — for a fresh store — initializes the configuration.
 *
 * The order is the contract: what is already durable is read first and never
 * rewritten; a store that has nothing is initialized from the trusted defaults
 * once; and *every* value that will be made effective is validated here, after
 * it is read, whatever its history. A stored fact is not trusted because it was
 * once written — it is trusted because it passed this check just now.
 */
export function loadConfiguration(input: {
  readonly repository: Repository;
  readonly bootstrap: BootstrapSettings;
  readonly composition: TrustedComposition;
  readonly plugins: readonly Plugin[];
  readonly at: number;
}): LoadedConfiguration {
  const { repository, bootstrap, composition, plugins } = input;

  const storedHost = repository.getSettingsNamespace(HOST_NAMESPACE);
  const storedModel = repository.getSettingsNamespace(MODEL_NAMESPACE);
  if ((storedHost === undefined) !== (storedModel === undefined)) {
    throw new ConfigurationError("half of the managed namespaces is missing");
  }

  const absent = storedHost === undefined && storedModel === undefined;
  // Every plugin's own pair is decided by the same rule the two host namespaces
  // obey, whether or not this store already holds a configuration: a plugin
  // registered later owns an absent pair and initializes exactly that.
  const pluginPlan = planPluginInitialization(repository, plugins);

  if (absent) {
    // Validate the defaults before they become durable: a store must never be
    // initialized with a value this build would refuse to run.
    const defaults = validatedDefaults(bootstrap, composition);
    repository.initializeConfiguration({
      at: input.at,
      namespaces: [
        {
          namespace: HOST_NAMESPACE,
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          valueJson: JSON.stringify(defaults.host),
        },
        {
          namespace: MODEL_NAMESPACE,
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          valueJson: JSON.stringify(defaults.model),
        },
        ...pluginPlan.namespaces,
      ],
      pluginIntents: pluginPlan.intents,
    });
  } else if (pluginPlan.namespaces.length > 0 || pluginPlan.intents.length > 0) {
    repository.initializeConfiguration({
      at: input.at,
      namespaces: pluginPlan.namespaces,
      pluginIntents: pluginPlan.intents,
    });
  }

  const hostRecord = requireNamespace(repository, HOST_NAMESPACE);
  const modelRecord = requireNamespace(repository, MODEL_NAMESPACE);

  const hostValue = readNamespaceValue(hostRecord.valueJson, hostRecord.schemaVersion, "host");
  const hostCheck = validateHostSettings(hostValue);
  if (!hostCheck.ok) throw new ConfigurationError("the stored host settings do not match this host's schema");

  const modelValue = readNamespaceValue(modelRecord.valueJson, modelRecord.schemaVersion, "model");
  const modelCheck = composition.validateModel(modelValue);
  if (!modelCheck.ok) throw new ConfigurationError("the stored model settings are not one this composition accepts");

  const pluginConfigs = readPluginConfigurations(repository, plugins);

  const effective = new Map<string, EffectiveNamespace>([
    [
      HOST_NAMESPACE,
      Object.freeze({
        namespace: HOST_NAMESPACE,
        revision: hostRecord.revision,
        schemaVersion: hostRecord.schemaVersion,
        value: hostValue,
      }),
    ],
    [
      MODEL_NAMESPACE,
      Object.freeze({
        namespace: MODEL_NAMESPACE,
        revision: modelRecord.revision,
        schemaVersion: modelRecord.schemaVersion,
        value: modelValue,
      }),
    ],
  ]);

  return Object.freeze({
    host: hostCheck.settings,
    model: modelValue,
    revisions: Object.freeze({ host: hostRecord.revision, model: modelRecord.revision }),
    effective,
    plugins: pluginConfigs,
  });
}

/**
 * What a startup that is taking over an absent pair has to write for its plugins.
 *
 * The rule is one rule per plugin, and it is the same rule host and model obey:
 * a plugin whose namespace *and* intent are both absent is initialized from its
 * declared default, in the same transaction as everything else a fresh store
 * needs; a plugin that holds one and not the other stops the startup, because
 * completing it would mean inventing which of two divergent truths is the
 * missing one. A plugin that declares no configuration contract has no
 * namespace to initialize — only its intent, which every registered plugin owns.
 */
function planPluginInitialization(
  repository: Repository,
  plugins: readonly Plugin[],
): {
  readonly namespaces: { readonly namespace: string; readonly schemaVersion: number; readonly valueJson: string }[];
  readonly intents: { readonly pluginId: string; readonly desiredEnabled: boolean }[];
} {
  const namespaces: { namespace: string; schemaVersion: number; valueJson: string }[] = [];
  const intents: { pluginId: string; desiredEnabled: boolean }[] = [];

  for (const plugin of plugins) {
    const pluginId = plugin.manifest.id;
    const descriptor = plugin.configuration;
    const namespace = pluginNamespace(pluginId);
    const storedConfig = descriptor === undefined ? undefined : repository.getSettingsNamespace(namespace);
    const storedIntent = repository.getPluginIntent(pluginId);

    if (descriptor === undefined) {
      // No configuration contract: a row in that namespace, if one exists, is a
      // fact this plugin does not claim — it is left exactly as it is.
      if (storedIntent === undefined) intents.push({ pluginId, desiredEnabled: false });
      continue;
    }

    if ((storedConfig === undefined) !== (storedIntent === undefined)) {
      throw new ConfigurationError("half of a plugin's configuration is missing");
    }
    if (storedConfig === undefined && storedIntent === undefined) {
      const owned = ownPluginConfigValue(descriptor.defaultValue);
      if (owned === undefined) {
        throw new ConfigurationError("a plugin's default configuration is not a value this host can store");
      }
      if (!Number.isSafeInteger(descriptor.schemaVersion) || descriptor.schemaVersion < 1) {
        throw new ConfigurationError("a plugin's configuration schema version is not a version");
      }
      namespaces.push({
        namespace,
        schemaVersion: descriptor.schemaVersion,
        valueJson: JSON.stringify(owned),
      });
      intents.push({ pluginId, desiredEnabled: false });
    }
  }

  return { namespaces, intents };
}

/**
 * Reads every registered plugin's configuration, validated now.
 *
 * The stored value is re-validated against the plugin's *current* contract —
 * the schema version first, then the plugin's own validator — because a value
 * that was legal when it was written is not automatically legal when it is
 * read. A refusal stops the startup: a plugin whose configuration this host
 * cannot vouch for does not run. Neither the validator's words (a validator can
 * quote the value it was handed) nor the stored value itself travels.
 */
function readPluginConfigurations(
  repository: Repository,
  plugins: readonly Plugin[],
): ReadonlyMap<string, LoadedPluginConfiguration> {
  const found = new Map<string, LoadedPluginConfiguration>();

  for (const plugin of plugins) {
    const pluginId = plugin.manifest.id;
    const descriptor = plugin.configuration;
    const intent = repository.getPluginIntent(pluginId);

    if (descriptor === undefined) {
      found.set(pluginId, {
        desiredEnabled: intent?.desiredEnabled ?? false,
        config: undefined,
        configRevision: null,
        schemaVersion: null,
      });
      continue;
    }

    const record = repository.getSettingsNamespace(pluginNamespace(pluginId));
    if (record === undefined || intent === undefined) {
      throw new ConfigurationError("a plugin's configuration is missing from the store");
    }
    if (record.schemaVersion !== descriptor.schemaVersion) {
      throw new ConfigurationError("a plugin's stored configuration was written under a different schema version");
    }

    const value = ownStoredSettingsValue(record.valueJson);
    if (value === undefined) {
      throw new ConfigurationError("a plugin's stored configuration is not a readable value");
    }
    const owned = ownPluginConfigValue(value);
    if (owned === undefined) {
      throw new ConfigurationError("a plugin's stored configuration is not a value this host can own");
    }

    let accepted: unknown;
    try {
      accepted = descriptor.validate(owned);
    } catch {
      // A throwing validator is a refusing validator, and its message could
      // quote the value it was given: nothing of it travels.
      accepted = false;
    }
    if (accepted !== true) {
      throw new ConfigurationError("a plugin's stored configuration is not one its own contract accepts");
    }

    found.set(pluginId, {
      desiredEnabled: intent.desiredEnabled,
      config: owned,
      configRevision: record.revision,
      schemaVersion: record.schemaVersion,
    });
  }

  return found;
}

/** The bootstrap defaults, judged before they are allowed to become durable. */
function validatedDefaults(
  bootstrap: BootstrapSettings,
  composition: TrustedComposition,
): { readonly host: HostSettings; readonly model: JsonValue } {
  const hostCheck = validateHostSettings(bootstrap.host);
  if (!hostCheck.ok) throw new ConfigurationError("the bootstrap host settings do not match this host's schema");

  const modelValidated = validateJsonValue(bootstrap.model);
  if (!modelValidated.success) throw new ConfigurationError("the bootstrap model settings are not something JSON can carry");
  const modelCheck = composition.validateModel(modelValidated.output);
  if (!modelCheck.ok) throw new ConfigurationError("the bootstrap model settings are not one this composition accepts");

  return { host: hostCheck.settings, model: modelValidated.output };
}

/** One namespace the configuration must have, or a refusal. */
function requireNamespace(repository: Repository, namespace: string): { readonly schemaVersion: number; readonly revision: number; readonly valueJson: string } {
  const record = repository.getSettingsNamespace(namespace);
  if (record === undefined) throw new ConfigurationError("a managed namespace has no stored value");
  return record;
}

/** One stored value: the current schema version, and a JSON value that can be read. */
function readNamespaceValue(valueJson: string, schemaVersion: number, what: string): JsonValue {
  if (schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new ConfigurationError(`the stored ${what} settings were written under a different schema version`);
  }
  const value = ownStoredSettingsValue(valueJson);
  if (value === undefined) throw new ConfigurationError(`the stored ${what} settings are not a readable value`);
  return value;
}
