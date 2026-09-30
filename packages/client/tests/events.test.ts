/**
 * Folding the eight events.
 *
 * Each test drives one event type through the real validation and fold path and
 * checks what the presentation replica makes of it — including the events that
 * cannot follow from the state the client holds, which must be refused rather
 * than repaired.
 */

import { describe, expect, it } from "vitest";

import { createScenario, openWith } from "./helpers/scenario.js";
import {
  activeRun,
  completedRun,
  pluginSummary,
  runningRun,
  sessionIn,
  sessionSnapshot,
  textItem,
  toolItem,
} from "./helpers/values.js";

const SESSION = sessionSnapshot({ sessionId: "s-1" });

describe("session and plugin events", () => {
  it("appends a created session in directory order", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });

    scenario.host.emit({ type: "session.created", session: sessionSnapshot({ sessionId: "s-2" }) });

    expect(scenario.client.getSnapshot().presentation?.sessions.map((item) => item.sessionId)).toEqual(["s-1", "s-2"]);
  });

  it("refuses a session that is already there", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });

    scenario.host.emit({ type: "session.created", session: sessionSnapshot({ sessionId: "s-1" }) });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
    expect(scenario.client.getSnapshot().error?.reason).toBe("invalid-event");
  });

  it("replaces a plugin summary in place", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { plugins: [pluginSummary({ id: "demo" })] });

    scenario.host.emit({
      type: "plugin.updated",
      plugin: pluginSummary({ id: "demo", status: "enabled", lastFailure: { operation: "enable", phase: "activate", code: "PLUGIN_OPERATION_FAILED", message: "the plugin failed to activate", cleanupFailureCount: 1 } }),
    });

    const plugin = scenario.client.getSnapshot().presentation?.plugins[0];
    expect(plugin?.status).toBe("enabled");
    expect(plugin?.lastFailure?.cleanupFailureCount).toBe(1);
  });

  it("refuses a plugin the snapshot never had", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario);

    scenario.host.emit({ type: "plugin.updated", plugin: pluginSummary({ id: "ghost" }) });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });
});

describe("run events", () => {
  it("adds an accepted run and points the session at it, in one update", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    let notifications = 0;
    scenario.client.subscribe(() => {
      notifications += 1;
    });

    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

    const presentation = scenario.client.getSnapshot().presentation;
    expect(notifications).toBe(1);
    expect(presentation?.runs.map((run) => run.runId)).toEqual(["r-1"]);
    expect(sessionIn(presentation?.sessions ?? [], "s-1")?.activeRunId).toBe("r-1");
  });

  it("moves accepted to running without losing the run's identity", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

    scenario.host.emit({
      type: "run.updated",
      run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1", turnId: "turn-1", live: [textItem("i-1", "hi")] }),
    });

    const run = scenario.client.getSnapshot().presentation?.runs[0];
    expect(run?.status).toBe("running");
    expect(run?.turnId).toBe("turn-1");
    expect(run?.live).toHaveLength(1);
  });

  it("refuses a run whose identity changed", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    scenario.host.emit({ type: "run.updated", run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

    scenario.host.emit({
      type: "run.updated",
      run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1", text: "different text" }),
    });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
    expect(scenario.client.getSnapshot().error?.reason).toBe("run-identity");
  });

  it("refuses a run whose turn id moved", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    scenario.host.emit({
      type: "run.updated",
      run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1", turnId: "turn-1" }),
    });

    scenario.host.emit({
      type: "run.updated",
      run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1", turnId: "turn-2" }),
    });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("refuses a second active run for the same session", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-2", sessionId: "s-1", submissionId: "sub-2" }) });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("refuses content for a run the client does not have", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });

    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-missing", itemId: "i-1", text: "hi" });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });
});

describe("live text and tools", () => {
  /**
   * A run that has reached `running`, written the way the host writes it:
   * accepted, then running, and only then content. Content before running is a
   * contract violation, and the fold refuses it.
   */
  async function withRun(text = "hello") {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1", text }) });
    scenario.host.emit({ type: "run.updated", run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1", text }) });
    return scenario;
  }

  it("opens a text item on the first chunk and appends to it afterwards", async () => {
    const scenario = await withRun();

    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-1", text: "hel" });
    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-1", text: "lo" });

    const live = scenario.client.getSnapshot().presentation?.runs[0]?.live;
    expect(live).toHaveLength(1);
    expect(live?.[0]).toMatchObject({ kind: "text", itemId: "i-1", text: "hello" });
  });

  it("opens a second text item after a tool, without touching the first", async () => {
    const scenario = await withRun();
    const tool = toolItem({ itemId: "t-1", invocationId: "inv-1", callId: "call-1" });

    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-1", text: "before" });
    scenario.host.emit({ type: "run.tool.call", sessionId: "s-1", runId: "r-1", item: tool });
    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-2", text: "after" });

    const live = scenario.client.getSnapshot().presentation?.runs[0]?.live;
    expect(live?.map((item) => item.kind)).toEqual(["text", "tool", "text"]);
    expect(live?.[0]).toMatchObject({ text: "before" });
    expect(live?.[2]).toMatchObject({ text: "after" });
  });

  it("keeps two tool occurrences that share a callId", async () => {
    const scenario = await withRun();
    const first = toolItem({ itemId: "t-1", invocationId: "inv-1", callId: "same-call", input: { kind: "json", value: { step: 1 } } });
    const second = toolItem({ itemId: "t-2", invocationId: "inv-2", callId: "same-call", input: { kind: "json", value: { step: 2 } } });

    scenario.host.emit({ type: "run.tool.call", sessionId: "s-1", runId: "r-1", item: first });
    scenario.host.emit({ type: "run.tool.call", sessionId: "s-1", runId: "r-1", item: second });

    const live = scenario.client.getSnapshot().presentation?.runs[0]?.live;
    expect(live).toHaveLength(2);
    expect(live?.[0]).toMatchObject({ invocationId: "inv-1" });
    expect(live?.[1]).toMatchObject({ invocationId: "inv-2" });
  });

  it("fills the open occurrence and leaves it settled", async () => {
    const scenario = await withRun();
    scenario.host.emit({
      type: "run.tool.call",
      sessionId: "s-1",
      runId: "r-1",
      item: toolItem({ itemId: "t-1", invocationId: "inv-1", input: { kind: "unavailable", reason: "not-json-safe" } }),
    });

    scenario.host.emit({ type: "run.tool.result", sessionId: "s-1", runId: "r-1", invocationId: "inv-1", ok: false, content: "it failed" });

    const live = scenario.client.getSnapshot().presentation?.runs[0]?.live;
    expect(live?.[0]).toMatchObject({ kind: "tool", result: { ok: false, content: "it failed" } });
  });

  it("refuses a result for an occurrence it does not have", async () => {
    const scenario = await withRun();

    scenario.host.emit({ type: "run.tool.result", sessionId: "s-1", runId: "r-1", invocationId: "inv-ghost", ok: true, content: "x" });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("refuses a result for an occurrence that is already settled", async () => {
    const scenario = await withRun();
    scenario.host.emit({
      type: "run.tool.call",
      sessionId: "s-1",
      runId: "r-1",
      item: toolItem({ itemId: "t-1", invocationId: "inv-1", callId: "c" }),
    });
    scenario.host.emit({ type: "run.tool.result", sessionId: "s-1", runId: "r-1", invocationId: "inv-1", ok: true, content: "once" });

    scenario.host.emit({ type: "run.tool.result", sessionId: "s-1", runId: "r-1", invocationId: "inv-1", ok: true, content: "twice" });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("refuses a tool call that reuses an item id", async () => {
    const scenario = await withRun();
    const item = toolItem({ itemId: "t-1", invocationId: "inv-1", callId: "c" });
    scenario.host.emit({ type: "run.tool.call", sessionId: "s-1", runId: "r-1", item });

    scenario.host.emit({
      type: "run.tool.call",
      sessionId: "s-1",
      runId: "r-1",
      item: { ...item, invocationId: "inv-2" },
    });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });
});

describe("the terminal correction", () => {
  it("applies the terminal run and the settled session in one notification", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    scenario.host.emit({ type: "run.updated", run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-1", text: "draft" });

    const seen: { readonly runLive: unknown; readonly activeRunId: unknown }[] = [];
    scenario.client.subscribe(() => {
      const presentation = scenario.client.getSnapshot().presentation;
      seen.push({
        runLive: presentation?.runs[0]?.live,
        activeRunId: sessionIn(presentation?.sessions ?? [], "s-1")?.activeRunId,
      });
    });

    const canonical = [
      { id: "c-1", turnId: "turn-1", kind: "user" as const, text: "hello" },
      { id: "c-2", turnId: "turn-1", kind: "assistant" as const, text: "hello back" },
    ];
    scenario.host.emit({
      type: "run.ended",
      run: completedRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }),
      session: sessionSnapshot({ sessionId: "s-1", canonical }),
    });

    // One notification, and it carries both halves already applied: the draft is
    // gone with the run, and the session points at nothing while holding history.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.runLive).toBeNull();
    expect(seen[0]?.activeRunId).toBeNull();

    const presentation = scenario.client.getSnapshot().presentation;
    expect(presentation?.runs[0]?.status).toBe("completed");
    expect(sessionIn(presentation?.sessions ?? [], "s-1")?.canonical).toHaveLength(2);
  });

  it("refuses an end for a run that is already terminal", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const ending = { type: "run.ended" as const, run: completedRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }), session: sessionSnapshot({ sessionId: "s-1" }) };
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    scenario.host.emit(ending);

    scenario.host.emit(ending);

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });
});

describe("unknown events", () => {
  it("refuses an event type it does not know", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const host = scenario.host;

    host.sendRaw(
      JSON.stringify({
        kind: "host-event",
        protocolVersion: "1",
        hostInstanceId: host.hostInstanceId,
        streamId: host.currentStreamId,
        sequence: host.currentSequence + 1,
        type: "run.reasoning.delta",
        scope: { kind: "run", sessionId: "s-1", runId: "r-1" },
        payload: { text: "thinking" },
      }),
    );

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
    expect(scenario.client.getSnapshot().error?.reason).toBe("unknown-event");
  });

  it("refuses an event whose scope contradicts its payload", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    const host = scenario.host;

    host.sendRaw(
      JSON.stringify({
        kind: "host-event",
        protocolVersion: "1",
        hostInstanceId: host.hostInstanceId,
        streamId: host.currentStreamId,
        sequence: host.currentSequence + 1,
        type: "session.created",
        scope: { kind: "session", sessionId: "s-OTHER" },
        payload: { session: SESSION },
      }),
    );

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
    expect(scenario.client.getSnapshot().error?.reason).toBe("invalid-event");
  });
});

describe("content and runs must fit the history the client published", () => {
  async function running(): Promise<ReturnType<typeof createScenario>> {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    scenario.host.emit({ type: "run.updated", run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    return scenario;
  }

  for (const kind of ["run.output.delta", "run.tool.call", "run.tool.result"] as const) {
    it(`refuses a ${kind} whose scope names another session`, async () => {
      const scenario = await running();
      if (kind === "run.tool.result") {
        scenario.host.emit({
          type: "run.tool.call",
          sessionId: "s-1",
          runId: "r-1",
          item: toolItem({ itemId: "i-1", invocationId: "inv-1" }),
        });
      }
      const before = scenario.client.getSnapshot().presentation;

      if (kind === "run.output.delta") {
        scenario.host.emit({ type: kind, sessionId: "WRONG", runId: "r-1", itemId: "i-1", text: "injected" });
      }
      if (kind === "run.tool.call") {
        scenario.host.emit({
          type: kind,
          sessionId: "WRONG",
          runId: "r-1",
          item: toolItem({ itemId: "i-1", invocationId: "inv-1" }),
        });
      }
      if (kind === "run.tool.result") {
        scenario.host.emit({ type: kind, sessionId: "WRONG", runId: "r-1", invocationId: "inv-1", ok: true, content: "injected" });
      }

      expect(scenario.client.getSnapshot().status).toBe("protocol-error");
      expect(scenario.client.getSnapshot().presentation).toBe(before);
    });
  }

  it("refuses a run that begins as running without an accepted publication", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });

    scenario.host.emit({ type: "run.updated", run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("refuses a running run that goes back to accepted", async () => {
    const scenario = await running();

    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("refuses content before the run has reached running", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: [SESSION] });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-1", text: "too early" });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("refuses a full live replacement that rewrites a published occurrence", async () => {
    const scenario = await running();
    scenario.host.emit({
      type: "run.tool.call",
      sessionId: "s-1",
      runId: "r-1",
      item: toolItem({ itemId: "i-1", invocationId: "inv-1", name: "original" }),
    });

    scenario.host.emit({
      type: "run.updated",
      run: runningRun({
        runId: "r-1",
        sessionId: "s-1",
        submissionId: "sub-1",
        live: [toolItem({ itemId: "i-1", invocationId: "inv-1", name: "REWRITTEN" })],
      }),
    });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("accepts a full live replacement that only extends the timeline", async () => {
    const scenario = await running();
    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-1", text: "hello" });

    scenario.host.emit({
      type: "run.updated",
      run: runningRun({
        runId: "r-1",
        sessionId: "s-1",
        submissionId: "sub-1",
        live: [textItem("i-1", "hello world")],
      }),
    });

    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(scenario.client.getSnapshot().presentation?.runs[0]).toMatchObject({
      status: "running",
      live: [{ itemId: "i-1", kind: "text", text: "hello world" }],
    });
  });
});
