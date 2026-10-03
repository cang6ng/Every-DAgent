/**
 * The host's own settings schema, and the one way a stored value is read.
 *
 * The host namespace is this package's business and nobody else's, so it is
 * validated here: a closed shape with exactly three fields, each held to the
 * bound this build enforces. The bounds are the *hard* profile's, not the
 * current instance's: `loop.maxSteps` may tighten what the loop will spend, and
 * may never raise it past what the approved resource profile allows.
 *
 * Stored values are read back through the protocol's strict JSON guard, so what
 * comes out of storage is an owned snapshot or a refusal — never a parsed value
 * that still shares structure with whatever the parser produced.
 */

import { LOOP_RESOURCE_LIMITS } from "@every-dagent/agent-core";
import { validateJsonValue, type JsonValue } from "@every-dagent/protocol";

import { MAX_SYSTEM_PROMPT_BYTES } from "./settings-profile.js";

/** The host's effective configuration. */
export interface HostSettings {
  /** The system prompt the default context builder applies. */
  readonly systemPrompt: string;
  readonly loop: {
    /** Model calls one turn may spend; at most the approved profile's maximum. */
    readonly maxSteps: number;
    /** Attempts per model step; at most the approved profile's maximum. */
    readonly maxModelAttempts: number;
  };
}

export type HostSettingsCheck =
  | { readonly ok: true; readonly settings: HostSettings }
  | { readonly ok: false; readonly reason: string };

/** Whether a value is a plain object, in the way a settings value must be. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an object's own keys are exactly the ones listed, in any order. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** A whole number inside a closed range. */
function withinRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * Judges one host settings value.
 *
 * The shape is closed on purpose: an unknown field is a refusal, not something
 * to drop, because a client that sent one believes it did something — and a
 * host that quietly ignored it would be reporting an intent it never applied.
 * The two loop bounds are the approved profile's maximums; a value may only
 * tighten them.
 */
export function validateHostSettings(value: unknown): HostSettingsCheck {
  if (!isPlainObject(value)) return { ok: false, reason: "host-settings-shape" };
  if (!hasExactKeys(value, ["systemPrompt", "loop"])) return { ok: false, reason: "host-settings-shape" };

  const systemPrompt = value["systemPrompt"];
  if (typeof systemPrompt !== "string") return { ok: false, reason: "host-settings-shape" };
  if (Buffer.byteLength(systemPrompt, "utf8") > MAX_SYSTEM_PROMPT_BYTES) {
    return { ok: false, reason: "system-prompt-too-large" };
  }

  const loop = value["loop"];
  if (!isPlainObject(loop)) return { ok: false, reason: "host-settings-shape" };
  if (!hasExactKeys(loop, ["maxSteps", "maxModelAttempts"])) return { ok: false, reason: "host-settings-shape" };

  const maxSteps = loop["maxSteps"];
  if (!withinRange(maxSteps, 1, LOOP_RESOURCE_LIMITS.maxSteps)) {
    return { ok: false, reason: "max-steps-out-of-range" };
  }
  const maxModelAttempts = loop["maxModelAttempts"];
  if (!withinRange(maxModelAttempts, 1, LOOP_RESOURCE_LIMITS.maxModelAttempts)) {
    return { ok: false, reason: "max-model-attempts-out-of-range" };
  }

  return {
    ok: true,
    settings: Object.freeze({
      systemPrompt,
      loop: Object.freeze({ maxSteps, maxModelAttempts }),
    }),
  };
}

/**
 * One stored value, read back as an owned JSON snapshot.
 *
 * `undefined` is a refusal, and it covers both halves of "not readable": text
 * that is not JSON at all, and a value the wire could not carry (an accessor, a
 * cycle, a non-finite number). Neither is repaired into a legal value, because
 * a repaired setting would be a different intent presented as the stored one.
 */
export function ownStoredSettingsValue(valueJson: string): JsonValue | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson) as unknown;
  } catch {
    return undefined;
  }
  const validated = validateJsonValue(parsed);
  return validated.success ? validated.output : undefined;
}
