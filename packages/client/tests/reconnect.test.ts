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
import { createFakeHost, type FakeHost } from "./helpers/fake-host.js";
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

describe("invalidation comes before publication", () => {
  it("a listener that hears about a disconnection cannot send on it", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const before = scenario.host.sent.length;
    let attempted = false;

    scenario.client.subscribe(() => {
      if (attempted || scenario.client.getSnapshot().status !== "disconnected") return;
      attempted = true;
      void scenario.client.sessions.create().catch(() => undefined);
    });
    scenario.client.disconnect();
    await flush();

    expect(attempted).toBe(true);
    expect(scenario.host.sent.length).toBe(before);
  });

  it("a bootstrap continuation that resumes after a disconnect changes nothing", async () => {
    const scenario = createScenario({ host: { auto: false } });
    const connecting = scenario.client.connect().catch((error: unknown) => error);

    await flush();
    scenario.host.serveDescribe();
    scenario.client.disconnect();
    const afterDisconnect = scenario.client.getSnapshot();
    let notifications = 0;
    scenario.client.subscribe(() => {
      notifications += 1;
    });

    await connecting;
    await flush();

    expect(scenario.client.getSnapshot()).toBe(afterDisconnect);
    expect(notifications).toBe(0);
    expect(scenario.host.requests.some((request) => request.method === "subscriptions.open")).toBe(false);
  });

  it("an old epoch's frames are inert, whichever kind they are", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const old = scenario.host;

    await scenario.client.reconnect();
    const current = scenario.host;
    const before = scenario.client.getSnapshot();
    let notifications = 0;

    old.deliverLate(
      JSON.stringify({
        kind: "host-event",
        protocolVersion: "1",
        hostInstanceId: old.hostInstanceId,
        streamId: old.currentStreamId,
        sequence: 1,
        type: "session.created",
        scope: { kind: "session", sessionId: "late" },
        payload: { session: sessionSnapshot({ sessionId: "late" }) },
      }),
    );
    old.deliverLate(
      JSON.stringify({
        kind: "host-request",
        protocolVersion: "1",
        hostInstanceId: old.hostInstanceId,
        streamId: old.currentStreamId,
        requestId: "late-request",
        method: "test.echo",
        params: { value: "late" },
        timeoutMs: 1000,
      }),
    );
    const remove = scenario.client.subscribe(() => {
      notifications += 1;
    });
    await flush();
    remove();

    expect(scenario.client.getSnapshot()).toBe(before);
    expect(notifications).toBe(0);
    expect(current.isClosed).toBe(false);
  });

  it("a listener that disconnects when the channel comes up keeps the client disconnected", async () => {
    const scenario = createScenario({ host: { auto: false } });
    let ended = false;
    scenario.client.subscribe(() => {
      if (ended || scenario.client.getSnapshot().status !== "connected") return;
      ended = true;
      scenario.client.disconnect();
    });

    const connecting = scenario.client.connect().catch((error: unknown) => error);
    await flush();

    // The bootstrap that heard "connected" must not resume into a describe and a
    // status of its own: the generation that owns it is gone, and the listener
    // asked for exactly this.
    expect(ended).toBe(true);
    expect(scenario.client.getSnapshot().status).toBe("disconnected");
    expect(scenario.host.requests).toHaveLength(0);
    await expect(connecting).resolves.toMatchObject({ code: "CONNECTION_LOST", outcome: "unknown" });
  });

  it("a listener that disconnects from a stale presentation stops the cut it was reading", async () => {
    const scenario = createScenario();
    await scenario.ready();
    let ended = false;
    scenario.client.subscribe(() => {
      if (ended || !scenario.client.getSnapshot().stale) return;
      ended = true;
      scenario.client.disconnect();
    });

    await expect(scenario.client.resync()).rejects.toMatchObject({ code: "CONNECTION_LOST" });
    await flush();

    // The cut's own continuation cannot say anything about a client its owner
    // has already disconnected: no "lost", no "syncing", no second open.
    expect(ended).toBe(true);
    expect(scenario.client.getSnapshot().status).toBe("disconnected");
    expect(scenario.host.requests.filter((request) => request.method === "subscriptions.open")).toHaveLength(1);
  });

  it("a channel that closes while its listener is installed is disposed of as well", async () => {
    let disposed = 0;
    const sent: string[] = [];
    const client = createClient({
      connect: async () => ({
        listen: (listener) => {
          listener.onClose();
          return () => {
            disposed += 1;
          };
        },
        send: (frame: string): void => {
          sent.push(frame);
        },
        close: (): void => undefined,
      }),
    });

    await expect(client.connect()).rejects.toMatchObject({ code: "CONNECTION_LOST" });

    // The generation that heard its own channel close owns the disposer too:
    // dropping it would leave a listener the transport still believes in.
    expect(disposed).toBe(1);
    expect(sent).toHaveLength(0);
    expect(client.getSnapshot().status).toBe("lost");
    client.disconnect();
  });

  it("a protocol failure cannot retire a connection opened while it was being reported", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const failed = scenario.host;

    let reconnected = false;
    let fresh: Promise<unknown> | undefined;
    scenario.client.subscribe(() => {
      if (reconnected || scenario.client.getSnapshot().status !== "protocol-error") return;
      reconnected = true;
      fresh = scenario.client.reconnect().catch((error: unknown) => error);
    });

    const resyncing = scenario.client.resync().catch((error: unknown) => error);
    await flush();
    failed.sendRaw(
      JSON.stringify({
        kind: "host-response",
        protocolVersion: "1",
        hostInstanceId: failed.hostInstanceId,
        requestId: failed.requestIdOf("subscriptions.open", 1) ?? "",
        result: { wrong: "shape" },
      }),
    );

    // The violation belonged to the connection that received it; the one a
    // listener opened while hearing about it is not that failure's to end.
    await expect(resyncing).resolves.toMatchObject({ kind: "protocol", reason: "invalid-response" });
    await flush();
    scenario.host.serveDescribe();
    await flush();
    scenario.host.serveOpen({ sessions: [SESSION] });
    await fresh;

    expect(reconnected).toBe(true);
    expect(failed.isClosed).toBe(true);
    expect(scenario.host.isClosed).toBe(false);
    expect(scenario.attempts).toBe(2);
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });

  it("a transport that fails a send after delivering a violation cannot end the replacement", async () => {
    const hosts: FakeHost[] = [];
    let failNext = false;
    const client = createClient({
      connect: async (): Promise<ProtocolChannel> => {
        const host = createFakeHost();
        hosts.push(host);
        const base = host.channel;
        return {
          listen: (listener) => base.listen(listener),
          close: (): void => {
            base.close();
          },
          send: (frame: string): void => {
            if (failNext) {
              failNext = false;
              // A transport that answers the frame with a violation of its own,
              // and then fails the very send that carried it.
              host.sendRaw("{");
              throw new Error("the transport refused the frame");
            }
            base.send(frame);
          },
        };
      },
    });

    await client.connect();
    const replaced = hosts[0]!;
    let reconnected = false;
    let fresh: Promise<unknown> | undefined;
    client.subscribe(() => {
      if (reconnected || client.getSnapshot().status !== "protocol-error") return;
      reconnected = true;
      fresh = client.reconnect().catch((error: unknown) => error);
    });

    failNext = true;
    const listing = client.sessions.list().catch((error: unknown) => error);
    await fresh;

    // Cleaning up after a transport that failed must not reach into the
    // connection that replaced the one which failed.
    expect(reconnected).toBe(true);
    await expect(listing).resolves.toMatchObject({ kind: "protocol", reason: "invalid-frame" });
    expect(replaced.isClosed).toBe(true);
    expect(hosts).toHaveLength(2);
    expect(hosts[1]?.isClosed).toBe(false);
    expect(client.getSnapshot().status).toBe("ready");
  });
});

describe("a retirement that a callback already superseded", () => {
  /**
   * A channel whose retirement runs the caller's own code.
   *
   * Both boundaries a retirement crosses on its way out — handing back the
   * listener, and closing the transport — are foreign code, and this fixture is
   * the smallest way to say that one of them re-entered the client.
   */
  function retiringChannel(host: FakeHost, boundary: "disposer" | "close", onReenter: () => void): ProtocolChannel {
    const base = host.channel;
    return {
      listen: (listener) => {
        const dispose = base.listen(listener);
        return () => {
          dispose();
          if (boundary === "disposer") onReenter();
        };
      },
      send: (frame: string): void => {
        base.send(frame);
      },
      close: (): void => {
        base.close();
        if (boundary === "close") onReenter();
      },
    };
  }

  for (const boundary of ["disposer", "close"] as const) {
    it(`a disconnection made from the retirement's own ${boundary} is not overwritten`, async () => {
      const host = createFakeHost();
      let disconnects = 0;
      let armed = false;
      const client = createClient({
        connect: async (): Promise<ProtocolChannel> =>
          retiringChannel(host, boundary, () => {
            if (!armed) return;
            armed = false;
            disconnects += 1;
            client.disconnect();
          }),
      });

      await client.connect();
      armed = true;
      host.close();

      // Retiring the connection runs that code, and the disconnection it decided
      // on is the newer fact about this client: the loss cleanup that started the
      // retirement does not get to replace it with "lost".
      expect(disconnects).toBe(1);
      expect(client.getSnapshot().status).toBe("disconnected");
    });
  }

  for (const stage of ["loss", "disconnect"] as const) {
    it(`a reconnect made from the retirement's own disposer outlives the ${stage} that started it`, async () => {
      const seen: string[] = [];
      let reentered = false;
      let fresh: Promise<unknown> | undefined;
      let current: FakeHost | undefined;
      const client = createClient({
        connect: async (): Promise<ProtocolChannel> => {
          const host = createFakeHost();
          current = host;
          return {
            listen: (listener) => {
              const dispose = host.channel.listen(listener);
              return () => {
                dispose();
                if (reentered) return;
                reentered = true;
                fresh = client.reconnect().catch((error: unknown) => error);
              };
            },
            send: (frame: string): void => {
              host.channel.send(frame);
            },
            close: (): void => {
              host.channel.close();
            },
          };
        },
      });
      client.subscribe(() => {
        seen.push(client.getSnapshot().status);
      });

      await client.connect();
      if (stage === "loss") {
        // The channel is gone, and the cleanup that hears about it runs the
        // disposer, which reconnects before the loss can be published.
        current?.close();
      } else {
        client.disconnect();
      }
      await fresh;

      // The reconnect is the newer fact: the retirement driven by the loss, or by
      // the disconnection, is not published over it.
      expect(reentered).toBe(true);
      expect(seen).not.toContain("lost");
      expect(seen).not.toContain("disconnected");
      expect(client.getSnapshot().status).toBe("ready");
    });
  }

  it("a disconnection made while a reconnect retires the old connection stops that reconnect", async () => {
    let attempts = 0;
    let disconnects = 0;
    const client = createClient({
      connect: async (): Promise<ProtocolChannel> => {
        attempts += 1;
        return retiringChannel(createFakeHost(), "disposer", () => {
          if (disconnects > 0) return;
          disconnects += 1;
          client.disconnect();
        });
      },
    });

    await client.connect();
    const reconnecting = client.reconnect().catch((error: unknown) => error);
    await flush();

    // The disconnection the disposer made is the newer decision, and it wins:
    // the reconnect that started the retirement does not ask for a channel of
    // its own afterwards.
    expect(disconnects).toBe(1);
    expect(attempts).toBe(1);
    expect(client.getSnapshot().status).toBe("disconnected");
    await expect(reconnecting).resolves.toMatchObject({ code: "CONNECTION_LOST" });
  });

  it("a listener that ends the attempt it just heard about stops it before the connector runs", async () => {
    let connects = 0;
    const client = createClient({
      connect: async (): Promise<ProtocolChannel> => {
        connects += 1;
        return createFakeHost().channel;
      },
    });
    let ended = false;
    client.subscribe(() => {
      if (ended || client.getSnapshot().status !== "connecting") return;
      ended = true;
      client.disconnect();
    });

    const connecting = client.connect().catch((error: unknown) => error);
    await flush();

    // The publication that announced the attempt is where the listener heard
    // about it, and the attempt it ended is not one to open a transport for.
    expect(ended).toBe(true);
    expect(connects).toBe(0);
    expect(client.getSnapshot().status).toBe("disconnected");
    await expect(connecting).resolves.toMatchObject({ code: "CONNECTION_LOST" });
  });

  it("a channel the attempt cannot listen on is closed exactly once, and is not left behind", async () => {
    let closed = 0;
    let refusals = 1;
    const client = createClient({
      connect: async (): Promise<ProtocolChannel> => {
        if (refusals > 0) {
          refusals -= 1;
          return {
            listen: (): (() => void) => {
              throw new Error("the transport refused the listener");
            },
            send: (): void => undefined,
            close: (): void => {
              closed += 1;
            },
          };
        }
        return createFakeHost().channel;
      },
    });

    await expect(client.connect()).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      reason: "connector-failed",
    });

    // The channel was this attempt's from the moment it was delivered, so the
    // failure ends the attempt the way every other failure does — ownership
    // invalidated, the channel closed exactly once, the outcome published —
    // rather than leaving the client `connecting` over a channel it still owns.
    expect(closed).toBe(1);
    expect(client.getSnapshot().status).toBe("lost");

    // Nothing of that attempt holds the client any more: the next one gets a
    // channel of its own and reaches `ready`.
    await expect(client.connect()).resolves.toBeUndefined();
    expect(closed).toBe(1);
    expect(client.getSnapshot().status).toBe("ready");
    client.disconnect();
  });
});
