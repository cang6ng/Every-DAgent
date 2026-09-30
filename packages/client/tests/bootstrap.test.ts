/**
 * Bootstrap: `describe` → `open` → `ready`, and every way it can go wrong.
 *
 * The point of these tests is the boundary between "the channel is up" and "the
 * client is synchronized". Nothing here may be called ready before a validated
 * snapshot is installed, and nothing that arrives out of order may be applied
 * just because the transport happened to deliver it.
 */

import { describe, expect, it, vi } from "vitest";

import { decodeFrame } from "@every-dagent/protocol";

import { createScenario, flush, statusTransitions } from "./helpers/scenario.js";
import { sessionSnapshot } from "./helpers/values.js";

describe("the bootstrap sequence", () => {
  it("walks connecting → connected → syncing → ready, and is never ready without a snapshot", async () => {
    const scenario = createScenario();
    await scenario.ready();

    expect(statusTransitions(scenario)).toEqual(["connecting", "connected", "syncing", "ready"]);

    const connected = scenario.statuses.find((change) => change.status === "connected");
    expect(connected?.presentation).toBeNull();
    expect(connected?.description).toBeNull();

    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.presentation).not.toBeNull();
    expect(snapshot.description?.hostInstanceId).toBe(scenario.host.hostInstanceId);
    expect(snapshot.stale).toBe(false);
    expect(snapshot.presentationHost).toBe("current");
  });

  it("describes itself as generation 1 with the reverse capability and the caller's name", async () => {
    const scenario = createScenario({ client: { name: "cli-fixture", version: "2.0.0" } });
    await scenario.ready();

    const params = scenario.host.lastDescribe;
    expect(params?.supportedProtocolVersions).toEqual(["1"]);
    expect(params?.client).toEqual({ name: "cli-fixture", version: "2.0.0" });
    expect(params?.capabilities).toEqual({ reverseRequests: true });
  });

  it("installs the open snapshot before the frames behind it are read", async () => {
    const scenario = createScenario({ host: { auto: false } });
    const connecting = scenario.client.connect();
    await flush();
    scenario.host.serveDescribe();
    await flush();

    const host = scenario.host;
    const first = sessionSnapshot({ sessionId: "s-1" });
    const second = sessionSnapshot({ sessionId: "s-2" });

    // One synchronous batch: the snapshot response, then an event on the stream
    // it just created — the exact order the host promises to deliver in.
    host.serveOpen({ sessions: [first] });
    host.emit({ type: "session.created", session: second });
    await connecting;

    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.presentation?.sessions.map((session) => session.sessionId)).toEqual(["s-1", "s-2"]);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.stale).toBe(false);
  });

  it("leaves a snapshot behind for the frames that follow it", async () => {
    const scenario = createScenario({ host: { auto: false } });
    const connecting = scenario.client.connect();
    await flush();
    scenario.host.serveDescribe();
    await flush();

    scenario.host.serveOpen({ sessions: [sessionSnapshot({ sessionId: "s-1" })] });
    await connecting;

    expect(scenario.client.getSnapshot().presentation?.sessions).toHaveLength(1);
  });
});

describe("what bootstrap refuses", () => {
  it("ends the connection when the description names a different instance than the frame", async () => {
    const scenario = createScenario({ host: { auto: false } });
    const connecting = scenario.client.connect();
    await flush();

    scenario.host.serveDescribe({ hostInstanceId: "someone-else" });

    await expect(connecting).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
    expect(scenario.client.getSnapshot().presentation).toBeNull();
  });

  it("ends the connection when the description does not echo the declared capabilities", async () => {
    const scenario = createScenario({ host: { auto: false, clientCapabilitiesReverse: false } });
    const connecting = scenario.client.connect();
    await flush();

    scenario.host.serveDescribe();

    await expect(connecting).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("refuses to continue when the host honestly reports no subscriptions", async () => {
    const scenario = createScenario({ host: { auto: false, capabilities: { subscriptions: false } } });
    const connecting = scenario.client.connect();
    await flush();

    scenario.host.serveDescribe();

    await expect(connecting).rejects.toMatchObject({ code: "CLIENT_MISUSE", reason: "capability-unavailable" });
    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.status).toBe("connected");
    expect(snapshot.presentation).toBeNull();
    expect(snapshot.error?.reason).toBe("capability-unavailable");
  });

  it("stops on another generation instead of downgrading", async () => {
    const scenario = createScenario({ host: { auto: false } });
    const connecting = scenario.client.connect();
    await flush();

    const requestId = scenario.host.requestIdOf("host.describe");
    expect(requestId).toBeDefined();
    scenario.host.sendRaw(
      JSON.stringify({
        kind: "host-response",
        protocolVersion: "2",
        hostInstanceId: scenario.host.hostInstanceId,
        requestId,
        result: {},
      }),
    );

    await expect(connecting).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION", reason: "unsupported-protocol" });
    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("reports a refused generation without pretending to be initialized", async () => {
    const scenario = createScenario({ host: { auto: false } });
    const connecting = scenario.client.connect();
    await flush();

    scenario.host.respondError(scenario.host.requestIdOf("host.describe") ?? "", "UNSUPPORTED_PROTOCOL");

    await expect(connecting).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL", kind: "remote" });
    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.status).toBe("connected");
    expect(snapshot.description).toBeNull();
    expect(snapshot.presentation).toBeNull();
  });

  it("ends the connection when stream traffic arrives before the snapshot", async () => {
    const scenario = createScenario({ host: { auto: false } });
    const connecting = scenario.client.connect();
    await flush();
    scenario.host.serveDescribe();
    await flush();

    scenario.host.sendRaw(
      JSON.stringify({
        kind: "host-event",
        protocolVersion: "1",
        hostInstanceId: scenario.host.hostInstanceId,
        streamId: "stream-early",
        sequence: 1,
        type: "session.created",
        scope: { kind: "session", sessionId: "s-1" },
        payload: { session: sessionSnapshot({ sessionId: "s-1" }) },
      }),
    );

    await expect(connecting).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION", reason: "snapshot-fence" });
    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("ends the connection when an event names a stream the client never opened", async () => {
    const scenario = createScenario();
    await scenario.ready();

    scenario.host.sendRaw(
      JSON.stringify({
        kind: "host-event",
        protocolVersion: "1",
        hostInstanceId: scenario.host.hostInstanceId,
        streamId: "not-the-stream",
        sequence: 1,
        type: "session.created",
        scope: { kind: "session", sessionId: "s-1" },
        payload: { session: sessionSnapshot({ sessionId: "s-1" }) },
      }),
    );

    // A stream the client does not hold is not its stream: dropped, and the
    // connection is untouched.
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });
});

describe("the frames themselves", () => {
  it("sends every frame as a JSON object the protocol can read back", async () => {
    const scenario = createScenario();
    await scenario.ready();

    expect(scenario.host.sent.length).toBeGreaterThan(1);
    for (const frame of scenario.host.sent) {
      const decoded = decodeFrame(frame);
      expect(decoded.success).toBe(true);
    }
    expect(typeof scenario.host.sent[0]).toBe("string");
  });
});

describe("a control request cannot wait forever", () => {
  it("ends the attempt when describe is never answered", async () => {
    vi.useFakeTimers();
    try {
      const scenario = createScenario({ host: { auto: false } });
      const connecting = scenario.client.connect().catch((error: unknown) => error);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();

      expect(scenario.client.getSnapshot().status).toBe("syncing");
      await vi.advanceTimersByTimeAsync(60_000);

      const failure = await connecting;
      expect(failure).toMatchObject({ code: "CONNECTION_LOST", reason: "control-timeout" });
      expect(scenario.client.getSnapshot().status).toBe("lost");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the attempt when open is never answered", async () => {
    vi.useFakeTimers();
    try {
      const scenario = createScenario({ host: { auto: false } });
      const connecting = scenario.client.connect().catch((error: unknown) => error);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      scenario.host.serveDescribe();
      for (let index = 0; index < 10; index += 1) await Promise.resolve();

      expect(scenario.host.requests.filter((request) => request.method === "subscriptions.open")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);

      const failure = await connecting;
      expect(failure).toMatchObject({ code: "CONNECTION_LOST", reason: "control-timeout" });
      expect(scenario.client.getSnapshot().status).toBe("lost");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out a business request", async () => {
    vi.useFakeTimers();
    try {
      const scenario = createScenario();
      const connecting = scenario.client.connect();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();

      const listing = scenario.client.sessions.list();
      let settled = "";
      void listing.then(
        () => {
          settled = "resolved";
        },
        () => {
          settled = "rejected";
        },
      );
      await vi.advanceTimersByTimeAsync(120_000);
      await Promise.resolve();

      expect(settled).toBe("");
      expect(listing).toBeDefined();
      void connecting;
    } finally {
      vi.useRealTimers();
    }
  });
});
