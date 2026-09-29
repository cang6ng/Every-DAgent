import { describe, expect, it } from "vitest";

import type { ModelEvent } from "@every-dagent/agent-core";

import {
  awaitRunTerminal,
  connect,
  constantTool,
  createSessionThrough,
  failingPlugin,
  flush,
  gate,
  gatedReply,
  gatedTool,
  nextId,
  recordingTool,
  scriptedModel,
  testHost,
  testPlugin,
  textReply,
  toolReply,
} from "./helpers/harness.js";

/** A model step whose text is not a string — a value the wire cannot carry. */
function brokenTextReply(): readonly ModelEvent[] {
  return [
    { type: "text-delta", text: { not: "a string" } as unknown as string },
    { type: "done" },
  ];
}

describe("display input", () => {
  it("reports a non-JSON tool input as unavailable, and leaves the real call untouched", async () => {
    const seen: unknown[] = [];
    const input = { bad: undefined };
    const host = testHost({
      modelClient: scriptedModel([toolReply("call-1", "observer", input), textReply("done")]).client,
      plugins: [testPlugin({ id: "tools", tools: [recordingTool("observer", seen)] })],
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const terminal = await awaitRunTerminal(
      client,
      (await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: nextId("sub"),
        text: "look at this",
      })).result?.run.runId as string,
    );

    expect(terminal.status).toBe("completed");
    // The tool ran once, with the object the model produced, by reference.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(input);

    const call = client.events.find((event) => event.type === "run.tool.call");
    expect(call?.payload.item.input).toEqual({ kind: "unavailable", reason: "not-json-safe" });

    const canonical = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session.canonical;
    const projected = canonical?.find((item) => item.kind === "tool-call");
    expect(projected).toMatchObject({ input: { kind: "unavailable", reason: "not-json-safe" } });
  });

  it.each([
    ["undefined value", { a: undefined }],
    ["bigint", { a: 1n }],
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["negative zero", { a: -0 }],
    ["function", { a: () => undefined }],
    ["sparse array", [1, , 3]],
    ["Date instance", { when: new Date(0) }],
    ["Map", { lookup: new Map([["a", 1]]) }],
    ["class instance", { thing: new (class Thing {})() }],
  ])("shows %s as unavailable without failing the run", async (_name, input) => {
    const seen: unknown[] = [];
    const host = testHost({
      modelClient: scriptedModel([toolReply("call-1", "observer", input), textReply("still fine")]).client,
      plugins: [testPlugin({ id: "tools", tools: [recordingTool("observer", seen)] })],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const terminal = await awaitRunTerminal(
      client,
      (await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: nextId("sub"),
        text: "type check",
      })).result?.run.runId as string,
    );

    expect(terminal.status).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(input);

    const canonical = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session.canonical;
    expect(canonical?.find((item) => item.kind === "tool-call")?.input).toEqual({
      kind: "unavailable",
      reason: "not-json-safe",
    });
  });

  it("does not read an input through an accessor when projecting it", async () => {
    const seen: unknown[] = [];
    let reads = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "trap", {
      enumerable: true,
      get() {
        reads += 1;
        return "gotcha";
      },
    });

    const host = testHost({
      modelClient: scriptedModel([toolReply("call-1", "observer", input), textReply("done")]).client,
      plugins: [testPlugin({ id: "tools", tools: [recordingTool("observer", seen)] })],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const terminal = await awaitRunTerminal(
      client,
      (await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: nextId("sub"),
        text: "accessor",
      })).result?.run.runId as string,
    );

    expect(terminal.status).toBe("completed");
    // Projection never invoked the getter; the real tool got the object itself.
    expect(reads).toBe(0);
    expect(seen[0]).toBe(input);
  });

  it("keeps a published input snapshot stable when the tool's object changes later", async () => {
    const seen: unknown[] = [];
    const input: Record<string, unknown> = { value: 1 };
    const hold = gate();

    const host = testHost({
      modelClient: scriptedModel([
        toolReply("call-1", "observer", input),
        gatedReply(hold, textReply("done")),
      ]).client,
      plugins: [testPlugin({ id: "tools", tools: [recordingTool("observer", seen)] })],
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "mutate me",
    });
    const runId = started.result?.run.runId as string;
    await client.waitForEvent("run.tool.result");

    const call = client.events.find((event) => event.type === "run.tool.call");
    // The tool — and the model's own object — still own that reference; the
    // published projection does not follow it.
    input["value"] = 999;
    input["added"] = true;

    expect(call?.payload.item.input).toEqual({ kind: "json", value: { value: 1 } });

    hold.open();
    await awaitRunTerminal(client, runId);
  });
});

describe("canonical occurrences", () => {
  it("pairs each call with its own result in log order", async () => {
    const host = testHost({
      modelClient: scriptedModel([
        [
          { type: "tool-call", call: { callId: "call-1", name: "echo", input: { n: 1 } } },
          { type: "tool-call", call: { callId: "call-1", name: "echo", input: { n: 2 } } },
          { type: "done" },
        ],
        textReply("both done"),
      ]).client,
      plugins: [testPlugin({ id: "tools", tools: [constantTool("echo", "42")] })],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    await awaitRunTerminal(
      client,
      (await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: nextId("sub"),
        text: "two calls, one id",
      })).result?.run.runId as string,
    );

    const canonical = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session.canonical ?? [];
    expect(canonical.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool-call",
      "tool-result",
      "tool-call",
      "tool-result",
      "assistant",
    ]);

    const calls = canonical.filter((item) => item.kind === "tool-call");
    const results = canonical.filter((item) => item.kind === "tool-result");
    expect(calls[0]?.invocationId).toBe(results[0]?.invocationId);
    expect(calls[1]?.invocationId).toBe(results[1]?.invocationId);
    expect(calls[0]?.invocationId).not.toBe(calls[1]?.invocationId);
    // Same call id, different inputs: two occurrences, never merged.
    expect(calls[0]?.callId).toBe("call-1");
    expect(calls[1]?.callId).toBe("call-1");
    expect(calls[0]?.input).toEqual({ kind: "json", value: { n: 1 } });
    expect(calls[1]?.input).toEqual({ kind: "json", value: { n: 2 } });
  });

  it("records a failed tool observation as ok:false without interpreting it", async () => {
    const host = testHost({
      modelClient: scriptedModel([toolReply("call-1", "ghost", {}), textReply("recovered")]).client,
    });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    await awaitRunTerminal(
      client,
      (await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: nextId("sub"),
        text: "call something missing",
      })).result?.run.runId as string,
    );

    const canonical = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session.canonical ?? [];
    const result = canonical.find((item) => item.kind === "tool-result");
    expect(result?.ok).toBe(false);
    expect(typeof result?.content).toBe("string");
  });
});

describe("safe failure projection", () => {
  it("does not put a Core failure's own words on the wire", async () => {
    const host = testHost({
      modelClient: scriptedModel([{ error: "provider said: key=sk-secret-value" } as never]).client,
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const terminal = await awaitRunTerminal(
      client,
      (await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: nextId("sub"),
        text: "fail me",
      })).result?.run.runId as string,
    );

    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("error");
    expect(JSON.stringify(terminal)).not.toContain("sk-secret-value");
    expect(terminal.error?.message).not.toContain("provider said");
    expect(JSON.stringify(client.frames)).not.toContain("sk-secret-value");
  });

  it("does not publish a plugin's own failure message", async () => {
    const host = testHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [failingPlugin("boom")],
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});

    const response = await client.call("plugins.enable", { pluginId: "boom" });

    expect(response.error?.code).toBe("PLUGIN_OPERATION_FAILED");
    expect(response.error?.message).not.toContain("super-secret-token");

    const listed = (await client.call("plugins.list", {})).result?.plugins ?? [];
    expect(listed[0]).toMatchObject({
      id: "boom",
      status: "disabled",
      lastFailure: {
        operation: "enable",
        phase: "activate",
        code: "PLUGIN_OPERATION_FAILED",
        cleanupFailureCount: 0,
      },
    });
    expect(JSON.stringify(listed)).not.toContain("super-secret-token");
    expect(JSON.stringify(client.frames)).not.toContain("super-secret-token");

    // The status alone did not change: it was disabled before and after. The
    // failure summary did, and that is what the announcement is for.
    const updates = client.events.filter((event) => event.type === "plugin.updated");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.at(-1)?.payload.plugin.lastFailure?.code).toBe("PLUGIN_OPERATION_FAILED");
  });

  it("does not announce a plugin whose public content did not change", async () => {
    const host = testHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [testPlugin({ id: "quiet", tools: [] })],
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});

    await client.call("plugins.list", {});
    await client.call("plugins.list", {});
    await flush();

    expect(client.events.filter((event) => event.type === "plugin.updated")).toHaveLength(0);
  });

  it("counts failed cleanup without repeating its text", async () => {
    const host = testHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [failingPlugin("boom", { cleanupFails: true })],
    });
    const client = connect(host);
    await client.describe();

    const response = await client.call("plugins.enable", { pluginId: "boom" });
    expect(response.error?.code).toBe("PLUGIN_OPERATION_FAILED");

    const info = (await client.call("plugins.list", {})).result?.plugins[0];
    expect(info?.status).toBe("error");
    expect(info?.lastFailure?.cleanupFailureCount).toBe(1);
    expect(JSON.stringify(info)).not.toContain("super-secret-token");

    // A plugin in the error state cannot be operated on any more.
    const refused = await client.call("plugins.enable", { pluginId: "boom" });
    expect(refused.error?.code).toBe("PLUGIN_UNAVAILABLE");
  });

  it("turns an unprojectable live value into a host failure with a blocked session", async () => {
    const host = testHost({ modelClient: scriptedModel([brokenTextReply(), textReply("never used")]).client });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const before = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session;

    const terminal = await awaitRunTerminal(
      client,
      (await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: nextId("sub"),
        text: "break the projection",
      })).result?.run.runId as string,
    );

    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("host_error");
    expect(terminal.error?.code).toBe("INTERNAL_ERROR");
    expect(terminal.live).toBeNull();

    const after = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session;
    expect(after?.status).toBe("blocked");
    expect(after?.activeRunId).toBeNull();
    expect(after?.canonical).toEqual(before?.canonical);

    // A blocked session is readable but cannot take a new run.
    const refused = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "again",
    });
    expect(refused.error?.code).toBe("SESSION_UNAVAILABLE");
  });

  it("keeps draining a faulted run while its tool is still running", async () => {
    const started = gate();
    const release = gate();
    const model = scriptedModel([
      [
        { type: "text-delta", text: { broken: true } as unknown as string },
        { type: "tool-call", call: { callId: "call-1", name: "slow", input: {} } },
        { type: "done" },
      ],
      textReply("unused"),
    ]);

    const host = testHost({
      modelClient: model.client,
      plugins: [testPlugin({ id: "tools", tools: [gatedTool("slow", release, started)] })],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const response = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "break then keep working",
    });
    const runId = response.result?.run.runId as string;

    // The projection failed (a non-string chunk), but the tool still ran: the
    // host drains the execution instead of abandoning it.
    await started.promise;
    const during = (await client.call("runs.get", { runId })).result?.run;
    expect(during?.live).not.toBeNull();

    release.open();
    const terminal = await awaitRunTerminal(client, runId);
    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("host_error");
    expect(model.requests.length).toBeGreaterThanOrEqual(1);
  });
});
