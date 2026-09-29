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
