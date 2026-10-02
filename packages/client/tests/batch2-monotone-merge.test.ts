/**
 * Batch 2 — C3: the client merges durable projections monotonically.
 *
 * A late answer may not move the replica backwards: a deleted session stays
 * deleted, a page that lands below what is loaded is dropped, a replacement
 * still reports the gap the directory knows about, an answer from an older cut
 * resolves its caller without touching the presentation, content that cannot be
 * placed is dropped and repaired instead of ending the connection, and a
 * timeline read never re-opens a run the directory has called terminal.
 */

import { describe, expect, it } from "vitest";

import type { CanonicalItem, HistoryPage } from "@every-dagent/protocol";

import { createScenario, flush, openWith } from "./helpers/scenario.js";
import {
  completedRun,
  runningRun,
  sessionPage,
  sessionSummary,
  textItem,
} from "./helpers/values.js";

function itemAt(seq: number, text = `item ${seq}`): CanonicalItem {
  return { id: `s-1:${seq}`, turnId: "turn-1", seq, kind: "user", text };
}

function page(parts: {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly atStart: boolean;
  readonly nextCursor: string | null;
  readonly items: readonly CanonicalItem[];
  readonly fenceSeq?: number;
  readonly atFence?: boolean;
  readonly historyRevision?: number;
}): HistoryPage {
  return {
    storageId: "st-1",
    sessionId: "s-1",
    generation: 1,
    historyRevision: parts.historyRevision ?? 1,
    fenceSeq: parts.fenceSeq ?? 10,
    direction: "backward",
    items: parts.items,
    coverage: { fromSeq: parts.fromSeq, toSeq: parts.toSeq },
    startsAtTurnBoundary: true,
    endsAtTurnBoundary: true,
    atStart: parts.atStart,
    atFence: parts.atFence ?? false,
    nextCursor: parts.nextCursor,
  };
}

const RUN = runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" });
const ACTIVE = sessionSummary({ sessionId: "s-1", activeRunId: "r-1" });

describe("C3 late history answers", () => {
  it("does not resurrect a deleted session's cache, and still answers its caller", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([sessionSummary({ sessionId: "s-1" })]) });

    const inFlight = scenario.client.sessions.history({ sessionId: "s-1" });
    await flush();
    const requestId = scenario.host.requestIdOf("sessions.history");

    scenario.host.emit({
      type: "session.deleted",
      sessionId: "s-1",
      generation: 1,
      collections: { sessions: 2, runs: 2, plugins: 1 },
    });
    await flush();
    expect(scenario.client.getSnapshot().history["s-1"]).toBeUndefined();

    scenario.host.respond(requestId!, "sessions.history", {
      page: page({ fromSeq: 4, toSeq: 5, atStart: false, nextCursor: "below", items: [itemAt(4)] }),
    });
    const answered = await inFlight;
    await flush();

    // The caller it was asked by hears the answer...
    expect(answered.page.coverage.toSeq).toBe(5);
    // ...and the replica keeps the deletion it was told about.
    expect(scenario.client.getSnapshot().history["s-1"]).toBeUndefined();
  });

  it("drops a page that lands entirely below the loaded coverage", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([sessionSummary({ sessionId: "s-1" })]) });

    const first = scenario.client.sessions.history({ sessionId: "s-1" });
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.history")!, "sessions.history", {
      page: page({ fromSeq: 10, toSeq: 10, atStart: false, nextCursor: "below", items: [], atFence: true }),
    });
    await first;
    await flush();
    expect(scenario.client.getSnapshot().history["s-1"]?.fromSeq).toBe(10);

    // A smaller traversal's page arrives late: adopting it would strand the
    // coverage this client already read above it.
    const stale = scenario.client.sessions.history({ sessionId: "s-1", cursor: "older" });
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.history", 1)!, "sessions.history", {
      page: page({ fromSeq: 5, toSeq: 5, atStart: false, nextCursor: "below", items: [], fenceSeq: 5, atFence: true }),
    });
    await stale;
    await flush();

    const coverage = scenario.client.getSnapshot().history["s-1"];
    expect(coverage?.fromSeq).toBe(10);
    expect(coverage?.toSeq).toBe(10);
    expect(coverage?.fenceSeq).toBe(10);
  });

  it("keeps the gap the directory knows about when a page replaces the loaded range", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, {
      sessions: sessionPage([sessionSummary({ sessionId: "s-1", committedSeq: 20, historyRevision: 3 })]),
    });

    const first = scenario.client.sessions.history({ sessionId: "s-1" });
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.history")!, "sessions.history", {
      page: page({ fromSeq: 0, toSeq: 4, atStart: true, nextCursor: null, items: [itemAt(1)], fenceSeq: 20 }),
    });
    await first;
    await flush();
    expect(scenario.client.getSnapshot().history["s-1"]?.behind).toBe(true);

    // A page from another fence replaces what is loaded; the high-water the
    // directory holds still says the conversation continues past it.
    const second = scenario.client.sessions.history({ sessionId: "s-1", cursor: "other" });
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.history", 1)!, "sessions.history", {
      page: page({ fromSeq: 5, toSeq: 9, atStart: false, nextCursor: "below", items: [itemAt(6)], fenceSeq: 9, atFence: true }),
    });
    await second;
    await flush();

    const coverage = scenario.client.getSnapshot().history["s-1"];
    expect(coverage?.fromSeq).toBe(5);
    expect(coverage?.toSeq).toBe(9);
    expect(coverage?.behind).toBe(true);
  });

  it("answers an older cut's page without letting it touch the new cut's replica", async () => {
    const scenario = createScenario({ host: { auto: true } });
    await scenario.ready();

    const inFlight = scenario.client.sessions.history({ sessionId: "s-1" });
    await flush();
    const requestId = scenario.host.requestIdOf("sessions.history");

    await scenario.client.resync();
    await flush();
    expect(scenario.client.getSnapshot().history["s-1"]).toBeUndefined();

    scenario.host.respond(requestId!, "sessions.history", {
      page: page({ fromSeq: 0, toSeq: 4, atStart: true, nextCursor: null, items: [itemAt(1)] }),
    });
    const answered = await inFlight;
    await flush();

    expect(answered.page.coverage.toSeq).toBe(4);
    expect(scenario.client.getSnapshot().history["s-1"]).toBeUndefined();
  });
});

describe("C3 live placement", () => {
  it("cannot be re-opened by a late timeline answer after the directory says terminal", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, {
      sessions: sessionPage([ACTIVE]),
      runs: { items: [RUN], collectionRevision: 1, nextCursor: null, hasMore: false },
    });
    await flush();
    const requestId = scenario.host.requestIdOf("runs.get");
    expect(requestId).toBeDefined();

    scenario.host.emit({
      type: "run.ended",
      run: completedRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }),
      session: sessionSummary({ sessionId: "s-1", activeRunId: null, committedSeq: 4, historyRevision: 1 }),
      collections: { sessions: 2, runs: 2, plugins: 1 },
    });
    await flush();
    expect(scenario.client.getSnapshot().presentation?.runs.items[0]?.status).toBe("completed");

    scenario.host.respond(requestId!, "runs.get", { run: RUN });
    await flush();

    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.live["r-1"]).toBeUndefined();
    expect(snapshot.presentation?.runs.items[0]?.status).toBe("completed");
  });

  it("drops unplaceable content, asks once, and places the run from the answer", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, {
      sessions: sessionPage([ACTIVE]),
      runs: { items: [RUN], collectionRevision: 1, nextCursor: null, hasMore: false },
    });
    await flush();
    const refresh = scenario.host.requestIdOf("runs.get");
    expect(refresh).toBeDefined();

    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-1", text: "one" });
    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-1", text: "two" });
    await flush();

    // Dropped, not fatal — and the two of them did not stack a second read.
    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(scenario.client.getSnapshot().live["r-1"]).toBeUndefined();
    expect(scenario.host.requests.filter((request) => request.method === "runs.get")).toHaveLength(1);

    scenario.host.respond(refresh!, "runs.get", {
      run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1", live: [textItem("i-1", "onetwo")] }),
    });
    await flush();

    const placed = scenario.client.getSnapshot().live["r-1"];
    expect(placed?.status).toBe("running");
    expect(placed?.liveTruncated).toBe(false);
    expect(placed?.live.map((entry) => (entry.kind === "text" ? entry.text : ""))).toEqual(["onetwo"]);

    // Once placed, content follows the ordinary path again.
    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "i-1", text: "-more" });
    await flush();
    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(
      scenario.client.getSnapshot().live["r-1"]?.live.map((entry) => (entry.kind === "text" ? entry.text : "")),
    ).toEqual(["onetwo-more"]);
  });
});

describe("C3 immutable responses", () => {
  it("keeps a returned history page from reaching into the loaded coverage", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario, { sessions: sessionPage([sessionSummary({ sessionId: "s-1" })]) });

    const inFlight = scenario.client.sessions.history({ sessionId: "s-1" });
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.history")!, "sessions.history", {
      page: page({ fromSeq: 0, toSeq: 4, atStart: true, nextCursor: null, items: [itemAt(1, "original")] }),
    });
    const answered = await inFlight;
    await flush();

    const item = answered.page.items[0] as { text: string };
    expect(Object.isFrozen(item)).toBe(true);
    expect(scenario.client.getSnapshot().history["s-1"]?.items[0]?.kind).toBe("user");
    const before = scenario.client.getSnapshot().history["s-1"]?.items[0];
    try {
      item.text = "TAMPERED";
    } catch {
      // A frozen node refuses the write; either way the replica is untouched.
    }
    expect(scenario.client.getSnapshot().history["s-1"]?.items[0]).toBe(before);
    expect((before as { text: string }).text).toBe("original");
  });
});
