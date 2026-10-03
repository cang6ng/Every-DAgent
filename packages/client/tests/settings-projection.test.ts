/**
 * The settings replica as the connection drives it.
 *
 * The pure rules are checked where they live; what is checked here is that the
 * connection actually applies them — a read files what the host answered before
 * the caller is resolved, an invalidation arrives as staleness rather than as a
 * value, and a refused write changes nothing and is never sent twice.
 */

import { describe, expect, it } from "vitest";

import type { SettingsSnapshot } from "@every-dagent/protocol";

import { createScenario, flush } from "./helpers/scenario.js";

/** A scenario whose fake host really claims the settings capability. */
function scenarioWithSettings() {
  return createScenario({ host: { capabilities: { settings: true } } });
}

function snapshot(namespace: string, desired: number, effective = desired): SettingsSnapshot {
  return {
    namespace,
    desiredRevision: desired,
    effectiveRevision: effective,
    restartRequired: desired !== effective,
    desiredValue: { systemPrompt: `desired-${desired}` },
    effectiveValue: { systemPrompt: `effective-${effective}` },
  };
}

describe("a settings read", () => {
  it("files the answer before the caller is resolved", async () => {
    const scenario = scenarioWithSettings();
    await scenario.ready();

    const pending = scenario.client.settings.get({ namespace: "host" });
    const requestId = scenario.host.requestIdOf("settings.get");
    expect(requestId).toBeDefined();
    // Nothing is filed before the answer arrives.
    expect(scenario.client.getSnapshot().settings["host"]).toBeUndefined();

    scenario.host.respond(requestId as string, "settings.get", { settings: snapshot("host", 4) });
    const result = await pending;

    expect(result.settings.desiredRevision).toBe(4);
    const entry = scenario.client.getSnapshot().settings["host"];
    expect(entry?.desiredRevision).toBe(4);
    expect(entry?.snapshot?.desiredValue).toEqual({ systemPrompt: "desired-4" });
    expect(entry?.stale).toBe(false);
  });

  it("never walks the replica back for a late answer", async () => {
    const scenario = scenarioWithSettings();
    await scenario.ready();

    const first = scenario.client.settings.get({ namespace: "host" });
    scenario.host.respond(scenario.host.requestIdOf("settings.get") as string, "settings.get", {
      settings: snapshot("host", 5),
    });
    await first;

    const late = scenario.client.settings.get({ namespace: "host" });
    scenario.host.respond(scenario.host.requestIdOf("settings.get", 1) as string, "settings.get", {
      settings: snapshot("host", 3),
    });
    const lateResult = await late;

    // The caller receives what the host said; the replica keeps what it holds.
    expect(lateResult.settings.desiredRevision).toBe(3);
    expect(scenario.client.getSnapshot().settings["host"]?.desiredRevision).toBe(5);
    expect(scenario.client.getSnapshot().settings["host"]?.snapshot?.desiredValue).toEqual({
      systemPrompt: "desired-5",
    });
  });
});

describe("an invalidation", () => {
  it("marks what is held stale, records the revision, and carries no value", async () => {
    const scenario = scenarioWithSettings();
    await scenario.ready();

    const pending = scenario.client.settings.get({ namespace: "host" });
    scenario.host.respond(scenario.host.requestIdOf("settings.get") as string, "settings.get", {
      settings: snapshot("host", 1),
    });
    await pending;

    scenario.host.emit({ type: "settings.updated", namespace: "host", revision: 2, restartRequired: true });
    await flush();

    const entry = scenario.client.getSnapshot().settings["host"];
    expect(entry?.stale).toBe(true);
    expect(entry?.desiredRevision).toBe(2);
    expect(entry?.restartRequired).toBe(true);
    // The value is the one that was read — the event cannot have supplied one.
    expect(entry?.snapshot?.desiredValue).toEqual({ systemPrompt: "desired-1" });

    // A fresh read is what clears the staleness, and it reports the new revision.
    const reread = scenario.client.settings.get({ namespace: "host" });
    scenario.host.respond(scenario.host.requestIdOf("settings.get", 1) as string, "settings.get", {
      settings: snapshot("host", 2, 1),
    });
    await reread;
    const after = scenario.client.getSnapshot().settings["host"];
    expect(after?.stale).toBe(false);
    expect(after?.desiredRevision).toBe(2);
    expect(after?.effectiveRevision).toBe(1);
  });

  it("records a namespace it has never read without inventing a value", async () => {
    const scenario = scenarioWithSettings();
    await scenario.ready();

    scenario.host.emit({
      type: "settings.updated",
      namespace: "plugin:demo",
      revision: 7,
      restartRequired: true,
    });
    await flush();

    const entry = scenario.client.getSnapshot().settings["plugin:demo"];
    expect(entry?.snapshot).toBeNull();
    expect(entry?.desiredRevision).toBe(7);
    expect(entry?.stale).toBe(true);
  });

  it("moves the published summary of the host's own namespaces", async () => {
    const scenario = scenarioWithSettings();
    await scenario.ready();

    const before = scenario.client.getSnapshot().presentation?.settings.find((entry) => entry.namespace === "host");
    expect(before?.desiredRevision).toBe(1);

    scenario.host.emit({ type: "settings.updated", namespace: "host", revision: 2, restartRequired: true });
    await flush();

    const after = scenario.client.getSnapshot().presentation?.settings.find((entry) => entry.namespace === "host");
    expect(after?.desiredRevision).toBe(2);
    expect(after?.restartRequired).toBe(true);
    expect(after?.effectiveRevision).toBe(1);
  });
});

describe("a refused write", () => {
  it("changes nothing and is not sent again", async () => {
    const scenario = scenarioWithSettings();
    await scenario.ready();

    const refusal = scenario.client.settings.update({
      namespace: "host",
      expectedRevision: 9,
      value: { systemPrompt: "never", loop: { maxSteps: 1, maxModelAttempts: 1 } },
    });
    scenario.host.respondError(scenario.host.requestIdOf("settings.update") as string, "REVISION_CONFLICT");

    await expect(refusal).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await flush();

    // No value was filed, and exactly one write was sent: a refusal is told,
    // never retried behind the caller's back.
    expect(scenario.client.getSnapshot().settings["host"]).toBeUndefined();
    expect(scenario.host.requests.filter((request) => request.method === "settings.update")).toHaveLength(1);
  });

  it("files the answer of an accepted write", async () => {
    const scenario = scenarioWithSettings();
    await scenario.ready();

    const accepted = scenario.client.settings.update({
      namespace: "host",
      expectedRevision: 1,
      value: { systemPrompt: "next", loop: { maxSteps: 3, maxModelAttempts: 1 } },
    });
    scenario.host.respond(scenario.host.requestIdOf("settings.update") as string, "settings.update", {
      settings: snapshot("host", 2, 1),
    });
    const result = await accepted;

    expect(result.settings.restartRequired).toBe(true);
    const entry = scenario.client.getSnapshot().settings["host"];
    expect(entry?.desiredRevision).toBe(2);
    expect(entry?.effectiveRevision).toBe(1);
    expect(entry?.restartRequired).toBe(true);
  });
});
