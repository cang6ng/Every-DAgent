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

import { validateJsonValue, type JsonValue } from "@every-dagent/protocol";

import type { BootstrapSettings, SettingsRevisions, TrustedComposition } from "./composition.js";
import type { Repository } from "./repository.js";
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

/** What one startup read, validated, and made effective. */
export interface LoadedConfiguration {
  readonly host: HostSettings;
  readonly model: JsonValue;
  readonly revisions: SettingsRevisions;
  /** The effective values, by namespace. Never mutated after startup. */
  readonly effective: ReadonlyMap<string, EffectiveNamespace>;
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
  readonly at: number;
}): LoadedConfiguration {
  const { repository, bootstrap, composition } = input;

  const storedHost = repository.getSettingsNamespace(HOST_NAMESPACE);
  const storedModel = repository.getSettingsNamespace(MODEL_NAMESPACE);
  if ((storedHost === undefined) !== (storedModel === undefined)) {
    throw new ConfigurationError("half of the managed namespaces is missing");
  }

  if (storedHost === undefined && storedModel === undefined) {
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
      ],
      pluginIntents: [],
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
  });
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
