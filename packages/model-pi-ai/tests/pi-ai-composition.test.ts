/**
 * The trusted composition for pi-ai: what a model setting may mean, and what
 * the provider is really handed.
 *
 * The two halves are checked together on purpose. Validation is a pure
 * judgement, so it is checked value by value; composition is where a credential
 * is resolved and a client exists, so it is checked against a scripted stream
 * source that records what it was called with — including the proof that a
 * missing credential stops everything *before* a client can be built.
 */

import { describe, expect, it } from "vitest";

import type { ModelRequest, RuntimeContext } from "@every-dagent/agent-core";
import type { JsonValue } from "@every-dagent/protocol";
import type { TrustedComposition } from "@every-dagent/host";

import {
  createPiAiComposition,
  explicitCredentials,
  environmentCredentials,
  type PiAiComposition,
} from "../src/index.js";
import { createScriptedPiAiStream, TEST_MODEL, textScript } from "./helpers/fake-pi-ai-stream.js";

const BASE_URL = "https://provider.test/v1";

/** The composition under test, over one catalogue entry and a recording source. */
function composition(options: {
  readonly credentials?: Parameters<typeof createPiAiComposition>[0]["credentials"];
  readonly endpoints?: Readonly<Record<string, readonly string[]>>;
  readonly maxTokens?: number;
  readonly minOutputTokens?: number;
  readonly allowHttp?: readonly string[];
  readonly maxTimeoutMs?: number;
  readonly apiKeyProvided?: boolean;
} = {}) {
  const source = createScriptedPiAiStream([textScript("hello")]);
  const credentials =
    options.credentials ?? explicitCredentials({ [TEST_MODEL.provider]: "a-test-credential" });
  const composition = createPiAiComposition({
    models: [TEST_MODEL],
    streamSource: source,
    credentials,
    ...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.minOutputTokens === undefined ? {} : { minOutputTokens: options.minOutputTokens }),
    ...(options.allowHttp === undefined ? {} : { allowHttp: options.allowHttp }),
    ...(options.maxTimeoutMs === undefined ? {} : { maxTimeoutMs: options.maxTimeoutMs }),
  });
  return { composition, source };
}

/** The one value every accepted setting is built from. */
function settings(overrides: Record<string, JsonValue> = {}): JsonValue {
  return { provider: TEST_MODEL.provider, model: TEST_MODEL.id, ...overrides };
}

/** The runtime context every direct client call is handed. */
const CONTEXT: RuntimeContext = { sessionId: "s-1", signal: new AbortController().signal };

describe("what a model setting is allowed to be", () => {
  it("accepts the exact catalogue entry and refuses everything shaped differently", () => {
    const { composition: c } = composition();
    expect(c.validateModel(settings())).toEqual({ ok: true });

    expect(c.validateModel("provider").ok).toBe(false);
    expect(c.validateModel(null).ok).toBe(false);
    expect(c.validateModel([]).ok).toBe(false);
    expect(c.validateModel({}).ok).toBe(false);
    expect(c.validateModel({ provider: "", model: "m" }).ok).toBe(false);
  });

  it("refuses an unknown provider or model, and a profile the adapter cannot cap", () => {
    const { composition: c } = composition();
    expect(c.validateModel(settings({ provider: "someone-else" }))).toEqual({
      ok: false,
      reason: "unknown-provider-model",
    });
    expect(c.validateModel(settings({ model: "someone-elses-model" }))).toEqual({
      ok: false,
      reason: "unknown-provider-model",
    });

    const unsupported = createPiAiComposition({
      models: [{ ...TEST_MODEL, api: "openai-responses" as never }],
      streamSource: createScriptedPiAiStream([]),
      credentials: explicitCredentials({}),
    });
    expect(unsupported.validateModel(settings())).toEqual({ ok: false, reason: "unsupported-profile" });
  });

  it("refuses unknown keys: a settings value is not an SDK option bag", () => {
    const { composition: c } = composition();
    const rejectedKeys: readonly Record<string, JsonValue>[] = [
      { temperature: 0.7 },
      { headers: { authorization: "secret" } },
      { apiKey: "secret" },
      { retries: 3 },
      { env: { A: "b" } },
      { maxTokens: 100 },
    ];
    for (const extra of rejectedKeys) {
      expect(c.validateModel(settings(extra)).ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it("lets a reserve tighten the default one and never raise it", () => {
    // The test model's own maximum is 1024, so the default reserve is 1024 and
    // that is the ceiling here: a reserve is always <= min(4096, the ceiling).
    const { composition: c } = composition();
    expect(c.validateModel(settings({ outputReserveTokens: 512 }))).toEqual({ ok: true });
    expect(c.validateModel(settings({ outputReserveTokens: TEST_MODEL.maxTokens }))).toEqual({ ok: true });
    expect(c.validateModel(settings({ outputReserveTokens: TEST_MODEL.maxTokens + 1 }))).toEqual({
      ok: false,
      reason: "output-reserve",
    });
    expect(c.validateModel(settings({ outputReserveTokens: 0 }))).toEqual({
      ok: false,
      reason: "model-settings-shape",
    });
    expect(c.validateModel(settings({ outputReserveTokens: 1.5 }))).toEqual({
      ok: false,
      reason: "model-settings-shape",
    });

    // A composition ceiling below the default is the tighter bound.
    const capped = composition({ maxTokens: 1024 }).composition;
    expect(capped.validateModel(settings({ outputReserveTokens: 1024 }))).toEqual({ ok: true });
    expect(capped.validateModel(settings({ outputReserveTokens: 1025 }))).toEqual({
      ok: false,
      reason: "output-reserve",
    });
  });

  it("caps a reserve at the default 4096 for a model that could take more", () => {
    const big = createPiAiComposition({
      models: [{ ...TEST_MODEL, maxTokens: 32 * 1024 } as never],
      streamSource: createScriptedPiAiStream([]),
      credentials: explicitCredentials({}),
    });
    expect(big.validateModel(settings({ outputReserveTokens: 4096 }))).toEqual({ ok: true });
    expect(big.validateModel(settings({ outputReserveTokens: 4097 }))).toEqual({
      ok: false,
      reason: "output-reserve",
    });
  });

  it("refuses a reserve below the profile's declared floor", () => {
    const { composition: c } = composition({ minOutputTokens: 512 });
    expect(c.validateModel(settings({ outputReserveTokens: 512 }))).toEqual({ ok: true });
    expect(c.validateModel(settings({ outputReserveTokens: 511 }))).toEqual({
      ok: false,
      reason: "output-reserve",
    });
  });

  it("holds a timeout to the finite ceiling it declares", () => {
    const { composition: c } = composition({ maxTimeoutMs: 30_000 });
    expect(c.validateModel(settings({ timeoutMs: 30_000 }))).toEqual({ ok: true });
    expect(c.validateModel(settings({ timeoutMs: 30_001 }))).toEqual({ ok: false, reason: "timeout" });
    expect(c.validateModel(settings({ timeoutMs: 0 }))).toEqual({
      ok: false,
      reason: "model-settings-shape",
    });
    expect(c.validateModel(settings({ timeoutMs: -1 }))).toEqual({
      ok: false,
      reason: "model-settings-shape",
    });
  });

  it("allows only the endpoints this profile already trusts", () => {
    const { composition: c } = composition({ endpoints: { [TEST_MODEL.provider]: [BASE_URL] } });

    // The allowlist entry is canonical ("https://provider.test/v1/"), and both
    // spellings of the same endpoint normalize to it.
    expect(c.validateModel(settings({ baseURL: BASE_URL }))).toEqual({ ok: true });
    expect(c.validateModel(settings({ baseURL: "https://provider.test/v1" }))).toEqual({ ok: true });

    expect(c.validateModel(settings({ baseURL: "https://elsewhere.test/v1/" }))).toEqual({
      ok: false,
      reason: "endpoint",
    });
    expect(c.validateModel(settings({ baseURL: "https://provider.test/other/" }))).toEqual({
      ok: false,
      reason: "endpoint",
    });
    // No allowlist for a provider at all: no alternate endpoint, whatever it is.
    const bare = composition().composition;
    expect(bare.validateModel(settings({ baseURL: BASE_URL }))).toEqual({ ok: false, reason: "endpoint" });
  });

  it("refuses a URL that carries anything but a base endpoint, without echoing it", () => {
    const { composition: c } = composition({ endpoints: { [TEST_MODEL.provider]: [BASE_URL] } });
    const rejected = [
      "https://user:pass@provider.test/v1/",
      "https://user@provider.test/v1/",
      "https://provider.test/v1/?key=value",
      "https://provider.test/v1/#fragment",
      "http://provider.test/v1/",
      "https://provider.test\\v1/",
      "https://provider.test/v1/\u0000",
      "not a url",
      "ftp://provider.test/v1/",
    ];

    for (const value of rejected) {
      const verdict = c.validateModel(settings({ baseURL: value }));
      expect(verdict.ok, value).toBe(false);
      // The refusal is a fixed word: no part of the URL travels with it.
      expect(JSON.stringify(verdict)).not.toContain("provider.test");
      expect(JSON.stringify(verdict)).not.toContain("pass");
    }
  });

  it("allows plain http only for the providers a caller marks as local test profiles", () => {
    const local = composition({
      endpoints: { [TEST_MODEL.provider]: ["http://127.0.0.1:8080/v1/"] },
      allowHttp: [TEST_MODEL.provider],
    }).composition;
    expect(local.validateModel(settings({ baseURL: "http://127.0.0.1:8080/v1/" }))).toEqual({ ok: true });
  });
});

describe("what the provider is actually handed", () => {
  it("resolves the credential and passes exactly it, with the effective timeout", async () => {
    const { composition: c, source } = composition();
    const composed = await c.compose({
      host: {},
      model: settings({ timeoutMs: 12_345 }),
      revisions: {},
    });

    const request: ModelRequest = {
      systemPrompt: undefined,
      messages: [{ role: "user", text: "hi" }],
      tools: [],
      maxOutputTokens: composed.modelClient.limits.maxOutputTokens,
    };
    for await (const event of composed.modelClient.stream(request, CONTEXT)) {
      void event;
    }

    // The provider was handed the resolved credential, the effective timeout
    // and the request's own cap — nothing else, and nothing ambient.
    const options = source.options[0];
    expect(options?.apiKey).toBe("a-test-credential");
    expect(options?.timeoutMs).toBe(12_345);
    expect(options?.maxTokens).toBe(composed.modelClient.limits.maxOutputTokens);
    expect(options?.maxRetries).toBe(0);
  });

  it("sends the request to the canonical endpoint the settings asked for", async () => {
    const { composition: c, source } = composition({ endpoints: { [TEST_MODEL.provider]: [BASE_URL] } });
    const composed = await c.compose({
      host: {},
      model: settings({ baseURL: "https://provider.test/v1" }),
      revisions: {},
    });
    for await (const event of composed.modelClient.stream(
      {
        systemPrompt: undefined,
        messages: [{ role: "user", text: "hi" }],
        tools: [],
        maxOutputTokens: composed.modelClient.limits.maxOutputTokens,
      },
      CONTEXT,
    )) {
      void event;
    }

    // The normalized endpoint, not the spelling the client sent.
    expect(source.models[0]?.baseUrl).toBe(`${BASE_URL}/`);
  });

  it("stops before construction when the credential is missing", async () => {
    const { composition: c } = composition({ credentials: explicitCredentials({}) });
    await expect(c.compose({ host: {}, model: settings(), revisions: {} })).rejects.toThrow(
      /credential/i,
    );
    const empty = composition({
      credentials: environmentCredentials({ [TEST_MODEL.provider]: "MISSING_VARIABLE_FOR_TEST" }, {}),
    }).composition;
    await expect(empty.compose({ host: {}, model: settings(), revisions: {} })).rejects.toThrow(
      /credential/i,
    );
  });

  it("never builds a client from the ambient environment on its own", async () => {
    // The environment is only read through a declared mapping; a provider that
    // is not in the mapping resolves nothing, even when a variable with its own
    // name is sitting right there.
    const environment = { TEST_PROVIDER_API_KEY: "an-ambient-value" };
    const mapped = environmentCredentials({ "test-provider": "TEST_PROVIDER_API_KEY" }, environment);
    expect(mapped.resolve({ provider: "test-provider" })).toBe("an-ambient-value");

    const unmapped = environmentCredentials({}, environment);
    expect(unmapped.resolve({ provider: "test-provider" })).toBeUndefined();
  });

  it("declares the configured reserve as the profile ceiling, so the request cap follows it", async () => {
    const { composition: c } = composition();
    const composed = await c.compose({
      host: {},
      model: settings({ outputReserveTokens: 700 }),
      revisions: {},
    });
    // The ceiling the adapter declares is what the Core's budget may reserve:
    // R = min(4096, maxOutputTokens) = 700.
    expect(composed.modelClient.limits.maxOutputTokens).toBe(700);
  });

  it("is structurally the host's composition seam", () => {
    // The compile-time half of the contract: this package does not import the
    // host, so the match is asserted here, where both sides are visible.
    const { composition: c } = composition();
    const asSeam: TrustedComposition = c;
    expect(asSeam.validateModel(settings())).toEqual({ ok: true });
    const asPiAi: PiAiComposition = c;
    expect(typeof asPiAi.compose).toBe("function");
  });
});
