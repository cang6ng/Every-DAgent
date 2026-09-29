import { describe, expect, it } from "vitest";

import type { CanonicalItem, HostEvent } from "@every-dagent/protocol";

import {
  abortAwareReply,
  awaitRunTerminal,
  connect,
  constantTool,
  createSessionThrough,
  flush,
  gate,
  gatedReply,
  gatedTool,
  nextId,
  partialThenAbortReply,
  replyThenFail,
  runToTerminal,
  scriptedModel,
  testHost,
  testPlugin,
  textAndToolReply,
  textReply,
  toolReply,
} from "./helpers/harness.js";

function pluginWith(tools: Parameters<typeof testPlugin>[0]["tools"]) {
  return testPlugin({ id: "tools", tools });
}

describe("run lifecycle", () => {
  it("announces accepted, then running, then the terminal publication", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("the answer")]).client });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const terminal = await runToTerminal(client, session.sessionId, "hello");

    expect(terminal.status).toBe("completed");
    expect(terminal.endReason).toBe("completed");
    expect(terminal.error).toBeNull();
    expect(terminal.live).toBeNull();
    expect(terminal.text).toBe("hello");

    const updated = client.events.filter((event) => event.type === "run.updated");
    expect(updated[0]?.payload.run.status).toBe("accepted");
    expect(updated.some((event) => event.payload.run.status === "running")).toBe(true);

    const ended = client.events.filter((event) => event.type === "run.ended");
    expect(ended).toHaveLength(1);
  });

  it("binds the Core turn id once, and only after it is observed", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("hi")]).client });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    await runToTerminal(client, session.sessionId, "hello");

    const updates = client.events.filter((event) => event.type === "run.updated");
    // Accepted carries no turn id: the Core has not produced one yet.
    expect(updates[0]?.payload.run.turnId).toBeNull();
    // The first RuntimeEvent binds it, and the binding is announced.
    const bound = updates.find((event) => event.payload.run.turnId !== null);
    expect(bound).toBeDefined();
    expect(typeof bound?.payload.run.turnId).toBe("string");

    const endedTurnId = client.events.find((event) => event.type === "run.ended")?.payload.run.turnId;
    expect(endedTurnId).toBe(bound?.payload.run.turnId);
  });

  it("points the session at its active run while it runs, and clears it at the end", async () => {
    const hold = gate();
    const host = testHost({ modelClient: scriptedModel([gatedReply(hold)]).client });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "hold on",
    });
    const runId = started.result?.run.runId as string;

    const during = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session;
    expect(during?.activeRunId).toBe(runId);

    hold.open();
    const terminal = await awaitRunTerminal(client, runId);

    const after = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session;
    expect(after?.activeRunId).toBeNull();
    expect(after?.canonical.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(terminal.status).toBe("completed");
  });

  it("refuses a second run aimed at a session that already has one", async () => {
    const hold = gate();
    const host = testHost({ modelClient: scriptedModel([gatedReply(hold)]).client });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const first = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "first",
    });
    const second = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "second",
    });

    expect(first.result?.run.status).toBe("accepted");
    // A ready session with a run still holds the registry token, so the refusal
    // is the gate's: the session itself is perfectly usable.
    expect(second.error?.code).toBe("HOST_BUSY");

    hold.open();
    await awaitRunTerminal(client, first.result?.run.runId as string);
  });

  it("refuses a run on another session while the host is occupied", async () => {
    const hold = gate();
    const host = testHost({ modelClient: scriptedModel([gatedReply(hold)]).client });
    const client = connect(host);
    await client.describe();
    const busySession = await createSessionThrough(client);
    const otherSession = await createSessionThrough(client);

    const first = await client.call("runs.start", {
      sessionId: busySession.sessionId,
      submissionId: nextId("sub"),
      text: "first",
    });
    const second = await client.call("runs.start", {
      sessionId: otherSession.sessionId,
      submissionId: nextId("sub"),
      text: "second",
    });

    expect(first.result?.run.status).toBe("accepted");
    expect(second.error?.code).toBe("HOST_BUSY");

    hold.open();
    await awaitRunTerminal(client, first.result?.run.runId as string);
  });

  it("answers runs.get by run id or by submission id", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("hi")]).client });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const submissionId = nextId("sub");
    const started = await client.call("runs.start", { sessionId: session.sessionId, submissionId, text: "hi" });
    const runId = started.result?.run.runId as string;

    expect((await client.call("runs.get", { runId })).result?.run.runId).toBe(runId);
    expect((await client.call("runs.get", { submissionId })).result?.run.runId).toBe(runId);
    expect((await client.call("runs.get", { runId: "missing" })).error?.code).toBe("RUN_NOT_FOUND");
    expect((await client.call("runs.get", { submissionId: "missing" })).error?.code).toBe("RUN_NOT_FOUND");

    await awaitRunTerminal(client, runId);
  });

  it("reports a recorded turn as limited when the step budget runs out", async () => {
    const host = testHost({
      modelClient: scriptedModel([toolReply("call-1", "echo", { value: 1 })], { repeatLast: true }).client,
      plugins: [pluginWith([constantTool("echo", "42")])],
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const terminal = await runToTerminal(client, session.sessionId, "count forever");

    expect(terminal.status).toBe("limited");
    expect(terminal.endReason).toBe("max_steps");
    expect(terminal.error).toBeNull();

    const snapshot = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session;
    expect(snapshot?.canonical.filter((item) => item.kind === "assistant")).toHaveLength(12);
    expect(snapshot?.canonical.filter((item) => item.kind === "tool-call")).toHaveLength(12);
    expect(snapshot?.canonical.filter((item) => item.kind === "tool-result")).toHaveLength(12);
  });
});

describe("live timeline", () => {
  it("folds chunks into one text item and fills the tool occurrence", async () => {
    const hold = gate();
    const host = testHost({
      modelClient: scriptedModel([
        toolReply("call-1", "echo", { value: 7 }),
        gatedReply(hold, [{ type: "text-delta", text: "The " }, { type: "text-delta", text: "answer" }, { type: "done" }]),
      ]).client,
      plugins: [pluginWith([constantTool("echo", "42")])],
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "calculate",
    });
    const runId = started.result?.run.runId as string;
    // The tool result arrives while the next model step is still gated.
    await client.waitForEvent("run.tool.result");

    // Read the live timeline from the directory while the run is still active.
    const active = (await client.call("runs.get", { runId })).result?.run;
    expect(active?.live?.map((item) => item.kind)).toEqual(["tool"]);
    expect(active?.live?.[0]).toMatchObject({
      kind: "tool",
      callId: "call-1",
      name: "echo",
      input: { kind: "json", value: { value: 7 } },
      result: { ok: true, content: "42" },
    });

    hold.open();
    const terminal = await awaitRunTerminal(client, runId);
    expect(terminal.status).toBe("completed");

    const calls = client.events.filter((event) => event.type === "run.tool.call");
    const results = client.events.filter((event) => event.type === "run.tool.result");
    const deltas = client.events.filter((event) => event.type === "run.output.delta");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload.item).toMatchObject({
      kind: "tool",
      callId: "call-1",
      name: "echo",
      input: { kind: "json", value: { value: 7 } },
      result: null,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toEqual({
      invocationId: calls[0]?.payload.item.invocationId,
      ok: true,
      content: "42",
    });

    // Two chunks, one text item: both deltas carry the same item id.
    expect(deltas.map((event) => event.payload.text)).toEqual(["The ", "answer"]);
    expect(deltas[0]?.payload.itemId).toBe(deltas[1]?.payload.itemId);
  });

  it("keeps a second text item after a tool call instead of appending to the first", async () => {
    const hold = gate();
    const host = testHost({
      modelClient: scriptedModel([
        textAndToolReply("before", "call-1", "echo", {}),
        gatedReply(hold, textReply("after")),
      ]).client,
      plugins: [pluginWith([constantTool("echo", "42")])],
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "go",
    });
    const runId = started.result?.run.runId as string;
    await client.waitForEvent("run.tool.result");

    const active = (await client.call("runs.get", { runId })).result?.run;
    const kinds = (active?.live ?? []).map((item) => item.kind);
    const textIds = (active?.live ?? []).filter((item) => item.kind === "text").map((item) => item.itemId);

    expect(kinds).toEqual(["text", "tool"]);
    expect(new Set(textIds).size).toBe(1);

    hold.open();
    await awaitRunTerminal(client, runId);

    const settled = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session;
    expect(settled?.canonical.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool-call",
      "tool-result",
      "assistant",
    ]);
  });

  it("keeps an empty and a repeated call id as separate occurrences", async () => {
    const host = testHost({
      modelClient: scriptedModel([
        [
          { type: "tool-call", call: { callId: "", name: "echo", input: { n: 1 } } },
          { type: "tool-call", call: { callId: "", name: "echo", input: { n: 2 } } },
          { type: "done" },
        ],
        [
          { type: "tool-call", call: { callId: "", name: "echo", input: { n: 3 } } },
          { type: "done" },
        ],
        textReply("done"),
      ]).client,
      plugins: [pluginWith([constantTool("echo", "42")])],
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    await runToTerminal(client, session.sessionId, "triple");

    const calls = client.events.filter((event) => event.type === "run.tool.call");
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((event) => event.payload.item.invocationId)).size).toBe(3);
    expect(new Set(calls.map((event) => event.payload.item.itemId)).size).toBe(3);

    const canonical = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session.canonical ?? [];
    expect(canonical.filter((item) => item.kind === "tool-call")).toHaveLength(3);
    expect(canonical.filter((item) => item.kind === "tool-result")).toHaveLength(3);
    expect(
      new Set(canonical.filter((item) => item.kind === "tool-call").map((item) => item.invocationId)).size,
    ).toBe(3);
  });
});

describe("cancellation", () => {
  it("records the request, announces it, and lets the Core decide the outcome", async () => {
    const host = testHost({ modelClient: scriptedModel([abortAwareReply()]).client });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "cancel me",
    });
    const runId = started.result?.run.runId as string;

    const cancelled = await client.call("runs.cancel", { runId });
    expect(cancelled.result?.run.cancelRequested).toBe(true);
    expect(cancelled.result?.run.live).not.toBeNull();

    const terminal = await awaitRunTerminal(client, runId);
    expect(terminal.status).toBe("cancelled");
    expect(terminal.endReason).toBe("cancelled");
    expect(terminal.cancelRequested).toBe(true);

    const announced = client.events.filter(
      (event) => event.type === "run.updated" && event.payload.run.cancelRequested,
    );
    expect(announced.length).toBeGreaterThanOrEqual(1);
  });

  it("does not repeat the request, and returns the terminal state for a finished run", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("answer")]).client });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const terminal = await runToTerminal(client, session.sessionId, "hi");
    const again = await client.call("runs.cancel", { runId: terminal.runId });

    expect(again.result?.run).toEqual(terminal);
    expect(again.result?.run.cancelRequested).toBe(false);
  });

  it("answers an unknown run id with RUN_NOT_FOUND", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("hi")]).client });
    const client = connect(host);
    await client.describe();

    expect((await client.call("runs.cancel", { runId: "missing" })).error?.code).toBe("RUN_NOT_FOUND");
  });

  it("stays busy while an aborted run has not settled", async () => {
    const started = gate();
    const release = gate();
    const host = testHost({
      modelClient: scriptedModel([toolReply("call-1", "slow", {})]).client,
      plugins: [pluginWith([gatedTool("slow", release, started)])],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);
    const other = await createSessionThrough(client);

    const response = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "slow one",
    });
    const runId = response.result?.run.runId as string;

    // Cancel only once the tool is actually in flight: an aborted call that
    // never started would be settled by the Core's own pre-commit checkpoint.
    await started.promise;
    const cancelled = await client.call("runs.cancel", { runId });
    expect(cancelled.result?.run.cancelRequested).toBe(true);
    await flush();

    // The tool ignores the signal, so the run still owns the registry.
    const blocked = await client.call("runs.start", {
      sessionId: other.sessionId,
      submissionId: nextId("sub"),
      text: "another",
    });
    expect(blocked.error?.code).toBe("HOST_BUSY");

    // A repeated cancel changes nothing and is not an error.
    const again = await client.call("runs.cancel", { runId });
    expect(again.result?.run.status).toBe("running");
    expect(again.result?.run.cancelRequested).toBe(true);

    release.open();
    const terminal = await awaitRunTerminal(client, runId);
    expect(terminal.status).toBe("cancelled");
    expect(terminal.cancelRequested).toBe(true);
  });
});

describe("terminal publication", () => {
  it("carries the terminal run and the settled session in one event", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("answer")]).client });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const terminal = await runToTerminal(client, session.sessionId, "hello");

    const ended = client.events.find(
      (event): event is Extract<HostEvent, { type: "run.ended" }> => event.type === "run.ended",
    );
    expect(ended).toBeDefined();
    expect(ended?.payload.run.live).toBeNull();
    expect(ended?.payload.run).toEqual(terminal);
    expect(ended?.payload.session.activeRunId).toBeNull();
    expect(ended?.payload.session.canonical.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(ended?.payload.session.canonical[1]).toMatchObject({ kind: "assistant", text: "answer" });
    expect(ended?.scope).toEqual({
      kind: "run",
      sessionId: session.sessionId,
      runId: terminal.runId,
    });
  });

  it("never publishes a terminal run with a live timeline, or an active one without it", async () => {
    const host = testHost({
      modelClient: scriptedModel([toolReply("call-1", "echo", {}), textReply("done")]).client,
      plugins: [pluginWith([constantTool("echo", "42")])],
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    await runToTerminal(client, session.sessionId, "go");

    for (const event of client.events) {
      if (event.type === "run.updated") {
        expect(event.payload.run.live).not.toBeNull();
        expect(event.payload.run.endReason).toBeNull();
      }
      if (event.type === "run.ended") {
        expect(event.payload.run.live).toBeNull();
      }
    }
  });

  it("removes a failed step's draft and keeps only what the log recorded", async () => {
    const host = testHost({
      modelClient: scriptedModel([
        replyThenFail([{ type: "text-delta", text: "half an answer" }], new Error("provider died")),
      ]).client,
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const terminal = await runToTerminal(client, session.sessionId, "ask");

    expect(terminal.status).toBe("failed");
    expect(terminal.live).toBeNull();
    // The partial text was never recorded, so it is not history now.
    const snapshot = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session;
    expect(snapshot?.canonical.map((item) => item.kind)).toEqual(["user"]);
  });

  it("removes a cancelled step's draft without claiming anything about its tools", async () => {
    const host = testHost({ modelClient: scriptedModel([partialThenAbortReply("thinking out loud")]).client });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "then change your mind",
    });
    const runId = started.result?.run.runId as string;
    await client.waitForEvent("run.output.delta");

    // The draft exists while the run is live.
    const during = (await client.call("runs.get", { runId })).result?.run;
    expect(during?.live).toEqual([{ kind: "text", itemId: expect.any(String), text: "thinking out loud" }]);

    await client.call("runs.cancel", { runId });
    const terminal = await awaitRunTerminal(client, runId);

    expect(terminal.status).toBe("cancelled");
    expect(terminal.live).toBeNull();
    const snapshot = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session;
    expect(snapshot?.canonical.map((item) => item.kind)).toEqual(["user"]);
  });

  it("announces an accepted run before its own response is written", async () => {
    const host = testHost({ modelClient: scriptedModel([textReply("done")]).client });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const before = client.frames.length;
    await runToTerminal(client, session.sessionId, "ordering");
    const frames = client.frames.slice(before).map((frame) => JSON.parse(frame) as Record<string, unknown>);

    const acceptedIndex = frames.findIndex(
      (frame) =>
        frame["kind"] === "host-event" &&
        frame["type"] === "run.updated" &&
        (frame["payload"] as { run: { status: string } }).run.status === "accepted",
    );
    const responseIndex = frames.findIndex(
      (frame) =>
        frame["kind"] === "host-response" &&
        (frame["result"] as { run?: { status?: string } } | undefined)?.run?.status === "accepted",
    );

    // The accepted state is published inside the atomic acceptance, so its
    // event is queued before the operation's own response is written. A client
    // learns the run from the event and confirms it with the response; the
    // reverse order is what the contract forbids, and that is what this pins.
    expect(acceptedIndex).toBeGreaterThanOrEqual(0);
    expect(responseIndex).toBeGreaterThan(acceptedIndex);
  });

  it("keeps previous turns published and appends the new one", async () => {
    const spoken = (item: CanonicalItem): string =>
      item.kind === "user" || item.kind === "assistant" ? item.text : item.kind;
    const host = testHost({ modelClient: scriptedModel([textReply("first"), textReply("second")]).client });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    await runToTerminal(client, session.sessionId, "one");
    const afterFirst = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session;
    expect(afterFirst?.canonical.map(spoken)).toEqual(["one", "first"]);
    const firstIds = afterFirst?.canonical.map((item) => item.id);

    await runToTerminal(client, session.sessionId, "two");
    const afterSecond = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session;

    expect(afterSecond?.canonical).toHaveLength(4);
    expect(afterSecond?.canonical.slice(0, 2).map((item) => item.id)).toEqual(firstIds);
    expect(afterSecond?.canonical.map(spoken)).toEqual(["one", "first", "two", "second"]);
  });
});
