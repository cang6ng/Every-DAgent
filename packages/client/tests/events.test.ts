/**
 * Folding the eight events.
 *
 * Each test drives one event type through the real validation and fold path and
 * checks what the presentation replica makes of it — including the events that
 * cannot follow from the state the client holds, which must be refused rather
 * than repaired.
 */

import { describe, expect, it } from "vitest";

import type { TerminalRunSnapshot } from "@every-dagent/protocol";

import { createScenario, openWith } from "./helpers/scenario.js";
import {
  activeRun,
  completedRun,
  pluginSummary,
  runIn,
  runningRun,
  sessionIn,
  sessionPage,
  sessionSummary,
  textItem,
  toolItem,
} from "./helpers/values.js";

const SESSION = sessionSummary({ sessionId: "s-1" });

describe("session and plugin events", () => {
  it("puts a created session at the front of the directory window", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([SESSION]) });

    scenario.host.emit({ type: "session.created", session: sessionSummary({ sessionId: "s-2" }) });

    expect(scenario.client.getSnapshot().presentation?.sessions.items.map((item) => item.sessionId)).toEqual(["s-2", "s-1"]);
  });

  it("refuses a session that is already there", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([SESSION]) });

    scenario.host.emit({ type: "session.created", session: sessionSummary({ sessionId: "s-1" }) });

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
    await openWith(scenario, { sessions: sessionPage([SESSION]) });
    let notifications = 0;
    scenario.client.subscribe(() => {
      notifications += 1;
    });

    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

    const presentation = scenario.client.getSnapshot().presentation;
    expect(notifications).toBe(1);
    expect(presentation?.runs.items.map((run) => run.runId)).toEqual(["r-1"]);
    expect(sessionIn(presentation?.sessions.items ?? [], "s-1")?.activeRunId).toBe("r-1");
  });

  it("moves accepted to running without losing the run's identity", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([SESSION]) });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

    scenario.host.emit({
      type: "run.updated",
      run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1", turnId: "turn-1", live: [textItem("i-1", "hi")] }),
    });

    const run = scenario.client.getSnapshot().presentation?.runs.items[0];
    expect(run?.status).toBe("running");
    expect(run?.turnId).toBe("turn-1");
    // The timeline of a run this client watched start lives in the live replica,
    // never in the durable run window.
    expect(scenario.client.getSnapshot().live["r-1"]?.live).toHaveLength(1);
  });

  it("refuses a run whose identity changed", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([SESSION]) });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    scenario.host.emit({ type: "run.updated", run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

    scenario.host.emit({
      type: "run.updated",
      run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1", text: "different text" }),
    });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
    // The directory fold refuses a run that changed its identity as an event
    // that cannot follow from the summary it already published.
    expect(scenario.client.getSnapshot().error?.reason).toBe("invalid-event");
  });

  it("refuses a run whose turn id moved", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([SESSION]) });
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
    await openWith(scenario, { sessions: sessionPage([SESSION]) });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-2", sessionId: "s-1", submissionId: "sub-2" }) });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("refuses content for a run the client does not have", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([SESSION]) });

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
    await openWith(scenario, { sessions: sessionPage([SESSION]) });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1", text }) });
    scenario.host.emit({ type: "run.updated", run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1", text }) });
    return scenario;
  }

  it("opens a text item on the first chunk and appends to it afterwards", async () => {
    const scenario = await withRun();

    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-1", text: "hel" });
    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-1", text: "lo" });

    const live = scenario.client.getSnapshot().live["r-1"]?.live;
    expect(live).toHaveLength(1);
    expect(live?.[0]).toMatchObject({ kind: "text", itemId: "i-1", text: "hello" });
  });

  it("opens a second text item after a tool, without touching the first", async () => {
    const scenario = await withRun();
    const tool = toolItem({ itemId: "t-1", invocationId: "inv-1", callId: "call-1" });

    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-1", text: "before" });
    scenario.host.emit({ type: "run.tool.call", sessionId: "s-1", runId: "r-1", item: tool });
    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-2", text: "after" });

    const live = scenario.client.getSnapshot().live["r-1"]?.live;
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

    const live = scenario.client.getSnapshot().live["r-1"]?.live;
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

    const live = scenario.client.getSnapshot().live["r-1"]?.live;
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
    await openWith(scenario, { sessions: sessionPage([SESSION]) });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    scenario.host.emit({ type: "run.updated", run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-1", text: "draft" });

    const seen: { readonly liveRun: unknown; readonly activeRunId: unknown }[] = [];
    scenario.client.subscribe(() => {
      const snapshot = scenario.client.getSnapshot();
      seen.push({
        liveRun: snapshot.live["r-1"],
        activeRunId: sessionIn(snapshot.presentation?.sessions.items ?? [], "s-1")?.activeRunId,
      });
    });

    scenario.host.emit({
      type: "run.ended",
      run: completedRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }),
      session: sessionSummary({ sessionId: "s-1", committedSeq: 2, historyRevision: 1 }),
    });

    // One notification, and it carries both halves already applied: the draft is
    // gone with the run, and the session points at nothing while holding history.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.liveRun).toBeUndefined();
    expect(seen[0]?.activeRunId).toBeNull();

    const presentation = scenario.client.getSnapshot().presentation;
    expect(presentation?.runs.items[0]?.status).toBe("completed");
    // The two items the terminal turn committed are the session's new high-water
    // (`committedSeq`); the conversation itself is read through `sessions.history`.
    expect(sessionIn(presentation?.sessions.items ?? [], "s-1")?.committedSeq).toBe(2);
  });

  it("refuses an end for a run that is already terminal", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([SESSION]) });
    const ending = { type: "run.ended" as const, run: completedRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }), session: sessionSummary({ sessionId: "s-1" }) };
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    scenario.host.emit({ type: "run.updated", run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    scenario.host.emit(ending);

    scenario.host.emit(ending);

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  /** The run identity these terminal tests end. */
  const RUN = {
    runId: "r-1",
    sessionId: "s-1",
    submissionId: "sub-1",
    text: "hello",
    turnId: "turn-1",
    cancelRequested: false,
    acceptedAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_001,
    endedAt: 1_700_000_000_002,
  } as const;

  /** The successful terminal outcomes. */
  function terminal(status: "completed" | "limited" | "cancelled"): TerminalRunSnapshot {
    switch (status) {
      case "completed":
        return { ...RUN, status: "completed", endReason: "completed", error: null, executionKnowledge: null, live: null };
      case "limited":
        return { ...RUN, status: "limited", endReason: "max_steps", error: null, executionKnowledge: null, live: null };
      case "cancelled":
        return { ...RUN, status: "cancelled", endReason: "cancelled", error: null, executionKnowledge: null, live: null };
    }
  }

  /** A failed run: the Core's own error, or the host's fault before the Core started. */
  function failed(endReason: "error" | "host_error"): TerminalRunSnapshot {
    return {
      ...RUN,
      status: "failed",
      endReason,
      error: { code: "INTERNAL_ERROR", message: "the run failed" },
      executionKnowledge: null,
      live: null,
    };
  }

  // The spec's machine allows exactly one terminal move out of `accepted`: the
  // host's own failure, for a run the Core never started. These three outcomes
  // all require the running publication the client has to have seen.
  for (const status of ["completed", "limited", "cancelled"] as const) {
    it(`refuses a ${status} ending for a run the client never saw running`, async () => {
      const scenario = createScenario({ host: { auto: false } });
      await openWith(scenario, { sessions: sessionPage([SESSION]) });
      scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
      const published = scenario.client.getSnapshot().presentation;

      scenario.host.emit({
        type: "run.ended",
        run: terminal(status),
        session: sessionSummary({ sessionId: "s-1" }),
      });

      // Nothing of the frame was published — not the run, not the session, not
      // the stream position — and the connection does not survive it.
      const snapshot = scenario.client.getSnapshot();
      expect(snapshot.status).toBe("protocol-error");
      expect(snapshot.error?.reason).toBe("invalid-event");
      expect(snapshot.presentation).toBe(published);
      expect(runIn(published?.runs.items ?? [], "r-1")?.status).toBe("accepted");
      expect(snapshot.presentation?.watermark.sequence).toBe(published?.watermark.sequence);
    });
  }

  it("accepts the host's own failure as the terminal move out of accepted", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([SESSION]) });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

    let notifications = 0;
    scenario.client.subscribe(() => {
      notifications += 1;
    });
    scenario.host.emit({
      type: "run.ended",
      run: failed("host_error"),
      session: sessionSummary({ sessionId: "s-1", status: "blocked", blockedReason: "host-fault" }),
    });

    expect(notifications).toBe(1);
    expect(scenario.client.getSnapshot().status).toBe("ready");
    const presentation = scenario.client.getSnapshot().presentation;
    expect(runIn(presentation?.runs.items ?? [], "r-1")?.status).toBe("failed");
    // A terminal run has no timeline at all: the run window holds summaries, and
    // the draft this client watched start is forgotten with the run.
    expect(scenario.client.getSnapshot().live["r-1"]).toBeUndefined();
    expect(sessionIn(presentation?.sessions.items ?? [], "s-1")?.activeRunId).toBeNull();
  });

  // The rule is about stages, not about end reasons: a failure the host writes
  // down as the Core's is still the one terminal move out of `accepted`, and
  // refusing a legal terminal would end a connection over a name.
  it("accepts a failed ending for a run that never started, whatever the host calls the failure", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([SESSION]) });
    scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

    scenario.host.emit({ type: "run.ended", run: failed("error"), session: sessionSummary({ sessionId: "s-1" }) });

    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(runIn(scenario.client.getSnapshot().presentation?.runs.items ?? [], "r-1")?.status).toBe("failed");
  });

  for (const status of ["completed", "limited", "cancelled"] as const) {
    it(`accepts a ${status} ending once the run has been published as running`, async () => {
      const scenario = createScenario({ host: { auto: false } });
      await openWith(scenario, { sessions: sessionPage([SESSION]) });
      scenario.host.emit({ type: "run.updated", run: activeRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
      scenario.host.emit({ type: "run.updated", run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });

      let notifications = 0;
      scenario.client.subscribe(() => {
        notifications += 1;
      });
      scenario.host.emit({
        type: "run.ended",
        run: terminal(status),
        session: sessionSummary({ sessionId: "s-1" }),
      });

      // One notification, carrying the terminal run and the settled session
      // already applied together.
      expect(notifications).toBe(1);
      expect(scenario.client.getSnapshot().status).toBe("ready");
      const presentation = scenario.client.getSnapshot().presentation;
      expect(runIn(presentation?.runs.items ?? [], "r-1")?.status).toBe(status);
      expect(scenario.client.getSnapshot().live["r-1"]).toBeUndefined();
      expect(sessionIn(presentation?.sessions.items ?? [], "s-1")?.activeRunId).toBeNull();
    });
  }
});

describe("unknown events", () => {
  it("refuses an event type it does not know", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const host = scenario.host;

    host.sendRaw(
      JSON.stringify({
        kind: "host-event",
        protocolVersion: "2",
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
    await openWith(scenario, { sessions: sessionPage([SESSION]) });
    const host = scenario.host;

    host.sendRaw(
      JSON.stringify({
        kind: "host-event",
        protocolVersion: "2",
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
    await openWith(scenario, { sessions: sessionPage([SESSION]) });
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
    await openWith(scenario, { sessions: sessionPage([SESSION]) });

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
    await openWith(scenario, { sessions: sessionPage([SESSION]) });
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

    // An occurrence a full replacement carries back is identified by its kind,
    // its item id and the input it was called with; rewriting the input is a
    // rewrite of the occurrence, not an extension of the timeline.
    scenario.host.emit({
      type: "run.updated",
      run: runningRun({
        runId: "r-1",
        sessionId: "s-1",
        submissionId: "sub-1",
        live: [toolItem({ itemId: "i-1", invocationId: "inv-1", name: "original", input: { kind: "json", value: { step: 2 } } })],
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
    expect(scenario.client.getSnapshot().live["r-1"]).toMatchObject({
      status: "running",
      live: [{ itemId: "i-1", kind: "text", text: "hello world" }],
    });
  });
});
