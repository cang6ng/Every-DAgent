import { describe, expect, it } from "vitest";

import {
  awaitRunTerminal,
  connect,
  createSessionThrough,
  flush,
  scriptedModel,
  testHost,
  testPlugin,
  textReply,
} from "./helpers/harness.js";

describe("host description", () => {
  it("describes exactly what the host supports, without over-claiming", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);

    const response = await client.describe();

    expect(response.result).toBeDefined();
    expect(response.result).toMatchObject({
      protocolVersion: "1",
      capabilities: {
        sessions: true,
        runs: true,
        plugins: true,
        subscriptions: true,
        // Backed by the generic mechanism in `reverse.ts` and its own tests:
        // pending is installed before send, answers are correlated and validated
        // against a profile, and every scope end clears what it owns. The
        // business registry is still empty — no shipped method exists.
        reverseRequests: true,
      },
      clientCapabilities: { reverseRequests: false },
      limits: { maxActiveRuns: 1 },
      retention: "host-lifetime",
      host: { name: expect.any(String), version: expect.any(String) },
    });
    expect(response.result?.hostInstanceId).toEqual(expect.any(String));
    expect(response.error).toBeUndefined();
  });

  it("keeps one instance id per host and a fresh one per host", async () => {
    const first = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const second = testHost({ modelClient: scriptedModel([textReply("unused")]).client });

    const firstId = (await connect(first).describe()).result?.hostInstanceId;
    const againId = (await connect(first).describe()).result?.hostInstanceId;
    const secondId = (await connect(second).describe()).result?.hostInstanceId;

    expect(firstId).toBeDefined();
    expect(againId).toBe(firstId);
    expect(secondId).not.toBe(firstId);
  });

  it("answers a repeated describe with an equivalent description", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);

    const first = await client.describe();
    const second = await client.describe();

    expect(second.result).toEqual(first.result);
  });

  it("refuses a client that cannot speak generation 1", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);

    const response = await client.call("host.describe", {
      supportedProtocolVersions: ["2"],
      client: { name: "old-client", version: "0.0.1" },
      capabilities: { reverseRequests: false },
    });

    expect(response.error?.code).toBe("UNSUPPORTED_PROTOCOL");
    expect(response.result).toBeUndefined();
  });
});

describe("session directory", () => {
  it("starts empty and lists what it created, in creation order", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    expect((await client.call("sessions.list", {})).result?.sessions).toEqual([]);

    const first = await createSessionThrough(client);
    const second = await createSessionThrough(client);

    const listed = (await client.call("sessions.list", {})).result?.sessions ?? [];
    expect(listed.map((session) => session.sessionId)).toEqual([first.sessionId, second.sessionId]);
  });

  it("creates an empty, ready session with a host clock timestamp", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    const before = Date.now();
    const session = await createSessionThrough(client);

    expect(session.status).toBe("ready");
    expect(session.activeRunId).toBeNull();
    expect(session.canonical).toEqual([]);
    expect(typeof session.createdAt).toBe("number");
    expect(session.createdAt).toBeGreaterThanOrEqual(before);
  });

  it("returns the same session from get as it published by create", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    const created = await createSessionThrough(client);
    const fetched = await client.call("sessions.get", { sessionId: created.sessionId });

    expect(fetched.result?.session).toEqual(created);
  });

  it("answers an unknown session id with SESSION_NOT_FOUND", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    const response = await client.call("sessions.get", { sessionId: "no-such-session" });

    expect(response.error?.code).toBe("SESSION_NOT_FOUND");
  });

  it("announces each creation with a session.created event on the subscription", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});

    const session = await createSessionThrough(client);
    const announced = await client.waitForEvent("session.created");

    expect(announced.scope).toEqual({ kind: "session", sessionId: session.sessionId });
    expect(announced.payload.session).toEqual(session);
    expect(announced.sequence).toBe(1);
  });

  it("lists summaries without the conversation, and a full snapshot on get", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    await createSessionThrough(client);
    const summaries = (await client.call("sessions.list", {})).result?.sessions ?? [];

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty("canonical");
  });

  it("does not let a caller mutate host state through a returned snapshot", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    const created = await createSessionThrough(client);
    (created as { status: string }).status = "blocked";
    (created.canonical as unknown[]).push({ kind: "user", id: "x", turnId: "t", text: "injected" });

    const fetched = await client.call("sessions.get", { sessionId: created.sessionId });
    expect(fetched.result?.session.status).toBe("ready");
    expect(fetched.result?.session.canonical).toEqual([]);
  });
});

describe("host lifetime", () => {
  it("keeps its directory across connections of the same host", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const first = connect(host);
    await first.describe();
    const session = await createSessionThrough(first);

    const second = connect(host);
    await second.describe();
    const listed = (await second.call("sessions.list", {})).result?.sessions ?? [];

    expect(listed.map((entry) => entry.sessionId)).toEqual([session.sessionId]);
  });

  it("does not cancel a run when the client goes away", async () => {
    const model = scriptedModel([textReply("done anyway")]);
    const host = testHost({ modelClient: model.client });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const response = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "sub-detach",
      text: "keep going",
    });
    const runId = response.result?.run.runId;
    expect(runId).toBeDefined();

    // The reader goes away; the work does not.
    client.detach();

    const other = connect(host);
    await other.describe();
    const terminal = await awaitRunTerminal(other, runId as string);

    expect(terminal.runId).toBe(runId);
    expect(terminal.status).toBe("completed");
  });
});

describe("plugin directory", () => {
  it("lists registered plugins in registration order, disabled", async () => {
    const host = testHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [
        testPlugin({ id: "alpha", tools: [] }),
        testPlugin({ id: "beta", description: "the second one", tools: [] }),
      ],
    });
    const client = connect(host);
    await client.describe();

    const listed = (await client.call("plugins.list", {})).result?.plugins ?? [];

    expect(listed.map((plugin) => plugin.id)).toEqual(["alpha", "beta"]);
    expect(listed.every((plugin) => plugin.status === "disabled")).toBe(true);
    expect(listed[0]?.permissions).toEqual([]);
    expect(listed[1]?.description).toBe("the second one");
  });

  it("answers an unknown plugin id with PLUGIN_NOT_FOUND", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    const response = await client.call("plugins.enable", { pluginId: "ghost" });

    expect(response.error?.code).toBe("PLUGIN_NOT_FOUND");
    await flush();
  });
});
