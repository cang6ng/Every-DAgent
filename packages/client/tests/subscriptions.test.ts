/**
 * Streams: sequence, gaps, resync and closing.
 *
 * A subscription is a cut plus a numbered tail, and the client's only honest
 * tools are the ones the contract names: apply what is exactly next, drop what
 * is behind, and re-cut on a gap — never guess, never patch, and never let a
 * stream that was ended come back to life.
 */

import { describe, expect, it } from "vitest";

import { createScenario, flush, openWith } from "./helpers/scenario.js";
import { sessionSnapshot } from "./helpers/values.js";

const SESSION = sessionSnapshot({ sessionId: "s-1" });

function badEvent(host: { readonly hostInstanceId: string; readonly currentStreamId: string | undefined }, sequence: number, sessionId: string): string {
  return JSON.stringify({
    kind: "host-event",
    protocolVersion: "1",
    hostInstanceId: host.hostInstanceId,
    streamId: host.currentStreamId,
    sequence,
    type: "session.created",
    scope: { kind: "session", sessionId },
    payload: { session: sessionSnapshot({ sessionId }) },
  });
}

describe("sequence", () => {
  it("applies exactly the next event and advances", async () => {
    const scenario = createScenario();
    await scenario.ready();

    scenario.host.emit({ type: "session.created", session: SESSION });

    expect(scenario.client.getSnapshot().presentation?.sessions).toHaveLength(1);
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });

  it("drops a duplicate without applying it twice", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const host = scenario.host;
    const frame = badEvent(host, host.currentSequence + 1, "s-1");

    host.sendRaw(frame);
    const afterFirst = scenario.client.getSnapshot().presentation;

    host.sendRaw(frame);

    expect(scenario.client.getSnapshot().presentation).toBe(afterFirst);
    expect(scenario.client.getSnapshot().presentation?.sessions).toHaveLength(1);
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });

  it("does not apply a gap, and re-cuts the subscription instead", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;

    // Sequence 1 never arrives; 2 does — and is not applied.
    host.sendRaw(badEvent(host, host.currentSequence + 2, "s-skipped"));
    await flush();

    expect(host.requests.filter((request) => request.method === "subscriptions.open")).toHaveLength(2);

    // The re-cut installs a fresh, complete snapshot: the skipped event is gone
    // with the stream that carried it.
    host.serveOpen({ sessions: [SESSION] });
    await flush();

    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(scenario.client.getSnapshot().presentation?.sessions.map((session) => session.sessionId)).toEqual(["s-1"]);
    expect(host.streamIds).toHaveLength(2);
  });

  it("keeps one re-cut in flight when the gap repeats", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;
    const streamId = host.currentStreamId;

    host.sendRaw(badEvent(host, 5, "s-a"));
    host.sendRaw(
      JSON.stringify({
        kind: "host-event",
        protocolVersion: "1",
        hostInstanceId: host.hostInstanceId,
        streamId,
        sequence: 6,
        type: "session.created",
        scope: { kind: "session", sessionId: "s-b" },
        payload: { session: sessionSnapshot({ sessionId: "s-b" }) },
      }),
    );
    await flush();

    expect(host.requests.filter((request) => request.method === "subscriptions.open")).toHaveLength(2);
    expect(scenario.client.getSnapshot().status).toBe("syncing");
  });

  it("refuses a stream id that was already retired", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;
    const firstStream = host.currentStreamId;

    const resyncing = scenario.client.resync();
    await flush();
    host.serveOpen({ sessions: [SESSION] });
    await resyncing;

    // A third cut that hands back the very stream that was retired: streams are
    // never reused, so this is not a snapshot the client may install.
    const again = scenario.client.resync();
    await flush();
    host.sendRaw(
      JSON.stringify({
        kind: "host-response",
        protocolVersion: "1",
        hostInstanceId: host.hostInstanceId,
        requestId: host.requestIdOf("subscriptions.open", 2) ?? "",
        result: {
          snapshot: {
            ...host.snapshot({ sessions: [SESSION] }),
            watermark: { streamId: firstStream, sequence: 0 },
          },
        },
      }),
    );

    await expect(again).rejects.toMatchObject({ reason: "snapshot-fence" });
    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
    expect(scenario.client.getSnapshot().error?.reason).toBe("snapshot-fence");
  });
});

describe("resync", () => {
  it("replaces the presentation whole and starts the new stream at one", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;

    const resyncing = scenario.client.resync();
    await flush();
    host.serveOpen({ sessions: [sessionSnapshot({ sessionId: "s-2" })] });
    await resyncing;

    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(scenario.client.getSnapshot().presentation?.sessions.map((session) => session.sessionId)).toEqual(["s-2"]);

    host.emit({ type: "session.created", session: sessionSnapshot({ sessionId: "s-3" }) });
    expect(scenario.client.getSnapshot().presentation?.sessions.map((session) => session.sessionId)).toEqual(["s-2", "s-3"]);
  });

  it("refuses to resync without a live connection", async () => {
    const scenario = createScenario();

    await expect(scenario.client.resync()).rejects.toMatchObject({ code: "CONNECTION_LOST" });
  });

  it("merges an explicit resync with one already in flight", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;

    const first = scenario.client.resync();
    const second = scenario.client.resync();
    await flush();

    expect(host.requests.filter((request) => request.method === "subscriptions.open")).toHaveLength(2);
    host.serveOpen({ sessions: [SESSION] });
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });
});

describe("closing a subscription", () => {
  it("invalidates the stream locally before the host is even told", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;
    const streamId = host.currentStreamId;

    const closing = scenario.client.closeSubscription();

    // Synchronous effect: the stream is gone, the presentation is stale, and the
    // client is no longer ready — the answer has not even arrived.
    expect(scenario.client.getSnapshot().status).toBe("connected");
    expect(scenario.client.getSnapshot().stale).toBe(true);
    expect(scenario.client.getSnapshot().presentation?.sessions).toHaveLength(1);

    host.respond(host.requestIdOf("subscriptions.close") ?? "", "subscriptions.close", { closed: true });
    await closing;
    expect(scenario.client.getSnapshot().status).toBe("connected");
  });

  it("ignores the frames of the stream it just ended", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;
    const streamId = host.currentStreamId;
    const frame = badEvent(host, 1, "s-late");

    const closing = scenario.client.closeSubscription();
    host.sendRaw(frame);
    host.respond(host.requestIdOf("subscriptions.close") ?? "", "subscriptions.close", { closed: true });
    await closing;

    expect(scenario.client.getSnapshot().presentation?.sessions.map((session) => session.sessionId)).toEqual(["s-1"]);
    expect(scenario.client.getSnapshot().status).toBe("connected");
    expect(streamId).toBeDefined();
  });

  it("keeps the local state when the host reports the stream was already gone", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;

    const closing = scenario.client.closeSubscription();
    host.respond(host.requestIdOf("subscriptions.close") ?? "", "subscriptions.close", { closed: false });
    await closing;

    expect(scenario.client.getSnapshot().status).toBe("connected");
    expect(scenario.client.getSnapshot().stale).toBe(true);
  });

  it("does not let a late close answer touch a stream opened afterwards", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;

    const closing = scenario.client.closeSubscription();
    const closeId = host.requestIdOf("subscriptions.close") ?? "";

    // A new subscription is opened before the host ever answers the close.
    const resyncing = scenario.client.resync();
    await flush();
    host.serveOpen({ sessions: [sessionSnapshot({ sessionId: "s-2" })] });
    await resyncing;

    host.respond(closeId, "subscriptions.close", { closed: true });
    await closing;

    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(scenario.client.getSnapshot().presentation?.sessions.map((session) => session.sessionId)).toEqual(["s-2"]);
  });

  it("refuses to close while an open is in flight", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;

    const resyncing = scenario.client.resync();
    await flush();
    const closing = scenario.client.closeSubscription();

    await expect(closing).rejects.toMatchObject({ kind: "client", reason: "sync-in-flight" });
    host.serveOpen({ sessions: [SESSION] });
    await resyncing;
  });

  it("is a no-op when nothing is subscribed", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const host = scenario.host;

    const closing = scenario.client.closeSubscription();
    host.respond(host.requestIdOf("subscriptions.close") ?? "", "subscriptions.close", { closed: true });
    await closing;

    expect(host.requests.filter((request) => request.method === "subscriptions.close")).toHaveLength(1);
  });
});

describe("control transactions are taken before anything observable", () => {
  it("a listener that sees `syncing` cannot start a second simultaneous cut", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;

    let reentered = false;
    let second: Promise<unknown> | undefined;
    scenario.client.subscribe(() => {
      if (reentered || scenario.client.getSnapshot().status !== "syncing") return;
      reentered = true;
      second = scenario.client.resync().catch((error: unknown) => error);
    });

    const first = scenario.client.resync();
    const opens = host.requests.filter((request) => request.method === "subscriptions.open").length;

    host.serveOpen({ sessions: [SESSION] });
    await first;
    await second;

    // The initial open plus exactly one new cut: the reentrant call joined it.
    expect(opens).toBe(2);
    expect(host.requests.filter((request) => request.method === "subscriptions.open")).toHaveLength(2);
  });

  it("a listener that sees `ready` starts a new cut, not a stale one", async () => {
    const scenario = createScenario({ host: { auto: false } });
    let refreshed = false;
    scenario.client.subscribe(() => {
      if (refreshed || scenario.client.getSnapshot().status !== "ready") return;
      refreshed = true;
      void scenario.client.resync().catch(() => undefined);
    });

    const connecting = scenario.client.connect();
    await flush();
    scenario.host.serveDescribe();
    await flush();
    scenario.host.serveOpen();
    await connecting;

    expect(scenario.client.getSnapshot().status).toBe("syncing");
    expect(scenario.host.requests.filter((request) => request.method === "subscriptions.open")).toHaveLength(2);
  });

  it("a gap delivered in the same batch as the snapshot still starts a new cut", async () => {
    const scenario = createScenario({ host: { auto: false } });
    const connecting = scenario.client.connect();
    await flush();
    scenario.host.serveDescribe();
    await flush();

    const host = scenario.host;
    host.serveOpen();
    host.sendRaw(
      JSON.stringify({
        kind: "host-event",
        protocolVersion: "1",
        hostInstanceId: host.hostInstanceId,
        streamId: host.currentStreamId,
        sequence: 2,
        type: "session.created",
        scope: { kind: "session", sessionId: "skipped" },
        payload: { session: sessionSnapshot({ sessionId: "skipped" }) },
      }),
    );
    await connecting;

    expect(host.requests.filter((request) => request.method === "subscriptions.open")).toHaveLength(2);
    expect(scenario.client.getSnapshot().status).toBe("syncing");
  });

  it("a listener that reacts to a caller's cut joins it instead of cutting again", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const host = scenario.host;

    let reentered = false;
    let nested: Promise<unknown> | undefined;
    scenario.client.subscribe(() => {
      if (reentered || !scenario.client.getSnapshot().stale) return;
      reentered = true;
      nested = scenario.client.resync().catch((error: unknown) => error);
    });

    await scenario.client.resync();
    await nested;

    // Dropping the old stream, publishing that it is gone and taking the new cut
    // are one transaction: the reentrant call rode along with it instead of
    // opening a third stream underneath it.
    expect(reentered).toBe(true);
    expect(host.requests.filter((request) => request.method === "subscriptions.open")).toHaveLength(2);
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });

  it("a listener that reacts to a gap-driven cut joins that cut", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;

    let reentered = false;
    let nested: Promise<unknown> | undefined;
    scenario.client.subscribe(() => {
      if (reentered || scenario.client.getSnapshot().status !== "syncing") return;
      reentered = true;
      nested = scenario.client.resync().catch((error: unknown) => error);
    });

    host.sendRaw(badEvent(host, 4, "s-skipped"));
    await flush();
    host.serveOpen({ sessions: [SESSION] });
    await nested;
    await flush();

    expect(reentered).toBe(true);
    expect(host.requests.filter((request) => request.method === "subscriptions.open")).toHaveLength(2);
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });
});

describe("losing the stream marks the presentation stale", () => {
  it("a cut never publishes a status its own stream could not back", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;
    const observed: { readonly status: string; readonly stale: boolean }[] = [];
    scenario.client.subscribe(() => {
      const snapshot = scenario.client.getSnapshot();
      observed.push({ status: snapshot.status, stale: snapshot.stale });
    });

    const resyncing = scenario.client.resync();
    await flush();
    host.serveOpen({ sessions: [SESSION] });
    await resyncing;

    // The stream is gone and the presentation is stale in the same publication:
    // a reader is never told "ready" at a moment when there is nothing to be
    // ready about, and the presentation it kept is never silently current.
    expect(observed).not.toContainEqual({ status: "ready", stale: true });
    expect(observed[0]).toEqual({ status: "syncing", stale: true });
    expect(observed[observed.length - 1]).toEqual({ status: "ready", stale: false });
  });

  it("a caller's resync marks what is retained as stale", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;

    const resyncing = scenario.client.resync();
    await flush();

    expect(scenario.client.getSnapshot().stale).toBe(true);
    expect(scenario.client.getSnapshot().presentation?.sessions).toHaveLength(1);

    host.serveOpen({ sessions: [SESSION] });
    await resyncing;

    expect(scenario.client.getSnapshot().stale).toBe(false);
  });

  it("a gap marks what is retained as stale", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;

    host.sendRaw(
      JSON.stringify({
        kind: "host-event",
        protocolVersion: "1",
        hostInstanceId: host.hostInstanceId,
        streamId: host.currentStreamId,
        sequence: 5,
        type: "session.created",
        scope: { kind: "session", sessionId: "skipped" },
        payload: { session: sessionSnapshot({ sessionId: "skipped" }) },
      }),
    );

    expect(scenario.client.getSnapshot().stale).toBe(true);
    expect(scenario.client.getSnapshot().presentation?.sessions).toHaveLength(1);
  });

  it("an open that fails leaves the retained presentation stale", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;

    const resyncing = scenario.client.resync().catch((error: unknown) => error);
    await flush();
    host.respondError(host.requestIdOf("subscriptions.open", 1) ?? "", "INTERNAL_ERROR");
    await resyncing;

    expect(scenario.client.getSnapshot().stale).toBe(true);
    expect(scenario.client.getSnapshot().status).toBe("connected");
  });
});

describe("which non-current streams are noise and which are a fence", () => {
  function eventFrame(host: { readonly hostInstanceId: string }, streamId: string): string {
    return JSON.stringify({
      kind: "host-event",
      protocolVersion: "1",
      hostInstanceId: host.hostInstanceId,
      streamId,
      sequence: 1,
      type: "session.created",
      scope: { kind: "session", sessionId: "late" },
      payload: { session: sessionSnapshot({ sessionId: "late" }) },
    });
  }

  function requestFrame(host: { readonly hostInstanceId: string }, streamId: string): string {
    return JSON.stringify({
      kind: "host-request",
      protocolVersion: "1",
      hostInstanceId: host.hostInstanceId,
      streamId,
      requestId: "late-request",
      method: "test.echo",
      params: {},
      timeoutMs: 1000,
    });
  }

  const factories = { event: eventFrame, request: requestFrame } as const;

  for (const kind of ["event", "request"] as const) {
    it(`discards a never-installed ${kind} after an explicit close`, async () => {
      const scenario = createScenario();
      await scenario.ready();
      const host = scenario.host;

      const closing = scenario.client.closeSubscription();
      host.respond(host.requestIdOf("subscriptions.close") ?? "", "subscriptions.close", { closed: true });
      await closing;

      const before = scenario.client.getSnapshot();
      host.sendRaw(factories[kind](host, "never-installed"));

      expect(scenario.client.getSnapshot()).toBe(before);
      expect(host.isClosed).toBe(false);
    });

    it(`still discards a retired ${kind} long after that stream was ended`, async () => {
      const scenario = createScenario({ host: { auto: false } });
      await openWith(scenario, { sessions: [SESSION] });
      const host = scenario.host;
      const firstStream = host.currentStreamId ?? "";

      // More cuts than the old eight-entry window ever held.
      for (let index = 0; index < 10; index += 1) {
        const resyncing = scenario.client.resync();
        await flush();
        host.serveOpen({ sessions: [SESSION] });
        await resyncing;
      }

      const resyncing = scenario.client.resync();
      await flush();
      const before = scenario.client.getSnapshot();
      host.sendRaw(factories[kind](host, firstStream));

      expect(scenario.client.getSnapshot()).toBe(before);
      expect(scenario.client.getSnapshot().status).toBe("syncing");
      host.serveOpen({ sessions: [SESSION] });
      await resyncing;
    });
  }

  it("a spent retirement budget is a debt of that connection, not of the next one", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const host = scenario.host;
    const lastStream = host.currentStreamId ?? "";

    // Retiring streams within one connection is bounded, and the bound is real:
    // a connection that can no longer prove which streams it has ended says so
    // instead of forgetting one.
    for (let index = 0; index < 256; index += 1) await scenario.client.resync();
    await expect(scenario.client.resync()).rejects.toMatchObject({ code: "CONNECTION_LOST" });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
    expect(scenario.client.getSnapshot().error?.reason).toBe("stream-identity-budget");
    expect(host.isClosed).toBe(true);

    // A new connection remembers its own streams: what the ended generation
    // retired cannot be a debt the next one has to pay.
    await scenario.client.reconnect();
    await expect(scenario.client.resync()).resolves.toBeUndefined();
    expect(scenario.client.getSnapshot().status).toBe("ready");

    // What the ledger exists for is untouched: a stream this client has moved on
    // from is still dropped, not applied to a presentation that moved with it.
    const before = scenario.client.getSnapshot();
    scenario.host.sendRaw(
      JSON.stringify({
        kind: "host-event",
        protocolVersion: "1",
        hostInstanceId: scenario.host.hostInstanceId,
        streamId: lastStream,
        sequence: 1,
        type: "session.created",
        scope: { kind: "session", sessionId: "late" },
        payload: { session: sessionSnapshot({ sessionId: "late" }) },
      }),
    );

    expect(scenario.client.getSnapshot()).toBe(before);
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });
});

describe("a gap never reaches the presentation, not even for a moment", () => {
  it("keeps the skipped payload out of every observation", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;
    const observed: string[] = [];
    const watermarks: number[] = [];
    scenario.client.subscribe(() => {
      const snapshot = scenario.client.getSnapshot();
      observed.push(JSON.stringify(snapshot.presentation?.sessions.map((session) => session.sessionId) ?? []));
      watermarks.push(snapshot.presentation?.watermark.sequence ?? -1);
    });

    host.sendRaw(
      JSON.stringify({
        kind: "host-event",
        protocolVersion: "1",
        hostInstanceId: host.hostInstanceId,
        streamId: host.currentStreamId,
        sequence: 4,
        type: "session.created",
        scope: { kind: "session", sessionId: "gap-payload" },
        payload: { session: sessionSnapshot({ sessionId: "gap-payload" }) },
      }),
    );

    // The event that revealed the gap is never applied — not transiently either.
    expect(observed.some((state) => state.includes("gap-payload"))).toBe(false);
    expect(observed.some((state) => state.includes("s-1"))).toBe(true);
    expect(watermarks.every((sequence) => sequence === 0)).toBe(true);
    expect(scenario.client.getSnapshot().status).toBe("syncing");
  });
});
