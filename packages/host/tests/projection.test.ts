import { describe, expect, it } from "vitest";

import type { ModelEvent } from "@every-dagent/agent-core";
import type { CanonicalItem } from "@every-dagent/protocol";
import { MAX_PAGE_ITEMS } from "@every-dagent/protocol";

import { projectDisplayInput } from "../src/projection.js";

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
  type TestClient,
} from "./helpers/harness.js";

/** A model step whose text is not a string — a value the wire cannot carry. */
function brokenTextReply(): readonly ModelEvent[] {
  return [
    { type: "text-delta", text: { not: "a string" } as unknown as string },
    { type: "done" },
  ];
}

/**
 * One session's committed conversation, as one list.
 *
 * v2 keeps history out of the session summary and hands it out in bounded
 * pages, so reading "the whole conversation" is a traversal: each page is the
 * newest window not read yet, in log order, and the pages that follow are
 * older — so a later page is placed in front of what is already collected.
 * The largest legal page is asked for, so a conversation this size costs one
 * round trip; the traversal still follows whatever cursor comes back.
 */
async function conversation(client: TestClient, sessionId: string): Promise<readonly CanonicalItem[]> {
  const items: CanonicalItem[] = [];
  let cursor: string | undefined;

  for (;;) {
    const response = await client.call(
      "sessions.history",
      cursor === undefined ? { sessionId, limit: MAX_PAGE_ITEMS } : { sessionId, limit: MAX_PAGE_ITEMS, cursor },
    );
    if (response.result === undefined) {
      throw new Error(`sessions.history failed: ${response.error.code}`);
    }

    const page = response.result.page;
    items.unshift(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
}

describe("tool inputs a durable conversation cannot carry", () => {
  /**
   * Runs one turn whose model step calls with a value the JSON profile refuses.
   *
   * The model repeats the same step, so the turn ends the way a model failure
   * ends — and the assertions are about what must *not* have happened on the
   * way there: no execution, no fabricated canonical call, no live call item.
   */
  async function refusedStep(input: unknown): Promise<{
    readonly status: string;
    readonly executions: number;
    readonly canonical: readonly CanonicalItem[];
    readonly liveCalls: number;
  }> {
    const seen: unknown[] = [];
    const host = testHost({
      modelClient: scriptedModel([toolReply("call-1", "observer", input)], { repeatLast: true }).client,
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

    const canonical = await conversation(client, session.sessionId);
    const liveCalls = client.events.filter((event) => event.type === "run.tool.call").length;
    client.detach();
    await host.shutdown();

    return { status: terminal.status, executions: seen.length, canonical, liveCalls };
  }

  it("refuses the step before the tool runs, and records no call in its place", async () => {
    const outcome = await refusedStep({ bad: undefined });

    // Nothing executed, and nothing was invented to stand in for the call.
    expect(outcome.executions).toBe(0);
    expect(outcome.canonical.some((item) => item.kind === "tool-call")).toBe(false);
    expect(outcome.canonical.some((item) => item.kind === "tool-result")).toBe(false);
    expect(outcome.canonical.some((item) => item.kind === "assistant")).toBe(false);
    expect(outcome.liveCalls).toBe(0);
    // The turn itself is honestly recorded as a model failure.
    expect(outcome.status).toBe("failed");
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
  ])("refuses %s before the tool runs", async (_name, input) => {
    const outcome = await refusedStep(input);

    expect(outcome.executions).toBe(0);
    expect(outcome.canonical.some((item) => item.kind === "tool-call")).toBe(false);
    expect(outcome.status).toBe("failed");
  });

  it("does not read an input through an accessor, and does not hand one to a tool", async () => {
    let reads = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "trap", {
      enumerable: true,
      get() {
        reads += 1;
        return "gotcha";
      },
    });

    const outcome = await refusedStep(input);

    // The refusal never read the getter, and the tool was never reached.
    expect(reads).toBe(0);
    expect(outcome.executions).toBe(0);
    expect(outcome.canonical.some((item) => item.kind === "tool-call")).toBe(false);
  });

  it("still projects a value the wire cannot carry as an honest unavailable, for display", () => {
    // The generic display projection keeps its own job — showing what a tool
    // was given when there is something to show, and saying so when there is
    // not — even though managed execution no longer lets such a call settle.
    expect(projectDisplayInput({ bad: undefined })).toEqual({ kind: "unavailable", reason: "not-json-safe" });

    let reads = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "trap", {
      enumerable: true,
      get() {
        reads += 1;
        return "gotcha";
      },
    });
    expect(projectDisplayInput(hostile)).toEqual({ kind: "unavailable", reason: "not-json-safe" });
    expect(reads).toBe(0);
  });
});

describe("published input snapshots", () => {
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

    const canonical = await conversation(client, session.sessionId);
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

    const canonical = await conversation(client, session.sessionId);
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

    const before = await conversation(client, session.sessionId);

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
    // The fault settled nothing: history is exactly what it was before the run.
    expect(await conversation(client, session.sessionId)).toEqual(before);

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
