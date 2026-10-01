/**
 * The presentation store: immutable, isolated, and honest about change.
 *
 * What a caller may rely on: the same object while nothing changed, a frozen
 * one that cannot be edited into the client's state, structurally shared
 * branches, one notification per change — and the rule the whole design exists
 * for: an operation response never writes to it.
 */

import { describe, expect, it } from "vitest";

import { openWith, createScenario } from "./helpers/scenario.js";
import { activeRun, sessionPage, sessionSummary } from "./helpers/values.js";

describe("snapshot identity", () => {
  it("returns the same object while nothing changes", async () => {
    const scenario = createScenario();
    await scenario.ready();

    expect(scenario.client.getSnapshot()).toBe(scenario.client.getSnapshot());
    expect(scenario.client.getState()).toBe(scenario.client.getSnapshot());
  });

  it("returns a new object once something changes, and notifies once", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const before = scenario.client.getSnapshot();
    let notifications = 0;
    scenario.client.subscribe(() => {
      notifications += 1;
    });

    scenario.host.emit({ type: "plugin.updated", plugin: { id: "demo", name: "Demo", version: "1.0.0", permissions: [], status: "enabled" } });
    const after = scenario.client.getSnapshot();

    expect(notifications).toBe(1);
    expect(after).not.toBe(before);
  });

  it("does not notify for a change that is not one", async () => {
    const scenario = createScenario();
    await scenario.ready();
    let notifications = 0;
    scenario.client.subscribe(() => {
      notifications += 1;
    });

    scenario.client.disconnect();
    const first = notifications;
    scenario.client.disconnect();

    expect(notifications).toBe(first);
  });

  it("stops notifying a removed listener", async () => {
    const scenario = createScenario();
    await scenario.ready();
    let notifications = 0;
    const remove = scenario.client.subscribe(() => {
      notifications += 1;
    });
    remove();

    scenario.client.disconnect();

    expect(notifications).toBe(0);
  });

  it("keeps notifying when a listener throws", async () => {
    const scenario = createScenario();
    await scenario.ready();
    let otherListenerRan = false;
    scenario.client.subscribe(() => {
      throw new Error("a listener that cannot behave");
    });
    scenario.client.subscribe(() => {
      otherListenerRan = true;
    });

    scenario.client.disconnect();

    expect(otherListenerRan).toBe(true);
  });
});

describe("isolation", () => {
  it("hands out frozen data that cannot be edited into the client's state", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([sessionSummary({ sessionId: "s-1" })]) });

    const presentation = scenario.client.getSnapshot().presentation;
    expect(presentation).not.toBeNull();
    expect(Object.isFrozen(presentation)).toBe(true);
    expect(() => {
      (presentation?.sessions.items as unknown as string[]).push("s-2");
    }).toThrow();
    expect(scenario.client.getSnapshot().presentation?.sessions.items).toHaveLength(1);
  });

  it("shares the branches an event did not touch", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([sessionSummary({ sessionId: "s-1" })]) });
    const before = scenario.client.getSnapshot().presentation;

    scenario.host.emit({ type: "session.created", session: sessionSummary({ sessionId: "s-2" }) });
    const after = scenario.client.getSnapshot().presentation;

    expect(after?.sessions).not.toBe(before?.sessions);
    expect(after?.runs).toBe(before?.runs);
    expect(after?.plugins).toBe(before?.plugins);
  });
});

describe("the store is not a response cache", () => {
  it("ignores the result of an operation, however convincing", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const host = scenario.host;
    const before = scenario.client.getSnapshot().presentation;

    const created = scenario.client.sessions.create();
    host.respond(host.requestIdOf("sessions.create") ?? "", "sessions.create", {
      session: sessionSummary({ sessionId: "s-created" }),
    });

    await expect(created).resolves.toMatchObject({ session: { sessionId: "s-created" } });
    expect(scenario.client.getSnapshot().presentation).toBe(before);
    expect(scenario.client.getSnapshot().presentation?.sessions.items).toHaveLength(0);
  });

  it("ignores a run result too", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const host = scenario.host;
    const before = scenario.client.getSnapshot().presentation;

    const started = scenario.client.runs.start({ sessionId: "s-1", submissionId: "sub-1", text: "hello" });
    host.respond(host.requestIdOf("runs.start") ?? "", "runs.start", {
      run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }),
    });

    await started;
    expect(scenario.client.getSnapshot().presentation).toBe(before);
  });
});

describe("what a caller reads cannot be edited into the client's state", () => {
  it("keeps capability enforcement independent of the published description", async () => {
    const scenario = createScenario({ host: { capabilities: { plugins: false } } });
    await scenario.ready();
    const description = scenario.client.getSnapshot().description;
    expect(description).not.toBeNull();
    expect(Object.isFrozen(description)).toBe(true);
    expect(Object.isFrozen(description?.capabilities)).toBe(true);

    expect(() => {
      (description?.capabilities as unknown as { plugins: boolean }).plugins = true;
    }).toThrow();

    const before = scenario.host.sent.length;
    const refused = scenario.client.plugins.enable({ pluginId: "demo" });
    await expect(refused).rejects.toMatchObject({ reason: "capability-unavailable" });
    expect(scenario.host.sent.length).toBe(before);
  });

  it("keeps a published error uneditable, with a stable snapshot identity", async () => {
    const scenario = createScenario();
    await scenario.ready();
    scenario.host.close();

    const before = scenario.client.getSnapshot();
    const error = before.error;
    expect(error).not.toBeNull();
    const reason = error?.reason;

    expect(() => {
      (error as unknown as { reason: string }).reason = "caller-corrupted";
    }).toThrow();

    expect(scenario.client.getSnapshot()).toBe(before);
    expect(scenario.client.getSnapshot().error?.reason).toBe(reason);
  });
});
