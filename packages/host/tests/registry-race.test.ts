import { describe, expect, it } from "vitest";

import {
  awaitRunTerminal,
  connect,
  constantTool,
  createSessionThrough,
  flush,
  gate,
  gatedReply,
  gatedTool,
  nextId,
  scriptedModel,
  testHost,
  testPlugin,
  textReply,
  toolReply,
} from "./helpers/harness.js";

/** A plugin whose activation only finishes when the test says so. */
function slowPlugin(id: string, activation: Promise<void>, cleanup?: Promise<void>) {
  return testPlugin({
    id,
    tools: [constantTool(`${id}-tool`, "ok")],
    activate: async (context) => {
      if (cleanup !== undefined) context.onDispose(() => cleanup);
      await activation;
    },
  });
}

describe("run versus plugin lifecycle", () => {
  it("gives the registry to whoever asks first, and answers the other HOST_BUSY", async () => {
    const hold = gate();
    const host = await testHost({
      modelClient: scriptedModel([gatedReply(hold)]).client,
      plugins: [testPlugin({ id: "alpha", tools: [constantTool("alpha-tool")] })],
    });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "occupy the registry",
    });
    expect(started.result?.run.status).toBe("accepted");

    // Accepted already owns the registry — before the first model call.
    expect((await client.call("plugins.enable", { pluginId: "alpha" })).error?.code).toBe("HOST_BUSY");
    expect((await client.call("plugins.disable", { pluginId: "alpha" })).error?.code).toBe("HOST_BUSY");

    hold.open();
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
    expect(terminal.status).toBe("completed");
  });

  it("refuses a run while a plugin lifecycle operation is in flight", async () => {
    const activation = gate();
    const host = await testHost({
      modelClient: scriptedModel([textReply("hi")]).client,
      plugins: [slowPlugin("alpha", activation.promise)],
    });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const enabling = client.call("plugins.enable", { pluginId: "alpha" });
    await flush();

    // An activation that has not finished is visible as one, and it is not
    // invented: the manager reports `enabling` while its promise is pending.
    const during = (await client.call("plugins.list", {})).result?.plugins[0];
    expect(during?.status).toBe("enabling");

    const refused = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "too early",
    });
    expect(refused.error?.code).toBe("HOST_BUSY");

    activation.open();
    expect((await enabling).result?.plugin.status).toBe("enabled");

    const accepted = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "now it fits",
    });
    expect(accepted.result?.run.status).toBe("accepted");
  });

  it("refuses a run while a cleanup is still running", async () => {
    const cleanup = gate();
    const host = await testHost({
      modelClient: scriptedModel([textReply("hi")]).client,
      plugins: [slowPlugin("alpha", Promise.resolve(), cleanup.promise)],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "alpha" });
    const session = await createSessionThrough(client);

    const disabling = client.call("plugins.disable", { pluginId: "alpha" });
    await flush();

    expect((await client.call("plugins.list", {})).result?.plugins[0]?.status).toBe("disabling");

    const refused = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "not yet",
    });
    expect(refused.error?.code).toBe("HOST_BUSY");

    cleanup.open();
    await disabling;

    const accepted = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "now",
    });
    expect(accepted.result?.run.status).toBe("accepted");
  });

  it("refuses a second plugin mutation while one is in flight", async () => {
    const activation = gate();
    const host = await testHost({
      modelClient: scriptedModel([textReply("hi")]).client,
      plugins: [slowPlugin("alpha", activation.promise), testPlugin({ id: "beta", tools: [] })],
    });
    const client = connect(host);
    await client.describe();

    const enabling = client.call("plugins.enable", { pluginId: "alpha" });
    await flush();

    expect((await client.call("plugins.enable", { pluginId: "beta" })).error?.code).toBe("HOST_BUSY");
    expect((await client.call("plugins.disable", { pluginId: "beta" })).error?.code).toBe("HOST_BUSY");

    activation.open();
    await enabling;

    // A no-op still has to take the registry, and it is free now.
    expect((await client.call("plugins.disable", { pluginId: "beta" })).result?.plugin.status).toBe(
      "disabled",
    );
  });

  it("applies the busy policy to a plugin request that would be a no-op", async () => {
    const hold = gate();
    const host = await testHost({
      modelClient: scriptedModel([gatedReply(hold)]).client,
      plugins: [testPlugin({ id: "alpha", tools: [] })],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "alpha" });
    const session = await createSessionThrough(client);

    const occupying = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "busy",
    });
    const runId = occupying.result?.run.runId as string;

    // Already enabled, but the host is occupied: the manager's own no-op rule
    // is applied once the host is idle, not before.
    expect((await client.call("plugins.enable", { pluginId: "alpha" })).error?.code).toBe("HOST_BUSY");

    hold.open();
    await awaitRunTerminal(client, runId);
    expect((await client.call("plugins.enable", { pluginId: "alpha" })).result?.plugin.status).toBe("enabled");
  });

  it("releases the registry only once the aborted run has settled", async () => {
    const started = gate();
    const release = gate();
    const host = await testHost({
      modelClient: scriptedModel([toolReply("call-1", "slow", {})]).client,
      plugins: [testPlugin({ id: "alpha", tools: [gatedTool("slow", release, started)] })],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "alpha" });
    const session = await createSessionThrough(client);

    const response = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "slow",
    });
    const runId = response.result?.run.runId as string;
    await started.promise;

    await client.call("runs.cancel", { runId });
    await flush();
    expect((await client.call("plugins.disable", { pluginId: "alpha" })).error?.code).toBe("HOST_BUSY");

    release.open();
    const terminal = await awaitRunTerminal(client, runId);
    expect(terminal.status).toBe("cancelled");

    expect((await client.call("plugins.disable", { pluginId: "alpha" })).result?.plugin.status).toBe(
      "disabled",
    );
  });

  it("never blocks reads, cancellation or subscription traffic behind the gate", async () => {
    const hold = gate();
    const host = await testHost({
      modelClient: scriptedModel([gatedReply(hold)]).client,
      plugins: [testPlugin({ id: "alpha", tools: [] })],
    });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "occupying",
    });
    const runId = started.result?.run.runId as string;

    expect((await client.call("sessions.list", {})).result?.sessions.items).toHaveLength(1);
    expect((await client.call("sessions.get", { sessionId: session.sessionId })).result?.session.sessionId).toBe(
      session.sessionId,
    );
    expect((await client.call("plugins.list", {})).result?.plugins).toHaveLength(1);
    expect((await client.call("runs.get", { runId })).result?.run.runId).toBe(runId);
    expect((await client.call("subscriptions.open", {})).result?.snapshot.sessions.items).toHaveLength(1);
    expect((await client.call("subscriptions.close", { streamId: "unused-stream" })).result?.closed).toBe(false);
    expect((await client.call("runs.cancel", { runId })).result?.run.cancelRequested).toBe(true);

    // Creating an empty session changes no registry and waits for nothing.
    const created = await client.call("sessions.create", {});
    expect(created.result?.session.status).toBe("ready");

    hold.open();
    await flush();
  });
});
