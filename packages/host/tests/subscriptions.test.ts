import { describe, expect, it } from "vitest";

import type { HostEvent } from "@every-dagent/protocol";

import {
  awaitRunTerminal,
  connect,
  createSessionThrough,
  flush,
  gate,
  gatedReply,
  scriptedModel,
  testHost,
  textReply,
} from "./helpers/harness.js";

function streamOf(event: HostEvent): string {
  return (event as unknown as { streamId: string }).streamId;
}

describe("subscriptions", () => {
  it("opens with a fresh stream and a zero watermark", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    const opened = await client.call("subscriptions.open", {});
    const snapshot = opened.result?.snapshot;

    expect(snapshot?.watermark.sequence).toBe(0);
    expect(typeof snapshot?.watermark.streamId).toBe("string");
    expect(snapshot?.hostInstanceId).toBeDefined();
    expect(snapshot?.sessions).toEqual([]);
    expect(snapshot?.runs).toEqual([]);
    expect(snapshot?.plugins).toEqual([]);
  });

  it("numbers events from one, per stream, without gaps", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();
    const opened = await client.call("subscriptions.open", {});
    const streamId = opened.result?.snapshot.watermark.streamId;

    await createSessionThrough(client);
    await createSessionThrough(client);
    await flush();

    expect(client.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(client.events.every((event) => streamOf(event) === streamId)).toBe(true);
  });

  it("delivers the snapshot response before any event of that stream", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    const opened = await client.call("subscriptions.open", {});
    const responseFrameIndex = client.frames.findIndex((frame) => frame.includes('"host-response"'));
    await createSessionThrough(client);
    await flush();

    const firstEventFrameIndex = client.frames.findIndex((frame) => frame.includes('"host-event"'));
    expect(responseFrameIndex).toBeGreaterThanOrEqual(0);
    expect(firstEventFrameIndex).toBeGreaterThan(responseFrameIndex);
    expect(opened.result?.snapshot.watermark.sequence).toBe(0);
  });

  it("captures the state as one cut, with later changes arriving as events", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();
    const before = await createSessionThrough(client);

    const opened = await client.call("subscriptions.open", {});
    await createSessionThrough(client);
    await flush();

    // The snapshot is what the host held at the cut, not what it holds now.
    expect(opened.result?.snapshot.sessions.map((session) => session.sessionId)).toEqual([before.sessionId]);
    expect(client.events.map((event) => event.type)).toEqual(["session.created"]);
  });

  it("replaces the old stream on a second open, and never reuses a stream id", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    const first = await client.call("subscriptions.open", {});
    const firstStream = first.result?.snapshot.watermark.streamId;
    const second = await client.call("subscriptions.open", {});
    const secondStream = second.result?.snapshot.watermark.streamId;

    expect(secondStream).not.toBe(firstStream);

    await createSessionThrough(client);
    await flush();

    // Only the new stream is live: exactly one event, on it, numbered from one.
    expect(client.events).toHaveLength(1);
    expect(streamOf(client.events[0] as HostEvent)).toBe(secondStream);
    expect(client.events[0]?.sequence).toBe(1);
  });

  it("closes the stream it was asked about and leaves others alone", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();
    const opened = await client.call("subscriptions.open", {});
    const streamId = opened.result?.snapshot.watermark.streamId as string;

    // A stale id — and an unknown one — do not close the live stream.
    expect((await client.call("subscriptions.close", { streamId: "some-old-stream" })).result?.closed).toBe(false);
    expect((await client.call("subscriptions.close", { streamId })).result?.closed).toBe(true);

    await createSessionThrough(client);
    await flush();

    // Closed means closed: nothing is delivered any more, and the directory
    // still shows the creation.
    expect(client.events).toHaveLength(0);
    expect((await client.call("sessions.list", {})).result?.sessions).toHaveLength(1);
  });

  it("keeps a run draining with no subscriber at all", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("finished alone")]).client });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "sub-no-subscriber",
      text: "nobody is watching",
    });
    const runId = started.result?.run.runId as string;

    const terminal = await awaitRunTerminal(client, runId);

    expect(terminal.status).toBe("completed");
    // No subscription was ever opened on this connection.
    expect(client.events).toHaveLength(0);
  });

  it("keeps running when the transport refuses to deliver", async () => {
    const hold = gate();
    const host = testHost({ modelClient: scriptedModel([gatedReply(hold)]).client });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "sub-dead-channel",
      text: "keep going",
    });
    const runId = started.result?.run.runId as string;

    // The reader disappears: the host's next delivery fails at the transport.
    client.channel.close();
    hold.open();
    await flush();
    await flush();

    // The work is untouched by the loss of its reader.
    const other = connect(host);
    await other.describe();
    const terminal = await awaitRunTerminal(other, runId);
    expect(terminal.status).toBe("completed");
  });
});

describe("subscription cut under a racing mutation", () => {
  it("answers the open before the new stream's first event, even when a mutation is in flight", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    // Both frames are in flight before either is answered: the mutation is
    // dispatched immediately after the open, with no await in between.
    const openRequestId = "open-race";
    const opened = client.call("subscriptions.open", {}, { requestId: openRequestId });
    const created = client.call("sessions.create", {});
    const [openResponse, createResponse] = await Promise.all([opened, created]);

    const streamId = openResponse.result?.snapshot.watermark.streamId as string;
    const sessionId = createResponse.result?.session.sessionId as string;

    // The snapshot is the cut taken before the mutation, and the mutation
    // arrives as the new stream's first event: nothing falls between them.
    expect(openResponse.result?.snapshot.sessions).toEqual([]);
    expect(createResponse.result?.session.sessionId).toBe(sessionId);

    const first = client.events[0];
    expect(first?.type).toBe("session.created");
    expect(first?.sequence).toBe(1);
    expect(streamOf(first as HostEvent)).toBe(streamId);

    // The response frame — found by its own requestId, never by shape alone —
    // is written before that event leaves the connection.
    const frames = client.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    const responseIndex = frames.findIndex(
      (frame) => frame["kind"] === "host-response" && frame["requestId"] === openRequestId,
    );
    const eventIndex = frames.findIndex(
      (frame) => frame["kind"] === "host-event" && frame["streamId"] === streamId,
    );

    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(eventIndex).toBeGreaterThan(responseIndex);
    expect(frames[eventIndex]?.["sequence"]).toBe(1);
  });
});
