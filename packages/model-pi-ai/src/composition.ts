/**
 * The trusted composition for pi-ai: the one place a model setting becomes a
 * provider call.
 *
 * Everything a *settings value* is allowed to mean is decided here, in the
 * order the frozen contract fixes: a closed shape, an exact catalogue lookup,
 * an audited provider profile, finite model limits, the output-reserve rule,
 * the timeout rule, and finally the endpoint policy. A value that fails any of
 * them is refused with a fixed, non-secret word — never with the value that
 * failed, and never with the URL a client tried.
 *
 * Two boundaries are deliberate.
 *
 * The credential never enters the host. `compose` resolves one through the
 * `CredentialProvider` the caller supplied, hands it straight to the adapter,
 * and keeps nothing: a missing credential stops the composition *before* a
 * provider client exists, so there is no ambient store for the SDK to fall back
 * to and no request that could be attempted without one. The environment helper
 * maps provider names to declared variable names; a name is never built out of
 * a provider string.
 *
 * The endpoint policy is an exact allowlist of canonical base URLs, bound to
 * the profile that vouches for them. A `baseURL` setting can switch between
 * endpoints this composition already trusts and cannot introduce a new one:
 * no arbitrary origin, no prefix match, no scheme change, no credentials in a
 * URL, no query or fragment. Plain `http` exists only for the providers a
 * caller explicitly marks as local test profiles.
 */

import type { ContextBuilder, ModelClient } from "@every-dagent/agent-core";
import { DEFAULT_RESERVED_OUTPUT } from "@every-dagent/agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import { createPiAiModelClient, isAuditedApi, type PiAiStreamSource } from "./pi-ai-client.js";

/**
 * Where one provider's credential comes from.
 *
 * It is called only by the composition, only with the profile it is about to
 * construct a client for, and its answer is never stored, published or logged.
 * `undefined` means "this composition has no credential for that provider",
 * which is a refusal — not a reason to look somewhere ambient.
 */
export interface CredentialProvider {
  resolve(profile: { readonly provider: string }): string | undefined;
}

/**
 * A credential provider over declared environment variable names.
 *
 * The mapping is the whole trust decision: a provider that is not in it has no
 * credential, and the variable name is never derived from the provider string,
 * so a settings value cannot name an environment variable to read.
 */
export function environmentCredentials(
  mapping: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string | undefined>>,
): CredentialProvider {
  return {
    resolve({ provider }: { readonly provider: string }): string | undefined {
      const name = mapping[provider];
      if (name === undefined) return undefined;
      const value = environment[name];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },
  };
}

/** A credential provider over an explicit injection, by provider. */
export function explicitCredentials(
  byProvider: Readonly<Record<string, string>>,
): CredentialProvider {
  return {
    resolve({ provider }: { readonly provider: string }): string | undefined {
      const value = byProvider[provider];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },
  };
}

export interface PiAiCompositionOptions {
  /** The models this composition vouches for, with their native metadata. */
  readonly models: readonly Model<Api>[];
  /** How a request really reaches a provider: the adapter's own narrow port. */
  readonly streamSource: PiAiStreamSource;
  /** Where credentials come from. Never consulted for anything else. */
  readonly credentials: CredentialProvider;
  /**
   * The canonical base endpoints this composition trusts, per provider.
   * A provider absent from this map has no alternate endpoint at all.
   */
  readonly endpoints?: Readonly<Record<string, readonly string[]>>;
  /**
   * The output ceiling this composition is willing to declare, as a cap below
   * the model's own maximum. A `outputReserveTokens` setting may only tighten
   * what this allows, never raise it.
   */
  readonly maxTokens?: number;
  /**
   * The declared output floor of the profiles this composition runs: a reserve
   * below it is refused. Absent means "no declared floor".
   */
  readonly minOutputTokens?: number;
  /** Providers allowed to reach a plain-`http` endpoint: the explicit local test profile. */
  readonly allowHttp?: readonly string[];
  /** The largest timeout a settings value may ask for, in milliseconds. */
  readonly maxTimeoutMs?: number;
}

/** The `Model<Api>` shape this module reads, checked field by field. */
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The default ceiling on a requested timeout, in milliseconds. */
export const DEFAULT_MAX_TIMEOUT_MS = 600_000;

/**
 * One model settings value, read as the closed shape it must be.
 *
 * Extra keys are a refusal rather than something to ignore: an arbitrary SDK
 * option bag is exactly what the settings surface must not be able to smuggle
 * through, and a client that sent `temperature` or `headers` is entitled to
 * know the host did not accept it.
 */
interface ModelSettings {
  readonly provider: string;
  readonly model: string;
  readonly baseURL?: string;
  readonly outputReserveTokens?: number;
  readonly timeoutMs?: number;
}

const MODEL_SETTINGS_KEYS = [
  "provider",
  "model",
  "baseURL",
  "outputReserveTokens",
  "timeoutMs",
] as const;

function readModelSettings(value: unknown): ModelSettings | undefined {
  if (!isObject(value)) return undefined;
  const own = Object.keys(value);
  if (!own.every((key) => (MODEL_SETTINGS_KEYS as readonly string[]).includes(key))) return undefined;

  const provider = value["provider"];
  const model = value["model"];
  if (typeof provider !== "string" || provider.length === 0) return undefined;
  if (typeof model !== "string" || model.length === 0) return undefined;

  const baseURL = value["baseURL"];
  if (baseURL !== undefined && (typeof baseURL !== "string" || baseURL.length === 0)) return undefined;

  const reserve = value["outputReserveTokens"];
  if (reserve !== undefined && !positiveInteger(reserve)) return undefined;

  const timeoutMs = value["timeoutMs"];
  if (timeoutMs !== undefined && !positiveInteger(timeoutMs)) return undefined;

  return {
    provider,
    model,
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(reserve === undefined ? {} : { outputReserveTokens: reserve }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/**
 * One endpoint, in the only form this composition compares or uses.
 *
 * `undefined` is a refusal and covers every way a URL can be something other
 * than a plain base endpoint: a scheme the policy does not allow, a user name
 * or password, a query, a fragment, a control character, an ambiguous
 * backslash, or text that is not a URL at all. Nothing here reads, rewrites or
 * reports the value — the caller only ever learns that it was not acceptable.
 */
function canonicalEndpoint(
  raw: string,
  options: { readonly allowHttp: boolean },
): string | undefined {
  // Control characters and backslashes are refused on the raw text, before any
  // parsing: a backslash is the one character URL parsers historically
  // disagree about, and a disagreement about which endpoint a string names is
  // exactly what this policy cannot have.
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || raw[index] === "\\") return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }

  const allowedScheme = parsed.protocol === "https:" || (options.allowHttp && parsed.protocol === "http:");
  if (!allowedScheme) return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  if (parsed.search !== "" || parsed.hash !== "") return undefined;
  if (parsed.hostname === "") return undefined;

  const path = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/** The refusal words this composition answers with. Fixed, and never a value. */
export type PiAiModelRefusal =
  | "model-settings-shape"
  | "unknown-provider-model"
  | "unsupported-profile"
  | "model-limits"
  | "output-reserve"
  | "timeout"
  | "endpoint";

/**
 * What the host's composition seam sees.
 *
 * The declared shape deliberately mirrors the host's `TrustedComposition` with
 * loose parameter types: this package does not import the host, and the
 * structural match is asserted where both sides are visible (the integration
 * tests type this factory's result as the host's own seam type).
 */
export interface PiAiComposition {
  validateModel(value: unknown): { readonly ok: true } | { readonly ok: false; readonly reason: string };
  compose(input: {
    readonly host: unknown;
    readonly model: unknown;
    readonly revisions: unknown;
  }): Promise<{ readonly modelClient: ModelClient; readonly contextBuilder?: ContextBuilder }>;
}

/** A composition-level refusal, in fixed words. */
export class PiAiCompositionError extends Error {
  constructor(detail: string) {
    super(`the model configuration cannot be composed: ${detail}`);
    this.name = "PiAiCompositionError";
  }
}

export function createPiAiComposition(options: PiAiCompositionOptions): PiAiComposition {
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const allowHttp = new Set(options.allowHttp ?? []);

  // The allowlist is normalized once, at construction: a trusted entry that is
  // not a canonical endpoint is a configuration mistake, and one this
  // composition refuses to paper over by ignoring it.
  const allowed = new Map<string, readonly string[]>();
  for (const [provider, entries] of Object.entries(options.endpoints ?? {})) {
    const canonical: string[] = [];
    for (const entry of entries) {
      const normalized = canonicalEndpoint(entry, { allowHttp: allowHttp.has(provider) });
      if (normalized === undefined) {
        throw new PiAiCompositionError("the endpoint allowlist holds a value that is not a base endpoint");
      }
      canonical.push(normalized);
    }
    allowed.set(provider, Object.freeze(canonical));
  }

  const modelOf = (settings: ModelSettings): Model<Api> | undefined =>
    options.models.find(
      (candidate) => candidate.provider === settings.provider && candidate.id === settings.model,
    );

  /**
   * The one judgement both the settings write and the startup read ask.
   *
   * The order is the frozen one, and it is a order: a value that is not a
   * closed shape can never reach the catalogue lookup, and one whose profile is
   * unaudited can never be judged for its reserve, so every refusal names the
   * first thing that was wrong rather than the last.
   */
  function judge(value: unknown): { readonly ok: true } | { readonly ok: false; readonly reason: PiAiModelRefusal } {
    const settings = readModelSettings(value);
    if (settings === undefined) return { ok: false, reason: "model-settings-shape" };

    const model = modelOf(settings);
    if (model === undefined) return { ok: false, reason: "unknown-provider-model" };

    if (!isAuditedApi(model.api as string)) return { ok: false, reason: "unsupported-profile" };

    if (!positiveInteger(model.contextWindow) || !positiveInteger(model.maxTokens)) {
      return { ok: false, reason: "model-limits" };
    }
    if (options.maxTokens !== undefined && (!positiveInteger(options.maxTokens) || options.maxTokens > model.maxTokens)) {
      return { ok: false, reason: "model-limits" };
    }

    // The reserve may only tighten the default the Core would derive, and may
    // never sit below the profile's declared floor.
    if (settings.outputReserveTokens !== undefined) {
      const ceiling = Math.min(DEFAULT_RESERVED_OUTPUT, options.maxTokens ?? model.maxTokens, model.maxTokens);
      if (settings.outputReserveTokens > ceiling) return { ok: false, reason: "output-reserve" };
      if (options.minOutputTokens !== undefined && settings.outputReserveTokens < options.minOutputTokens) {
        return { ok: false, reason: "output-reserve" };
      }
    }

    if (settings.timeoutMs !== undefined && settings.timeoutMs > maxTimeoutMs) {
      return { ok: false, reason: "timeout" };
    }

    if (settings.baseURL !== undefined) {
      const permitted = allowed.get(settings.provider);
      if (permitted === undefined) return { ok: false, reason: "endpoint" };
      const normalized = canonicalEndpoint(settings.baseURL, { allowHttp: allowHttp.has(settings.provider) });
      if (normalized === undefined || !permitted.includes(normalized)) {
        return { ok: false, reason: "endpoint" };
      }
    }

    return { ok: true };
  }

  return {
    validateModel(value: unknown) {
      const verdict = judge(value);
      return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
    },

    async compose(input: {
      readonly host: unknown;
      readonly model: unknown;
      readonly revisions: unknown;
    }): Promise<{ readonly modelClient: ModelClient }> {
      const settings = readModelSettings(input.model);
      if (settings === undefined) throw new PiAiCompositionError("the effective model settings are not a readable value");

      const model = modelOf(settings);
      if (model === undefined) throw new PiAiCompositionError("the effective model is not in this composition's catalogue");

      // The credential comes first: a profile this composition has no credential
      // for must not reach construction, because construction is where an SDK
      // would be free to look somewhere ambient for one.
      const credential = options.credentials.resolve({ provider: settings.provider });
      if (credential === undefined || credential.length === 0) {
        throw new PiAiCompositionError("no credential is configured for this provider");
      }

      const canonicalBase =
        settings.baseURL === undefined
          ? undefined
          : canonicalEndpoint(settings.baseURL, { allowHttp: allowHttp.has(settings.provider) });
      if (settings.baseURL !== undefined && canonicalBase === undefined) {
        throw new PiAiCompositionError("the effective endpoint is not a base endpoint");
      }

      // The request's own cap comes from the Core's budget; the ceiling this
      // adapter declares is what that budget may reserve. A configured reserve
      // tightens the ceiling, so the reserve the Core derives is the one the
      // settings asked for — and never a larger one.
      const declaredCeiling =
        settings.outputReserveTokens ?? options.maxTokens;

      // Constructed after the credential, with an explicit key: the adapter
      // never sees an `undefined` one, so pi-ai's credential store and its
      // environment fallbacks are out of the picture entirely.
      const modelClient = createPiAiModelClient({
        models: options.streamSource,
        model: canonicalBase === undefined ? model : { ...model, baseUrl: canonicalBase },
        apiKey: credential,
        ...(declaredCeiling === undefined ? {} : { maxTokens: declaredCeiling }),
        ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
      });

      // Nothing to release: the adapter owns no client of its own, and the
      // socket belongs to whatever `streamSource` opened per request. A
      // composition that did take resources would return a `dispose` here.
      return { modelClient };
    },
  };
}
