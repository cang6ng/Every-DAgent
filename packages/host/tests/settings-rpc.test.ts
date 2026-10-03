/**
 * M3 — the settings surface: reads, CAS writes, and the bounded invalidation.
 *
 * These are the wire-level facts: what a namespace read reports, what an update
 * accepts and refuses, what it publishes, and what it deliberately keeps
 * running while a client changes what the *next* start will use.
 */

import { describe, expect, it } from "vitest";

import type { PluginConfiguration } from "@every-dagent/plugin-system";
import type { ModelEvent } from "@every-dagent/agent-core";
import type { JsonValue } from "@every-dagent/protocol";

import {
  composeTestHost,
  connect,
  createSessionThrough,
  flush,
  gate,
  nextId,
  scriptedModel,
  testPlugin,
  textReply,
} from "./helpers/harness.js";
import { testComposition } from "../../../tests/helpers/test-composition.js";

const HOST_VALUE = { systemPrompt: "configured", loop: { maxSteps: 6, maxModelAttempts: 2 } };

/** A configuration contract over `{ level: number }`. */
const LEVEL_CONTRACT: PluginConfiguration = {
  schemaVersion: 1,
  defaultValue: { level: 1 },
  validate: (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { level?: unknown }).level === "number",
};

async function hostWith(options: {
  readonly plugins?: Parameters<typeof composeTestHost>[0]["plugins"];
  readonly modelClient?: Parameters<typeof composeTestHost>[0]["modelClient"];
} = {}) {
  const composed = await composeTestHost({
    modelClient: options.modelClient ?? scriptedModel([textReply("unused")]).client,
    plugins: options.plugins ?? [],
  });
  const client = connect(composed.host);
  await client.describe();
  return { composed, client };
}

describe("settings.get", () => {
  it("reports the desired and effective state of a namespace", async () => {
    const { composed, client } = await hostWith();
    const result = await client.call("settings.get", { namespace: "host" });
    expect(result.error).toBeUndefined();
    const settings = result.result?.settings;
    expect(settings?.namespace).toBe("host");
    expect(settings?.desiredRevision).toBe(1);
    expect(settings?.effectiveRevision).toBe(1);
    expect(settings?.restartRequired).toBe(false);
    expect(settings?.desiredValue).toEqual(settings?.effectiveValue);

    const model = await client.call("settings.get", { namespace: "model" });
    expect(model.result?.settings.namespace).toBe("model");
    expect(model.result?.settings.effectiveRevision).toBe(1);

    client.detach();
    await composed.host.shutdown();
  });

  it("answers CAPABILITY_NOT_SUPPORTED for every namespace it does not manage", async () => {
    const { composed, client } = await hostWith({
      plugins: [
        testPlugin({ id: "configured", tools: [], configuration: LEVEL_CONTRACT }),
        testPlugin({ id: "plain", tools: [] }),
      ],
    });

    // An arbitrary name, a plugin that does not exist, and a registered plugin
    // that declares no configuration all answer the same way — and none of them
    // becomes a namespace by being asked about.
    for (const namespace of ["whatever", "plugin:missing", "plugin:plain"]) {
      const result = await client.call("settings.get", { namespace });
      expect(result.error?.code, namespace).toBe("CAPABILITY_NOT_SUPPORTED");
    }

    // The one namespace that does exist answers.
    const managed = await client.call("settings.get", { namespace: "plugin:configured" });
    expect(managed.error).toBeUndefined();
    expect(managed.result?.settings.desiredRevision).toBe(1);

    client.detach();
    await composed.host.shutdown();
  });

  it("is refused once the store can no longer be vouched for", async () => {
    const { composed, client } = await hostWith();
    // A storage fault: the same boundary every current-state read obeys.
    (
      composed.repository as unknown as { trusted: boolean }
    ).trusted = false;
    const refused = await client.call("settings.get", { namespace: "host" });
    // A refused read is not a bootstrap: the client is told the host cannot
    // answer rather than handed a value read off a connection it distrusts.
    expect(["STORAGE_UNAVAILABLE", "INTERNAL_ERROR"]).toContain(refused.error?.code);

    client.detach();
    await composed.host.shutdown();
  });
});

describe("settings.update", () => {
  it("commits a desired value, reports it as pending, and leaves the runtime alone", async () => {
    const { composed, client } = await hostWith();
    const updated = await client.call("settings.update", {
      namespace: "host",
      expectedRevision: 1,
      value: HOST_VALUE,
    });

    expect(updated.error).toBeUndefined();
    expect(updated.result?.settings.desiredRevision).toBe(2);
    expect(updated.result?.settings.effectiveRevision).toBe(1);
    expect(updated.result?.settings.restartRequired).toBe(true);
    expect(updated.result?.settings.desiredValue).toEqual(HOST_VALUE);
    expect(updated.result?.settings.effectiveValue).not.toEqual(HOST_VALUE);
    expect(composed.repository.getSettingsNamespace("host")?.revision).toBe(2);

    // The write is a desired commit: this instance still runs what it started
    // with, and says so.
    const read = await client.call("settings.get", { namespace: "host" });
    expect(read.result?.settings.restartRequired).toBe(true);
    expect(read.result?.settings.effectiveRevision).toBe(1);

    client.detach();
    await composed.host.shutdown();
  });

  it("publishes one bounded invalidation and nothing else", async () => {
    const { composed, client } = await hostWith();
    await client.call("subscriptions.open", {});
    await client.call("settings.update", { namespace: "host", expectedRevision: 1, value: HOST_VALUE });
    await flush();

    const events = client.events.filter((event) => event.type === "settings.updated");
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload;
    expect(payload).toEqual({ namespace: "host", revision: 2, restartRequired: true });
    // No value and no secret travels with an invalidation.
    expect(JSON.stringify(payload)).not.toContain("configured");

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses a stale expectation without writing anything", async () => {
    const { composed, client } = await hostWith();
    const first = await client.call("settings.update", {
      namespace: "host",
      expectedRevision: 1,
      value: HOST_VALUE,
    });
    expect(first.error).toBeUndefined();

    const stale = await client.call("settings.update", {
      namespace: "host",
      expectedRevision: 1,
      value: { systemPrompt: "never written", loop: { maxSteps: 1, maxModelAttempts: 1 } },
    });
    expect(stale.error?.code).toBe("REVISION_CONFLICT");
    expect(composed.repository.getSettingsNamespace("host")?.revision).toBe(2);
    expect(JSON.parse(composed.repository.getSettingsNamespace("host")?.valueJson ?? "null")).toEqual(HOST_VALUE);

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses a value its own schema does not accept, and writes nothing", async () => {
    const { composed, client } = await hostWith();

    const rejected: unknown[] = [
      { systemPrompt: "x" },
      { systemPrompt: "x", loop: { maxSteps: 6 } },
      { systemPrompt: "x", loop: { maxSteps: 6, maxModelAttempts: 2, extra: 1 } },
      { systemPrompt: 5, loop: { maxSteps: 6, maxModelAttempts: 2 } },
      { systemPrompt: "x", loop: { maxSteps: 13, maxModelAttempts: 2 } },
      { systemPrompt: "x", loop: { maxSteps: 6, maxModelAttempts: 4 } },
      { systemPrompt: "x".repeat(9 * 1024), loop: { maxSteps: 6, maxModelAttempts: 2 } },
      "not an object",
      [1, 2, 3],
      null,
    ];

    for (const value of rejected) {
      const result = await client.call("settings.update", {
        namespace: "host",
        expectedRevision: 1,
        value: value as never,
      });
      expect(result.error?.code, JSON.stringify(value)).toBe("SETTINGS_INVALID");
    }
    expect(composed.repository.getSettingsNamespace("host")?.revision).toBe(1);

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses a model profile the composition's catalogue does not hold", async () => {
    // The composition owns the catalogue, so this is the composition's
    // judgement travelling through the host: the fixture is given exactly one
    // entry, and everything else is unknown to it.
    const composed = await composeTestHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      composition: testComposition({
        modelClient: scriptedModel([textReply("unused")]).client,
        catalog: [{ provider: "test", model: "test-model" }],
      }),
    });
    const client = connect(composed.host);
    await client.describe();

    // What the *fixture* composition refuses is what its own judgement covers:
    // a value that is not the shape it reads and a pair its catalogue does not
    // hold. The closed-key and endpoint rules belong to a composition that has
    // them — the pi-ai one — and are asserted where that composition lives and
    // in the integration acceptance, where a real one drives a real host.
    const rejected: JsonValue[] = [
      { provider: "unknown", model: "test-model" },
      { provider: "test", model: "unknown" },
      { model: "test-model" },
      { provider: "", model: "test-model" },
      "not an object",
    ];

    for (const value of rejected) {
      const result = await client.call("settings.update", {
        namespace: "model",
        expectedRevision: 1,
        value,
      });
      expect(result.error?.code, JSON.stringify(value)).toBe("SETTINGS_INVALID");
    }
    expect(composed.repository.getSettingsNamespace("model")?.revision).toBe(1);
    expect(composed.repository.getSettingsNamespace("model")?.valueJson).toContain("test-model");

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses a value past the namespace bound, and an unmanaged namespace", async () => {
    const { composed, client } = await hostWith();

    const tooLarge = { systemPrompt: "x".repeat(17 * 1024), loop: { maxSteps: 6, maxModelAttempts: 2 } };
    const large = await client.call("settings.update", {
      namespace: "host",
      expectedRevision: 1,
      value: tooLarge,
    });
    expect(large.error?.code).toBe("LIMIT_EXCEEDED");

    const unmanaged = await client.call("settings.update", {
      namespace: "plugin:missing",
      expectedRevision: 1,
      value: { level: 1 },
    });
    expect(unmanaged.error?.code).toBe("CAPABILITY_NOT_SUPPORTED");
    expect(composed.repository.getSettingsNamespace("host")?.revision).toBe(1);

    client.detach();
    await composed.host.shutdown();
  });

  it("is refused while a run holds the execution lease", async () => {
    const release = gate();
    const started = gate();
    const model = scriptedModel([
      async function* (): AsyncGenerator<ModelEvent> {
        // The step is open from here until the gate opens: the run owns the
        // registry for exactly that window.
        started.open();
        await release.promise;
        yield { type: "text-delta", text: "done" };
        yield { type: "done" };
      },
    ]);
    const { composed, client } = await hostWith({ modelClient: model.client });
    const session = await createSessionThrough(client);

    await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "hold the lease",
    });
    await started.promise;

    const busy = await client.call("settings.update", {
      namespace: "host",
      expectedRevision: 1,
      value: HOST_VALUE,
    });
    expect(busy.error?.code).toBe("HOST_BUSY");
    expect(composed.repository.getSettingsNamespace("host")?.revision).toBe(1);

    release.open();
    await flush();
    client.detach();
    await composed.host.shutdown();
  });
});

describe("plugin configuration through the same surface", () => {
  it("moves the plugin's config revision, keeps the running one, and announces both", async () => {
    const { composed, client } = await hostWith({
      plugins: [testPlugin({ id: "configured", tools: [], configuration: LEVEL_CONTRACT })],
    });
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "configured" });

    const updated = await client.call("settings.update", {
      namespace: "plugin:configured",
      expectedRevision: 1,
      value: { level: 7 },
    });
    expect(updated.error).toBeUndefined();
    expect(updated.result?.settings.desiredRevision).toBe(2);
    expect(updated.result?.settings.effectiveRevision).toBe(1);
    expect(updated.result?.settings.restartRequired).toBe(true);

    // The plugin's own summary says the same thing: a restart is owed, and what
    // runs now is revision one.
    const summary = (await client.call("plugins.list", {})).result?.plugins[0];
    expect(summary?.status).toBe("enabled");
    expect(summary?.configRevision).toBe(2);
    expect(summary?.effectiveConfigRevision).toBe(1);
    expect(summary?.restartRequired).toBe(true);

    // And the catalogue moved with it: an invalidation and a plugin summary.
    const published = client.events.filter((event) => event.type === "settings.updated");
    expect(published.map((event) => event.payload)).toEqual([
      { namespace: "plugin:configured", revision: 2, restartRequired: true },
    ]);
    const pluginEvents = client.events.filter((event) => event.type === "plugin.updated");
    expect(pluginEvents.at(-1)?.payload.plugin.configRevision).toBe(2);

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses a configuration the plugin's own contract rejects", async () => {
    const { composed, client } = await hostWith({
      plugins: [testPlugin({ id: "configured", tools: [], configuration: LEVEL_CONTRACT })],
    });

    const refused = await client.call("settings.update", {
      namespace: "plugin:configured",
      expectedRevision: 1,
      value: { level: "seven" },
    });
    expect(refused.error?.code).toBe("SETTINGS_INVALID");
    expect(composed.repository.getSettingsNamespace("plugin:configured")?.revision).toBe(1);
    // A refused value never reaches storage, so nothing of it can be read back.
    expect(composed.repository.getSettingsNamespace("plugin:configured")?.valueJson).not.toContain("seven");

    client.detach();
    await composed.host.shutdown();
  });
});

describe("the published summary", () => {
  it("carries the host's own two namespaces, and never their values", async () => {
    const { composed, client } = await hostWith();
    const snapshot = (await client.call("subscriptions.open", {})).result?.snapshot;
    expect(snapshot?.settings.map((entry) => entry.namespace)).toEqual(["host", "model"]);
    for (const entry of snapshot?.settings ?? []) {
      expect(entry.desiredRevision).toBe(1);
      expect(entry.effectiveRevision).toBe(1);
      expect(entry.restartRequired).toBe(false);
    }
    expect(JSON.stringify(snapshot?.settings)).not.toContain("systemPrompt");

    await client.call("settings.update", { namespace: "host", expectedRevision: 1, value: HOST_VALUE });
    const after = (await client.call("subscriptions.open", {})).result?.snapshot;
    const hostEntry = after?.settings.find((entry) => entry.namespace === "host");
    expect(hostEntry?.desiredRevision).toBe(2);
    expect(hostEntry?.effectiveRevision).toBe(1);
    expect(hostEntry?.restartRequired).toBe(true);

    client.detach();
    await composed.host.shutdown();
  });

  it("keeps the generation at two and claims settings support", async () => {
    const { composed, client } = await hostWith();
    const description = (await client.describe()).result;
    expect(description?.protocolVersion).toBe("2");
    expect(description?.capabilities.settings).toBe(true);
    client.detach();
    await composed.host.shutdown();
  });
});
