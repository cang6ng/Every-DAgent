/**
 * M3 acceptance at the platform boundary: persistent configuration, driven by a
 * real client through a real host whose execution comes from a real trusted
 * composition.
 *
 * What is checked here is the sentence the milestone exists for: a client
 * persists *desired* intent, the host applies it only through trusted
 * composition, and what runs is reported truthfully.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Model } from "@earendil-works/pi-ai";

import type { Client } from "@every-dagent/client";
import { createPiAiComposition, explicitCredentials } from "@every-dagent/model-pi-ai";
import type { Plugin, PluginConfigValue } from "@every-dagent/plugin-system";
import { createScriptedPiAiStream, TEST_MODEL, textScript } from "../../packages/model-pi-ai/tests/helpers/fake-pi-ai-stream.js";
import { createClientOn, createHostPlatform, waitFor, type HostPlatform } from "../helpers/platform.js";

const HOST_NAMESPACE = "host";
const MODEL_NAMESPACE = "model";
const BASE_URL = "https://provider.test/v1";
const PLUGIN_ID = "configured";

/** The second model in the catalogue: what a desired change moves to. */
const SECOND_MODEL: Model<"openai-completions"> = {
  ...TEST_MODEL,
  id: "test-model-2",
  name: "Test Model 2",
};

/** A plugin with a configuration contract, recording what each activation got. */
function configRecordingPlugin(): {
  readonly plugin: Plugin;
  readonly seen: PluginConfigValue[];
} {
  const seen: PluginConfigValue[] = [];
  return {
    seen,
    plugin: {
      manifest: { id: PLUGIN_ID, name: "Configured", version: "1.0.0", permissions: [] },
      configuration: {
        schemaVersion: 1,
        defaultValue: { mode: "plain" },
        validate: (value) =>
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          typeof (value as { mode?: unknown }).mode === "string",
      },
      activate: (context) => {
        seen.push(context.config as PluginConfigValue);
      },
    },
  };
}

function withTempDir<T>(act: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-m3-platform-"));
  return act(dir).finally(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A store still held by a host that failed the test is not the failure.
    }
  });
}

interface ConfiguredHost {
  readonly platform: HostPlatform;
  readonly client: Client;
  readonly source: ReturnType<typeof createScriptedPiAiStream>;
  close(): Promise<void>;
}

/**
 * One host whose execution really comes from the pi-ai composition, over a
 * scripted stream source; the configuration it starts from is the caller's.
 */
async function configuredHost(options: {
  readonly dir: string;
  readonly name?: string;
  readonly systemPrompt?: string;
  readonly model?: { readonly provider: string; readonly model: string };
  readonly source?: ReturnType<typeof createScriptedPiAiStream>;
  readonly plugins?: readonly Plugin[];
  readonly maxTokens?: number;
  readonly drop?: (direction: "client-to-host" | "host-to-client", frame: string) => boolean;
}): Promise<ConfiguredHost> {
  const source = options.source ?? createScriptedPiAiStream([textScript("ok")]);
  const composition = createPiAiComposition({
    models: [TEST_MODEL, SECOND_MODEL],
    streamSource: source,
    credentials: explicitCredentials({ [TEST_MODEL.provider]: "a-test-credential" }),
    endpoints: { [TEST_MODEL.provider]: [BASE_URL] },
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  });

  const platform = await createHostPlatform({
    composition,
    bootstrap: {
      host: {
        systemPrompt: options.systemPrompt ?? "",
        loop: { maxSteps: 12, maxModelAttempts: 3 },
      },
      model: (options.model ?? { provider: TEST_MODEL.provider, model: TEST_MODEL.id }) as never,
    },
    plugins: options.plugins ?? [],
    ...(options.drop === undefined ? {} : { carriers: { drop: options.drop } }),
    persistence: { kind: "sqlite", location: join(options.dir, options.name ?? "state.db") },
  });
  const client = createClientOn(platform);
  await client.connect();
  return {
    platform,
    client,
    source,
    async close(): Promise<void> {
      client.disconnect();
      await platform.shutdown();
    },
  };
}

/** Runs one turn to its terminal through a fresh session. */
async function runOnce(host: ConfiguredHost, text: string): Promise<string> {
  const session = (await host.client.sessions.create()).session;
  const started = await host.client.runs.start({
    sessionId: session.sessionId,
    submissionId: `sub-${text}`,
    text,
  });
  const runId = started.run.runId;
  await waitFor(() => {
    const run = host.client.getSnapshot().presentation?.runs.items.find((candidate) => candidate.runId === runId);
    return run !== undefined && run.status !== "accepted" && run.status !== "running";
  });
  return runId;
}

describe("what a persisted settings value changes at the next start", () => {
  it("keeps the running model until a restart, then really composes the new one", async () => {
    await withTempDir(async (dir) => {
      const first = await configuredHost({
        dir,
        source: createScriptedPiAiStream([textScript("one"), textScript("two")]),
      });
      await runOnce(first, "first");
      expect(first.source.models[0]?.id).toBe(TEST_MODEL.id);

      // The change is accepted, committed, and reported as pending: this host
      // keeps running what it started with.
      const updated = await first.client.settings.update({
        namespace: MODEL_NAMESPACE,
        expectedRevision: 1,
        value: { provider: TEST_MODEL.provider, model: SECOND_MODEL.id },
      });
      expect(updated.settings.desiredRevision).toBe(2);
      expect(updated.settings.restartRequired).toBe(true);
      expect(updated.settings.effectiveRevision).toBe(1);
      await runOnce(first, "second");
      expect(first.source.models[1]?.id).toBe(TEST_MODEL.id);
      await first.close();

      // The restart is what makes the desired value real: the request goes to
      // the model the client asked for.
      const second = await configuredHost({ dir, source: createScriptedPiAiStream([textScript("three")]) });
      await runOnce(second, "third");
      expect(second.source.models[0]?.id).toBe(SECOND_MODEL.id);
      const read = await second.client.settings.get({ namespace: MODEL_NAMESPACE });
      expect(read.settings.desiredRevision).toBe(2);
      expect(read.settings.effectiveRevision).toBe(2);
      expect(read.settings.restartRequired).toBe(false);
      await second.close();
    });
  });

  it("applies a new system prompt to the context builder only after a restart", async () => {
    await withTempDir(async (dir) => {
      const first = await configuredHost({
        dir,
        systemPrompt: "first prompt",
        source: createScriptedPiAiStream([textScript("one"), textScript("two")]),
      });
      await runOnce(first, "first");
      expect(first.source.contexts[0]?.systemPrompt).toBe("first prompt");

      await first.client.settings.update({
        namespace: HOST_NAMESPACE,
        expectedRevision: 1,
        value: { systemPrompt: "second prompt", loop: { maxSteps: 12, maxModelAttempts: 3 } },
      });
      await runOnce(first, "second");
      // The running builder is the one this instance started with, still.
      expect(first.source.contexts[1]?.systemPrompt).toBe("first prompt");
      await first.close();

      const second = await configuredHost({ dir, source: createScriptedPiAiStream([textScript("three")]) });
      await runOnce(second, "third");
      expect(second.source.contexts[0]?.systemPrompt).toBe("second prompt");
      await second.close();
    });
  });

  it("applies the output reserve and the timeout through composition", async () => {
    await withTempDir(async (dir) => {
      const first = await configuredHost({ dir, source: createScriptedPiAiStream([textScript("one")]) });
      const written = await first.client.settings.update({
        namespace: MODEL_NAMESPACE,
        expectedRevision: 1,
        value: {
          provider: TEST_MODEL.provider,
          model: TEST_MODEL.id,
          outputReserveTokens: 512,
          timeoutMs: 12_345,
        },
      });
      expect(written.settings.restartRequired).toBe(true);
      await runOnce(first, "first");
      // This instance still reserves what it started with.
      expect(first.source.options[0]?.timeoutMs).toBeUndefined();
      await first.close();

      const second = await configuredHost({ dir, source: createScriptedPiAiStream([textScript("two")]) });
      await runOnce(second, "second");

      // The reserve the settings asked for is the profile's ceiling, so the
      // request carries exactly it; the timeout travelled with it, and the
      // credential is the one this composition resolved.
      expect(second.source.options[0]?.maxTokens).toBe(512);
      expect(second.source.options[0]?.timeoutMs).toBe(12_345);
      expect(second.source.options[0]?.apiKey).toBe("a-test-credential");
      await second.close();
    });
  });

  it("applies the loop budget through composition", async () => {
    await withTempDir(async (dir) => {
      const first = await configuredHost({ dir, source: createScriptedPiAiStream([textScript("one")]) });
      await first.client.settings.update({
        namespace: HOST_NAMESPACE,
        expectedRevision: 1,
        value: { systemPrompt: "", loop: { maxSteps: 1, maxModelAttempts: 1 } },
      });
      await first.close();

      const second = await configuredHost({ dir, source: createScriptedPiAiStream([textScript("two")]) });
      const session = (await second.client.sessions.create()).session;
      const started = await second.client.runs.start({
        sessionId: session.sessionId,
        submissionId: "sub-budget",
        text: "one step only",
      });
      // One step was allowed; the answer arrived in it, so the turn completed.
      await waitFor(() => {
        const run = second.client.getSnapshot().presentation?.runs.items.find(
          (candidate) => candidate.runId === started.run.runId,
        );
        return run?.status === "completed";
      });
      expect(second.source.models).toHaveLength(1);
      await second.close();
    });
  });
});

describe("what the composition refuses through the settings surface", () => {
  it("refuses a model the catalogue does not hold, an endpoint it does not trust, and any URL echoing", async () => {
    await withTempDir(async (dir) => {
      const host = await configuredHost({ dir });

      await expect(
        host.client.settings.update({
          namespace: MODEL_NAMESPACE,
          expectedRevision: 1,
          value: { provider: "elsewhere", model: "whatever" },
        }),
      ).rejects.toMatchObject({ code: "SETTINGS_INVALID" });

      await expect(
        host.client.settings.update({
          namespace: MODEL_NAMESPACE,
          expectedRevision: 1,
          value: { provider: TEST_MODEL.provider, model: TEST_MODEL.id, baseURL: "https://elsewhere.test/v1/" },
        }),
      ).rejects.toMatchObject({ code: "SETTINGS_INVALID" });

      // A URL carrying credentials is refused, and neither the URL nor the
      // credential appears anywhere the client can see.
      await expect(
        host.client.settings.update({
          namespace: MODEL_NAMESPACE,
          expectedRevision: 1,
          value: {
            provider: TEST_MODEL.provider,
            model: TEST_MODEL.id,
            baseURL: "https://user:sk-live-secret@provider.test/v1/",
          },
        }),
      ).rejects.toMatchObject({ code: "SETTINGS_INVALID" });
      const visible = JSON.stringify(host.client.getSnapshot());
      expect(visible).not.toContain("sk-live-secret");
      expect(visible).not.toContain("elsewhere.test");

      // Nothing was written by any of them.
      const read = await host.client.settings.get({ namespace: MODEL_NAMESPACE });
      expect(read.settings.desiredRevision).toBe(1);
      expect(read.settings.restartRequired).toBe(false);
      await host.close();
    });
  });

  it("refuses a reserve above what the composition is willing to declare", async () => {
    await withTempDir(async (dir) => {
      const host = await configuredHost({ dir, maxTokens: 512 });

      await expect(
        host.client.settings.update({
          namespace: MODEL_NAMESPACE,
          expectedRevision: 1,
          value: { provider: TEST_MODEL.provider, model: TEST_MODEL.id, outputReserveTokens: 513 },
        }),
      ).rejects.toMatchObject({ code: "SETTINGS_INVALID" });

      const accepted = await host.client.settings.update({
        namespace: MODEL_NAMESPACE,
        expectedRevision: 1,
        value: { provider: TEST_MODEL.provider, model: TEST_MODEL.id, outputReserveTokens: 512 },
      });
      expect(accepted.settings.desiredRevision).toBe(2);
      await host.close();
    });
  });
});

describe("a plugin's configuration, end to end", () => {
  it("keeps running the configuration it started with, and applies the pending one at the next start", async () => {
    await withTempDir(async (dir) => {
      const fixture = configRecordingPlugin();
      const first = await configuredHost({
        dir,
        plugins: [fixture.plugin],
        source: createScriptedPiAiStream([textScript("one")]),
      });
      await first.client.plugins.enable({ pluginId: PLUGIN_ID });
      expect(fixture.seen).toEqual([{ mode: "plain" }]);

      const updated = await first.client.settings.update({
        namespace: `plugin:${PLUGIN_ID}`,
        expectedRevision: 1,
        value: { mode: "fancy" },
      });
      expect(updated.settings.desiredRevision).toBe(2);
      expect(updated.settings.effectiveRevision).toBe(1);
      expect(updated.settings.restartRequired).toBe(true);

      // Disabling and re-enabling inside this instance binds the *effective*
      // configuration, not the pending one: the activation gets the same value
      // it got the first time, because this instance never built another.
      await first.client.plugins.disable({ pluginId: PLUGIN_ID });
      await first.client.plugins.enable({ pluginId: PLUGIN_ID });
      expect(fixture.seen[fixture.seen.length - 1]).toEqual({ mode: "plain" });

      const summary = (await first.client.plugins.list()).plugins.find((entry) => entry.id === PLUGIN_ID);
      expect(summary?.status).toBe("enabled");
      expect(summary?.configRevision).toBe(2);
      expect(summary?.effectiveConfigRevision).toBe(1);
      expect(summary?.restartRequired).toBe(true);
      await first.close();

      // The restart binds the new revision, and the plugin sees it.
      const second = await configuredHost({
        dir,
        plugins: [fixture.plugin],
        source: createScriptedPiAiStream([textScript("two")]),
      });
      expect(fixture.seen[fixture.seen.length - 1]).toEqual({ mode: "fancy" });
      const after = (await second.client.plugins.list()).plugins.find((entry) => entry.id === PLUGIN_ID);
      expect(after?.status).toBe("enabled");
      expect(after?.configRevision).toBe(2);
      expect(after?.effectiveConfigRevision).toBe(2);
      expect(after?.restartRequired).toBe(false);
      await second.close();
    });
  });

  it("refuses a configuration the plugin's own contract rejects", async () => {
    await withTempDir(async (dir) => {
      const fixture = configRecordingPlugin();
      const host = await configuredHost({ dir, plugins: [fixture.plugin] });

      await expect(
        host.client.settings.update({
          namespace: `plugin:${PLUGIN_ID}`,
          expectedRevision: 1,
          value: { mode: 7 },
        }),
      ).rejects.toMatchObject({ code: "SETTINGS_INVALID" });
      const read = await host.client.settings.get({ namespace: `plugin:${PLUGIN_ID}` });
      expect(read.settings.desiredRevision).toBe(1);
      await host.close();
    });
  });
});

describe("a lost write answer", () => {
  it("is never replayed, and a read is how the caller finds out", async () => {
    await withTempDir(async (dir) => {
      let armed = false;
      const host = await configuredHost({
        dir,
        source: createScriptedPiAiStream([textScript("one")]),
        // Exactly one frame is lost: the answer to this write. The host still
        // commits it, and the client is never told.
        // A host-response carries no method; the settings result is what the
        // two settings operations answer with, and only one of them is in
        // flight while this is armed.
        drop: (direction, frame) =>
          armed && direction === "host-to-client" && frame.includes('"kind":"host-response"') && frame.includes('"settings":'),
      });

      armed = true;
      const pending = host.client.settings.update({
        namespace: HOST_NAMESPACE,
        expectedRevision: 1,
        value: { systemPrompt: "committed but unacknowledged", loop: { maxSteps: 5, maxModelAttempts: 3 } },
      });
      await waitFor(() => host.platform.carriers.some((carrier) => carrier.dropped.length > 0), {
        what: "the answer to be dropped",
      });

      // The client reconnects, which is what settles the lost wait — nothing is
      // re-sent, and the replica never claimed the write happened.
      armed = false;
      await host.client.reconnect();
      const outcome = await pending.then(() => "answered", (error: unknown) => error);
      expect(outcome).toMatchObject({ code: "CONNECTION_LOST", outcome: "unknown" });

      // A read is the confirmation, and it shows the write really landed: the
      // client's own database has exactly one revision move.
      const read = await host.client.settings.get({ namespace: HOST_NAMESPACE });
      expect(read.settings.desiredRevision).toBe(2);
      expect(read.settings.desiredValue).toEqual({
        systemPrompt: "committed but unacknowledged",
        loop: { maxSteps: 5, maxModelAttempts: 3 },
      });
      expect(read.settings.restartRequired).toBe(true);
      await host.close();
    });
  });
});

describe("the two carriers behave the same", () => {
  it("reports the same desired/effective state for the same writes", async () => {
    await withTempDir(async (dir) => {
      const durable = await configuredHost({
        dir,
        source: createScriptedPiAiStream([textScript("one")]),
      });
      const ephemeralPlatform = await createHostPlatform({
        composition: createPiAiComposition({
          models: [TEST_MODEL],
          streamSource: createScriptedPiAiStream([textScript("one")]),
          credentials: explicitCredentials({ [TEST_MODEL.provider]: "a-test-credential" }),
        }),
        bootstrap: {
          host: { systemPrompt: "", loop: { maxSteps: 12, maxModelAttempts: 3 } },
          model: { provider: TEST_MODEL.provider, model: TEST_MODEL.id } as never,
        },
        plugins: [],
      });
      const ephemeral = createClientOn(ephemeralPlatform);
      await ephemeral.connect();

      const value = { systemPrompt: "same", loop: { maxSteps: 4, maxModelAttempts: 2 } };
      const durableUpdate = await durable.client.settings.update({
        namespace: HOST_NAMESPACE,
        expectedRevision: 1,
        value,
      });
      const ephemeralUpdate = await ephemeral.settings.update({
        namespace: HOST_NAMESPACE,
        expectedRevision: 1,
        value,
      });
      expect(ephemeralUpdate.settings).toEqual(durableUpdate.settings);

      const durableRead = await durable.client.settings.get({ namespace: HOST_NAMESPACE });
      const ephemeralRead = await ephemeral.settings.get({ namespace: HOST_NAMESPACE });
      expect(ephemeralRead.settings).toEqual(durableRead.settings);

      // A stale expectation is refused the same way on both.
      await expect(
        ephemeral.settings.update({ namespace: HOST_NAMESPACE, expectedRevision: 1, value }),
      ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
      await expect(
        durable.client.settings.update({ namespace: HOST_NAMESPACE, expectedRevision: 1, value }),
      ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

      // The only difference is what each says about surviving the process.
      expect(durable.client.getSnapshot().description?.storage.retention).toBe("durable");
      expect(ephemeral.getSnapshot().description?.storage.retention).toBe("ephemeral");

      await durable.close();
      ephemeral.disconnect();
      await ephemeralPlatform.shutdown();
    });
  });
});
