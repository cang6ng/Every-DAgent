/**
 * The trusted composition seam: where settings become execution.
 *
 * Everything a host runs with is decided here and nowhere else. The host reads
 * its *persisted desired* configuration, validates it, and hands the effective
 * values to two things the trusted caller provides: a validator that knows the
 * provider catalogue and endpoint policy, and a factory that turns the values
 * into an executable ModelClient — resolving credentials on the way, which is
 * why a credential never has to exist in this package at all.
 *
 * The seam is deliberately provider-neutral. A `JsonValue` goes in; a Core
 * `ModelClient` comes out; no provider SDK type, catalog, or credential shape
 * appears on either side of it. That is what lets the host stay ignorant of
 * what a "provider" is while still being unable to run on anything the
 * composition did not vouch for.
 *
 * Three rules shape the contract.
 *
 * Validation is the composition's answer, not the caller's guess. The host
 * stores whatever a client asked for and asks `validateModel` at write time and
 * again at startup, because a value that was legal when it was written is not
 * automatically legal when it is read.
 *
 * Composition owns what it took. A `compose` that throws is responsible for
 * whatever it already acquired; a `compose` that returns hands its resources to
 * the host, which disposes them after the plugins have settled and before the
 * store is released.
 *
 * Failures are classified, never quoted. A refusal reason is a fixed, non-secret
 * word from the composition's own vocabulary — the host answers with its own
 * fixed sentence and never puts a reason on the wire.
 */

import type { ContextBuilder, ModelClient } from "@every-dagent/agent-core";
import type { JsonValue } from "@every-dagent/protocol";

import type { HostSettings } from "./settings.js";

export type { HostSettings } from "./settings.js";

/**
 * The defaults a first startup persists.
 *
 * Supplied by the trusted caller and only ever non-secret: a system prompt, the
 * loop budget, and the model profile a fresh store starts from. There is no
 * field here for an api key, an auth header or an environment bag on purpose —
 * a credential reaches a provider through the composition, never through
 * configuration, and a bootstrap value is written to disk verbatim.
 */
export interface BootstrapSettings {
  readonly host: HostSettings;
  readonly model: JsonValue;
}

/** The desired revisions the effective execution was built from. */
export interface SettingsRevisions {
  readonly host: number;
  readonly model: number;
}

/**
 * What one model settings value was judged to be.
 *
 * `reason` is a fixed classification from the composition's own vocabulary
 * ("unknown-provider-model", "endpoint-not-allowed", ...). It is for the
 * composition and its tests; the host maps a refusal to one of its own fixed
 * answers and never publishes this word.
 */
export interface ModelSettingsCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface ComposeInput {
  /** The effective host settings this instance is configured with. */
  readonly host: HostSettings;
  /** The effective model settings, exactly as they were persisted and validated. */
  readonly model: JsonValue;
  /** The desired revisions those effective values came from. */
  readonly revisions: SettingsRevisions;
}

/**
 * The execution a composition built, and the way to release it.
 *
 * `dispose` is the composition's own release path for the resources it took
 * while composing — a provider client with a socket pool, a credential handle.
 * It runs on shutdown and after a later startup failure, in both cases after
 * the plugins have settled and before the store is closed.
 */
export interface ComposedExecution {
  readonly modelClient: ModelClient;
  /** Left out, the host's default builder applies the effective system prompt. */
  readonly contextBuilder?: ContextBuilder;
  readonly dispose?: () => void | Promise<void>;
}

export interface TrustedComposition {
  /**
   * Whether one model settings value may be persisted and run.
   *
   * Called at write time (so an unacceptable value is never stored) and again
   * at startup (so a value that stopped being acceptable is refused before
   * anything executes). Synchronous by contract: the catalogue, the endpoint
   * policy and the model limits are static facts of the composition.
   */
  validateModel(value: JsonValue): ModelSettingsCheck;
  /**
   * Builds the execution layer from the effective configuration.
   *
   * Credential resolution happens inside this call — the host has no way to
   * resolve one and no place to keep one. A rejection means no execution was
   * built; a resolution means everything the composition took belongs to the
   * host from that moment on.
   */
  compose(input: ComposeInput): Promise<ComposedExecution>;
}
