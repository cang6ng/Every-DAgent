/**
 * Connections, epochs and the end of them.
 *
 * The epoch is local: every attempt gets one, and everything bound to an older
 * one is inert — a late answer, a late event, a late close, a connector that
 * resolves after it was replaced. The host instance is a different fact, learned
 * from `describe`, and it decides whether the presentation a client kept is
 * still this host's state at all.
 */

import { describe, expect, it } from "vitest";

import type { ProtocolChannel } from "@every-dagent/protocol";

import { createClient } from "../src/index.js";

import { createScenario, flush, openWith, statusTransitions } from "./helpers/scenario.js";
import { createFakeHost } from "./helpers/fake-host.js";
import { sessionSnapshot } from "./helpers/values.js";

const SESSION = sessionSnapshot({ sessionId: "s-1" });

describe("reconnecting", () => {
  it("replaces the presentation from the new connection", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });

    const reconnecting = scenario.client.reconnect();
    await flush();
    scenario.host.serveDescribe();
    await flush();
    scenario.host.serveOpen({ sessions: [sessionSnapshot({ sessionId: "s-2" })] });
    await reconnecting;

    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(scenario.client.getSnapshot().presentation?.sessions.map((session) => session.sessionId)).toEqual(["s-2"]);
    expect(scenario.attempts).toBe(2);
  });

  it("marks the retained presentation as belonging to the previous host when the instance changed", async () => {
    const scenario = createScenario({
      makeHost: (index) => createFakeHost({ auto: false, hostInstanceId: index === 0 ? "host-1" : "host-2" }),
    });
    await openWith(scenario, { sessions: [SESSION] });

    const reconnecting = scenario.client.reconnect();
    await flush();
    scenario.host.serveDescribe();
    await flush();

    const during = scenario.client.getSnapshot();
    expect(during.presentationHost).toBe("previous");
    expect(during.presentation?.hostInstanceId).toBe("host-1");
    expect(during.stale).toBe(true);

    scenario.host.serveOpen({ sessions: [] });
    await reconnecting;

    const after = scenario.client.getSnapshot();
    expect(after.presentationHost).toBe("current");
    expect(after.presentation?.hostInstanceId).toBe("host-2");
    expect(after.stale).toBe(false);
  });

  it("keeps the presentation as unconfirmed until the new connection describes itself", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });

    const reconnecting = scenario.client.reconnect();
    await flush();

    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.status).toBe("syncing");
    expect(snapshot.presentationHost).toBe("unconfirmed");
    expect(snapshot.presentation?.sessions).toHaveLength(1);

    scenario.host.serveDescribe();
    await flush();
    expect(scenario.client.getSnapshot().presentationHost).toBe("current");

    scenario.host.serveOpen({ sessions: [SESSION] });
    await reconnecting;
  });

  it("merges a reconnect that arrives while one is in flight", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });

    const first = scenario.client.reconnect();
    const second = scenario.client.reconnect();
    await flush();

    expect(scenario.attempts).toBe(2);
    scenario.host.serveDescribe();
    await flush();
    scenario.host.serveOpen({ sessions: [] });
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it("is a no-op when the client is already ready", async () => {
    const scenario = createScenario();
    await scenario.ready();

    await expect(scenario.client.connect()).resolves.toBeUndefined();
    expect(scenario.attempts).toBe(1);
  });
});

describe("an old connection cannot touch a new one", () => {
  it("ignores a response that arrives after reconnecting", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const firstHost = scenario.host;
    const listing = scenario.client.sessions.list().catch((error: unknown) => error);
    const requestId = firstHost.requestIdOf("sessions.list") ?? "";
    const instanceId = firstHost.hostInstanceId;

    const reconnecting = scenario.client.reconnect();
    await flush();
    scenario.host.serveDescribe();
    await flush();
    scenario.host.serveOpen({ sessions: [] });
    await reconnecting;

    // The answer to the old connection's request, delivered by a transport that
    // had already accepted it.
    firstHost.deliverLate(
      JSON.stringify({
        kind: "host-response",
        protocolVersion: "1",
        hostInstanceId: instanceId,
        requestId,
        result: { sessions: [] },
      }),
    );
    const failure = await listing;

    expect(failure).toMatchObject({ code: "CONNECTION_LOST", outcome: "unknown" });
    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(scenario.client.getSnapshot().presentation?.sessions).toHaveLength(0);
  });

  it("ignores an event that arrives after reconnecting", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const oldHost = scenario.host;
    const oldStream = oldHost.currentStreamId;

    const reconnecting = scenario.client.reconnect();
    await flush();
    scenario.host.serveDescribe();
    await flush();
    scenario.host.serveOpen({ sessions: [sessionSnapshot({ sessionId: "s-2" })] });
    await reconnecting;

    oldHost.deliverLate(
      JSON.stringify({
        kind: "host-event",
        protocolVersion: "1",
        hostInstanceId: oldHost.hostInstanceId,
        streamId: oldStream,
        sequence: oldHost.currentSequence + 1,
        type: "session.created",
        scope: { kind: "session", sessionId: "s-old" },
        payload: { session: sessionSnapshot({ sessionId: "s-old" }) },
      }),
    );

    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(scenario.client.getSnapshot().presentation?.sessions.map((session) => session.sessionId)).toEqual(["s-2"]);
  });

  it("ignores a close from the old connection after the new one is ready", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const oldHost = scenario.host;

    const reconnecting = scenario.client.reconnect();
    await flush();
    scenario.host.serveDescribe();
    await flush();
    scenario.host.serveOpen({ sessions: [SESSION] });
    await reconnecting;

    oldHost.closeLate();
    await flush();

    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(scenario.client.getSnapshot().stale).toBe(false);
  });

  it("closes a channel that arrives after its attempt was abandoned", async () => {
    const gates: { resolve: (channel: ProtocolChannel) => void; promise: Promise<ProtocolChannel> }[] = [];
    const client = createClient({
      connect: () => {
        let resolve!: (channel: ProtocolChannel) => void;
        const promise = new Promise<ProtocolChannel>((settle) => {
          resolve = settle;
        });
        gates.push({ resolve, promise });
        return promise;
      },
    });

    const connecting = client.connect();
    await flush();
    client.disconnect();

    const late = createFakeHost();
    gates[0]?.resolve(late.channel);

    await expect(connecting).rejects.toMatchObject({ code: "CONNECTION_LOST" });
    expect(late.isClosed).toBe(true);
    expect(late.sent).toHaveLength(0);
    expect(client.getSnapshot().status).toBe("disconnected");
  });
});

describe("disconnecting", () => {
  it("keeps the presentation, marks it stale, and stops claiming anything about runs", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });

    scenario.client.disconnect();

    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.status).toBe("disconnected");
    expect(snapshot.stale).toBe(true);
    expect(snapshot.presentation?.sessions).toHaveLength(1);
    expect(snapshot.error).toBeNull();
  });

  it("sends no run cancellation", async () => {
    const scenario = createScenario();
    await scenario.ready();

    scenario.client.disconnect();

    const methods = scenario.host.requests.map((request) => request.method);
    expect(methods).not.toContain("runs.cancel");
  });

  it("can be followed by a fresh connection", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    scenario.client.disconnect();

    const connecting = scenario.client.connect();
    await flush();
    scenario.host.serveDescribe();
    await flush();
    scenario.host.serveOpen({ sessions: [SESSION] });
    await connecting;

    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(statusTransitions(scenario)).toContain("disconnected");
  });
});
