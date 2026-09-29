import { describe, expect, it } from "vitest";

import { encodeFrame } from "@every-dagent/protocol";

import {
  connect,
  createSessionThrough,
  flush,
  gate,
  gatedReply,
  scriptedModel,
  testHost,
  textReply,
} from "./helpers/harness.js";

describe("connection initialization", () => {
  it("refuses a business method on a connection that never described", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });

    const described = connect(host);
    const description = await described.describe();
    const instanceId = description.result?.hostInstanceId as string;

    // A second connection that knows the instance id but skipped describe is
    // still not initialized.
    const fresh = connect(host);
    const response = await fresh.call(
      "sessions.list",
      {},
      { hostInstanceId: instanceId },
    );

    expect(response.error?.code).toBe("NOT_INITIALIZED");
  });

  it("refuses a request that names another host instance", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    const response = await client.call("sessions.list", {}, { hostInstanceId: "a-different-instance" });

    expect(response.error?.code).toBe("HOST_INSTANCE_MISMATCH");
  });

  it("refuses a connection that changes its mind about capabilities", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    const first = await client.describe();
    expect(first.result?.clientCapabilities.reverseRequests).toBe(false);

    const changed = await client.call("host.describe", {
      supportedProtocolVersions: ["1"],
      client: { name: "test-client", version: "0.1.0" },
      capabilities: { reverseRequests: true },
    });

    expect(changed.error?.code).toBe("INVALID_REQUEST");
  });
});

describe("frame-level faults", () => {
  it("closes the connection on a frame it cannot parse at all", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    const before = client.frames.length;
    client.sendRaw("{not json");
    await flush();

    // Nothing could be correlated, so nothing was answered.
    expect(client.isClosed).toBe(true);
    expect(client.frames.length).toBe(before);
  });

  it("closes the connection when a request id is reused", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    const requestId = "reused-id";
    expect((await client.call("sessions.list", {}, { requestId })).result).toBeDefined();
    const before = client.frames.length;

    // The duplicate is never dispatched, and the connection is over: a second
    // meaning for one id could not be answered honestly.
    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "1",
        requestId,
        method: "sessions.list",
        params: {},
        hostInstanceId: client.hostInstanceId,
      }),
    );
    await flush();

    expect(client.isClosed).toBe(true);
    expect(client.frames.length).toBe(before);
  });

  it("closes the connection on a frame that claims the host's own direction", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    const encoded = encodeFrame(
      { kind: "host-event" },
      {
        kind: "host-event",
        protocolVersion: "1",
        hostInstanceId: "whatever",
        streamId: "whatever",
        sequence: 1,
        scope: { kind: "host" },
        type: "host.request.cancelled",
        payload: { requestId: "r-1", reason: "cancelled" },
      },
    );
    if (!encoded.success) throw new Error("the fixture could not build the frame");
    client.sendRaw(encoded.output);
    await flush();

    expect(client.isClosed).toBe(true);
  });

  it("answers an unknown method with METHOD_NOT_FOUND and keeps the connection", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    const description = await client.describe();
    const instanceId = description.result?.hostInstanceId as string;

    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "1",
        requestId: "unknown-method",
        method: "tools.execute",
        params: {},
        hostInstanceId: instanceId,
      }),
    );
    await flush();

    expect(client.isClosed).toBe(false);
    const response = client.frames.at(-1) ?? "";
    expect(response).toContain("METHOD_NOT_FOUND");
    expect(
      (await client.call("sessions.list", {}, { requestId: "still-alive" })).result?.sessions,
    ).toEqual([]);
  });

  it("answers invalid params with INVALID_REQUEST and keeps the connection", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    const description = await client.describe();
    const instanceId = description.result?.hostInstanceId as string;

    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "1",
        requestId: "bad-params",
        method: "runs.start",
        params: { sessionId: "s", submissionId: "sub", text: "   " },
        hostInstanceId: instanceId,
      }),
    );
    await flush();

    expect(client.isClosed).toBe(false);
    expect(client.frames.at(-1) ?? "").toContain("INVALID_REQUEST");
  });

  it("refuses a generation it does not speak without executing anything", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "2",
        requestId: "future-request",
        method: "sessions.list",
        params: {},
        hostInstanceId: "irrelevant",
      }),
    );
    await flush();

    expect(client.frames.at(-1) ?? "").toContain("UNSUPPORTED_PROTOCOL");
    expect(client.isClosed).toBe(false);
  });

  it("drops an unassociated client response without answering it", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();
    const before = client.frames.length;

    client.sendRaw(
      JSON.stringify({
        kind: "client-response",
        protocolVersion: "1",
        hostInstanceId: "irrelevant",
        streamId: "stream",
        requestId: "never-asked",
        result: { ok: true },
      }),
    );
    await flush();

    // v1 has no production reverse request: the response is read, validated and
    // dropped, and nothing is sent back for it.
    expect(client.isClosed).toBe(false);
    expect(client.frames.length).toBe(before);
  });

  it("closes a connection that outruns its own queue while the host keeps working", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });

    const burst = connect(host);
    await burst.describe();
    const instanceId = burst.hostInstanceId as string;

    const observer = connect(host);
    await observer.describe();

    // A pipelined burst: hundreds of write frames are dispatched before the
    // microtask that drains this connection's outbox can run.
    for (let index = 0; index < 400; index++) {
      burst.sendRaw(
        JSON.stringify({
          kind: "client-request",
          protocolVersion: "1",
          requestId: `burst-${index}`,
          method: "sessions.create",
          params: {},
          hostInstanceId: instanceId,
        }),
      );
    }
    await flush();

    // The reader that cannot keep up is closed; the work it caused stands.
    expect(burst.isClosed).toBe(true);
    expect((await observer.call("sessions.list", {})).result?.sessions.length).toBeGreaterThan(0);
  });
});

describe("run versus reader loss", () => {
  it("keeps a run alive while a subscription is replaced underneath it", async () => {
    const hold = gate();
    const host = testHost({ modelClient: scriptedModel([gatedReply(hold)]).client });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "sub-replaced",
      text: "survive the resync",
    });
    const runId = started.result?.run.runId as string;

    const replaced = await client.call("subscriptions.open", {});
    expect(replaced.result?.snapshot.runs.map((run) => run.runId)).toEqual([runId]);
    // The live prefix is part of the snapshot, so a reconnect does not need a
    // replay of the events it missed.
    expect(replaced.result?.snapshot.runs[0]?.live).not.toBeNull();

    hold.open();
    await client.waitForEvent("run.ended", (event) => event.payload.run.runId === runId);
    await flush();
  });
});

describe("request id identity", () => {
  it("consumes the id of a request the envelope layer could not read", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();
    const instanceId = client.hostInstanceId as string;

    // Readable enough to correlate — kind and requestId are well-formed — and
    // broken below that: no params at all. The answer spends the id.
    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "1",
        requestId: "spent-invalid-id",
        method: "sessions.list",
        hostInstanceId: instanceId,
      }),
    );
    await flush();
    expect(client.frames.at(-1) ?? "").toContain("INVALID_REQUEST");
    expect(client.isClosed).toBe(false);

    const before = client.frames.length;
    // The same id again, this time well-formed: a protocol fault, not a request.
    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "1",
        requestId: "spent-invalid-id",
        method: "sessions.list",
        params: {},
        hostInstanceId: instanceId,
      }),
    );
    await flush();

    expect(client.isClosed).toBe(true);
    expect(client.frames.length).toBe(before);
  });

  it("consumes the id of a request that failed the method schema", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();
    const instanceId = client.hostInstanceId as string;

    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "1",
        requestId: "spent-params-id",
        method: "runs.start",
        params: { sessionId: "s", submissionId: "sub", text: "   " },
        hostInstanceId: instanceId,
      }),
    );
    await flush();
    expect(client.frames.at(-1) ?? "").toContain("INVALID_REQUEST");
    expect(client.isClosed).toBe(false);

    const before = client.frames.length;
    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "1",
        requestId: "spent-params-id",
        method: "sessions.list",
        params: {},
        hostInstanceId: instanceId,
      }),
    );
    await flush();

    expect(client.isClosed).toBe(true);
    expect(client.frames.length).toBe(before);
  });

  it("closes when a valid request is followed by an unreadable one with its id", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();
    const instanceId = client.hostInstanceId as string;

    expect((await client.call("sessions.list", {}, { requestId: "used-id" })).result).toBeDefined();
    const before = client.frames.length;

    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "1",
        requestId: "used-id",
        method: "sessions.list",
        hostInstanceId: instanceId,
      }),
    );
    await flush();

    expect(client.isClosed).toBe(true);
    expect(client.frames.length).toBe(before);
  });

  it("closes a valid request that follows an unreadable one with its id", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();
    const instanceId = client.hostInstanceId as string;

    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "1",
        requestId: "used-invalid-id",
        method: "sessions.list",
        hostInstanceId: instanceId,
      }),
    );
    await flush();
    const before = client.frames.length;

    // A well-formed request reusing the spent id: never dispatched, never
    // answered, and the connection does not survive the attempt.
    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "1",
        requestId: "used-invalid-id",
        method: "sessions.list",
        params: {},
        hostInstanceId: instanceId,
      }),
    );
    await flush();

    expect(client.isClosed).toBe(true);
    expect(client.frames.length).toBe(before);
  });

  it("still closes a frame whose correlation cannot be recovered at all", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    const before = client.frames.length;
    // No requestId to read: nothing can be answered, and nothing is consumed.
    client.sendRaw(JSON.stringify({ kind: "client-request", protocolVersion: "1", method: "sessions.list" }));
    await flush();

    expect(client.isClosed).toBe(true);
    expect(client.frames.length).toBe(before);
  });
});
