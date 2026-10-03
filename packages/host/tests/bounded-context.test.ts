/**
 * M2 acceptance at the host's boundary: what a run records before it can be
 * sent, what a long conversation costs, and what happens when a tool's own
 * result cannot be part of an honest turn.
 *
 * These are the assertions a Core-level test cannot make. "No durable record
 * was written" is a claim about storage; "the session is blocked" is a claim
 * about the host's own state; and "the old canonical is unchanged" is a claim
 * about a commit that did not happen.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defineModelBudget, estimateRequestCost } from "@every-dagent/agent-core";
import type { ModelLimits } from "@every-dagent/agent-core";

import { TEST_MODEL_LIMITS } from "../../../tests/helpers/model-limits.js";

import { encodeStoredData, type Repository, type StoredRecord } from "../src/repository.js";
import {
  awaitRunTerminal,
  composeTestHost,
  connect,
  createSessionThrough,
  nextId,
  recordingTool,
  scriptedModel,
  testPlugin,
  textReply,
  toolReply,
} from "./helpers/harness.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A path inside a fresh temporary directory. */
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-m2-"));
  tempDirs.push(dir);
  return join(dir, "store.db");
}

/** A capability whose whole input budget is `maxInputCost`. */
function tightLimits(maxInputCost: number): ModelLimits {
  return { contextWindow: maxInputCost + 1024 + 1024, maxOutputTokens: 1024, framing: TEST_MODEL_LIMITS.framing };
}

// ---------------------------------------------------------------------------
// Admission preflight.
// ---------------------------------------------------------------------------

describe("admission preflight", () => {
  it("refuses an input no run under this profile could send, before anything durable", async () => {
    const limits = tightLimits(400);
    const model = scriptedModel([textReply("never reached")], { limits });
    const composed = composeTestHost({ modelClient: model.client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });

    const client = connect(composed.host);
    await client.describe();
    const before = {
      revisions: composed.repository.revisions,
      historyRevision: composed.repository.getSession("s-1")?.historyRevision,
      submitted: composed.repository.getSubmission("impossible-sub"),
    };

    const refused = await client.call("runs.start", {
      sessionId: "s-1",
      submissionId: "impossible-sub",
      text: "an input far too large for this model's window".repeat(20),
    });

    expect(refused.error?.code).toBe("LIMIT_EXCEEDED");
    // Nothing durable: no submission, no run, no revision moved, no session
    // pointer taken, no canonical fact.
    expect(composed.repository.getSubmission("impossible-sub")).toEqual(before.submitted);
    expect(composed.repository.revisions).toEqual(before.revisions);
    expect(composed.repository.getSession("s-1")?.activeRunId).toBeNull();
    expect(composed.repository.getSession("s-1")?.committedSeq).toBe(0);
    expect(composed.repository.getSession("s-1")?.historyRevision).toBe(before.historyRevision);
    expect(composed.repository.listUnfinishedRuns()).toHaveLength(0);
    expect(composed.repository.listRunsBySession("s-1", 10, null).records).toHaveLength(0);
    // And nothing ran: no model call, no canonical fact, no committed turn.
    expect(model.requests).toEqual([]);
    expect(composed.repository.readHistory("s-1", Number.MAX_SAFE_INTEGER, 10).records).toHaveLength(0);

    client.detach();
    await composed.host.shutdown();
  });

  it("leaves the execution lease free for the next run", async () => {
    const limits = tightLimits(400);
    const model = scriptedModel([textReply("answered")], { limits });
    const composed = composeTestHost({ modelClient: model.client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    composed.repository.createSession({ sessionId: "s-2", title: "t", createdAt: 2 });

    const client = connect(composed.host);
    await client.describe();

    const refused = await client.call("runs.start", {
      sessionId: "s-1",
      submissionId: "too-big-sub",
      text: "x".repeat(2000),
    });
    expect(refused.error?.code).toBe("LIMIT_EXCEEDED");

    // A refusal that held the token would answer HOST_BUSY here.
    const accepted = await client.call("runs.start", {
      sessionId: "s-2",
      submissionId: "fine-sub",
      text: "hi",
    });
    expect(accepted.error).toBeUndefined();
    await awaitRunTerminal(client, accepted.result?.run.runId as string);

    expect(model.requests).toHaveLength(1);

    client.detach();
    await composed.host.shutdown();
  });

  it("does not consume the submission identity it refused", async () => {
    const limits = tightLimits(400);
    const model = scriptedModel([textReply("answered")], { limits });
    const composed = composeTestHost({ modelClient: model.client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });

    const client = connect(composed.host);
    await client.describe();

    expect(
      (await client.call("runs.start", { sessionId: "s-1", submissionId: "reused-sub", text: "y".repeat(2000) }))
        .error?.code,
    ).toBe("LIMIT_EXCEEDED");

    // The refused request recorded nothing, so the id is still free — a written
    // submission would answer SUBMISSION_CONFLICT here.
    const accepted = await client.call("runs.start", { sessionId: "s-1", submissionId: "reused-sub", text: "hi" });
    expect(accepted.error).toBeUndefined();
    await awaitRunTerminal(client, accepted.result?.run.runId as string);

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Long conversations.
// ---------------------------------------------------------------------------

/** One finished turn written straight into storage, the way a host would. */
function seedTurn(repository: Repository, sessionId: string, index: number): void {
  const runId = `seed-run-${index}`;
  const session = repository.getSession(sessionId);
  const accepted = repository.admitRun({
    runId,
    submissionId: `seed-sub-${index}`,
    sessionId,
    text: `question ${index}`,
    inputHash: `seed-hash-${index}`,
    hostInstanceId: "seed-host",
    acceptedAt: 1_700_000_000_000 + index * 10,
  });
  if (accepted.kind !== "admitted") throw new Error(`seed admission refused: ${accepted.kind}`);
  repository.markRunStarted(runId, "seed-host", 1_700_000_000_001 + index * 10);
  const startSeq = session?.committedSeq ?? 0;
  repository.commitTurn({
    runId,
    sessionId,
    turnId: `turn-${index}`,
    reason: "completed",
    turnStartSeq: startSeq,
    records: seedRecords(`turn-${index}`, startSeq, `question ${index}`, `answer ${index}`),
    endedAt: 1_700_000_000_002 + index * 10,
  });
}

function seedRecords(turnId: string, startSeq: number, text: string, answer: string): StoredRecord[] {
  const events = [
    { type: "turn/start" as const, data: {} },
    { type: "message/user" as const, data: { text } },
    { type: "message/assistant" as const, data: { text: answer, toolCalls: [] } },
    { type: "turn/end" as const, data: { reason: "completed" as const } },
  ];
  return events.map((event, offset) =>
    Object.freeze({
      seq: startSeq + offset,
      turnId,
      type: event.type,
      time: 1_700_000_000_000 + startSeq + offset,
      data: encodeStoredData({ type: event.type, turnId, seq: startSeq + offset, time: 0, data: event.data } as never),
    }),
  );
}

describe("long conversations", () => {
  it("sends a bounded, in-budget request after a hundred and twenty turns", async () => {
    const model = scriptedModel([textReply("ok")]);
    const composed = composeTestHost({ modelClient: model.client });
    composed.repository.createSession({ sessionId: "s-long", title: "t", createdAt: 1 });
    for (let index = 1; index <= 120; index += 1) seedTurn(composed.repository, "s-long", index);
    expect(composed.repository.getSession("s-long")?.committedSeq).toBe(480);

    const client = connect(composed.host);
    await client.describe();
    const started = await client.call("runs.start", {
      sessionId: "s-long",
      submissionId: nextId("live-sub"),
      text: "one more",
    });
    expect(started.error).toBeUndefined();
    await awaitRunTerminal(client, started.result?.run.runId as string);

    const request = model.requests[0];
    expect(request).toBeDefined();
    const budget = defineModelBudget(model.client.limits);
    expect(estimateRequestCost(request as never, model.client.limits)).toBeLessThanOrEqual(budget.maxInputCost);
    expect(request?.maxOutputTokens).toBe(budget.reservedOutput);
    // The whole conversation is in storage; only a bounded suffix travels.
    expect(request?.messages.length).toBeGreaterThan(0);
    expect(request?.messages.length).toBeLessThan(48);

    client.detach();
    await composed.host.shutdown();
  });

  it("selects the same window for the same committed history, on a fresh host", async () => {
    // Two independent stores, each seeded with the same forty committed turns,
    // each driven by its own host: nothing about a selection may depend on which
    // process asked, which store answered, or what was in memory before.
    const runOnce = async (): Promise<readonly unknown[]> => {
      const path = storePath();
      const seeding = composeTestHost({ modelClient: scriptedModel([textReply("ok")]).client, location: path });
      seeding.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
      for (let index = 1; index <= 40; index += 1) seedTurn(seeding.repository, "s-1", index);
      await seeding.host.shutdown();

      const model = scriptedModel([textReply("ok")]);
      const composed = composeTestHost({ modelClient: model.client, location: path });
      const client = connect(composed.host);
      await client.describe();
      const started = await client.call("runs.start", {
        sessionId: "s-1",
        submissionId: nextId("restart-sub"),
        text: "one more",
      });
      expect(started.error).toBeUndefined();
      await awaitRunTerminal(client, started.result?.run.runId as string);
      client.detach();
      await composed.host.shutdown();
      return (model.requests[0] as { messages: readonly unknown[] }).messages;
    };

    const one = await runOnce();
    const two = await runOnce();

    expect(one.length).toBeGreaterThan(0);
    expect(two).toEqual(one);
  });

  it("keeps the window bounded and in budget across a restart", async () => {
    const path = storePath();
    const limits = tightLimits(3000);
    const seeding = composeTestHost({ modelClient: scriptedModel([textReply("ok")]).client, location: path });
    seeding.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    for (let index = 1; index <= 20; index += 1) seedTurn(seeding.repository, "s-1", index);
    await seeding.host.shutdown();

    const model = scriptedModel([textReply("ok")], { limits });
    const composed = composeTestHost({ modelClient: model.client, location: path });
    const client = connect(composed.host);
    await client.describe();
    const started = await client.call("runs.start", {
      sessionId: "s-1",
      submissionId: nextId("restart-sub"),
      text: "one more",
    });
    expect(started.error).toBeUndefined();
    await awaitRunTerminal(client, started.result?.run.runId as string);

    // A narrow window still holds whole committed turns, and the request the
    // model received is inside the budget the restarted host derived.
    const request = model.requests[0];
    expect(request?.messages.length).toBeGreaterThan(0);
    expect(request?.messages.length).toBeLessThan(24);
    expect(estimateRequestCost(request as never, limits)).toBeLessThanOrEqual(defineModelBudget(limits).maxInputCost);

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// A tool result the turn cannot keep.
// ---------------------------------------------------------------------------

describe("a result that cannot be kept", () => {
  it("keeps the old canonical, blocks the session, and closes no turn", async () => {
    const executed: unknown[] = [];
    const model = scriptedModel([toolReply("call-1", "big", { n: 1 }), textReply("never reached")]);
    const composed = composeTestHost({
      // The tool exists and runs; what it returns is larger than one turn item
      // may hold, which is a fact only known after it has run.
      plugins: [testPlugin({ id: "m2", tools: [recordingTool("big", executed, "x".repeat(70 * 1024))] })],
      modelClient: model.client,
    });

    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "m2" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("overflow-sub"),
      text: "give me something enormous",
    });
    expect(started.error).toBeUndefined();
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);

    expect(terminal.status).toBe("failed");
    expect(terminal.error?.code).toBe("INTERNAL_ERROR");
    // The tool really ran: the fault is about what happened, not about what was
    // refused before it could.
    expect(executed).toEqual([{ n: 1 }]);
    // The session stops — the host will not execute against a turn it could not
    // keep — and no turn was committed for the run.
    expect(composed.repository.getSession(session.sessionId)?.status).toBe("blocked");
    expect(composed.repository.getSession(session.sessionId)?.committedSeq).toBe(0);
    expect(composed.repository.getSession(session.sessionId)?.historyRevision).toBe(0);
    expect(composed.repository.readHistory(session.sessionId, Number.MAX_SAFE_INTEGER, 10).records).toHaveLength(0);

    client.detach();
    await composed.host.shutdown();
  });

  it("leaves a previous turn's canonical exactly as it was", async () => {
    const executed: unknown[] = [];
    const model = scriptedModel([
      textReply("the first answer"),
      toolReply("call-1", "big", { n: 1 }),
      textReply("never reached"),
    ]);
    const composed = composeTestHost({
      plugins: [testPlugin({ id: "m2", tools: [recordingTool("big", executed, "x".repeat(70 * 1024))] })],
      modelClient: model.client,
    });

    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "m2" });
    const session = await createSessionThrough(client);

    const first = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("first-sub"),
      text: "answer me first",
    });
    await awaitRunTerminal(client, first.result?.run.runId as string);
    const afterFirst = composed.repository.readHistory(session.sessionId, Number.MAX_SAFE_INTEGER, 50).records;
    expect(afterFirst.length).toBeGreaterThan(0);

    const second = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("overflow-sub"),
      text: "now something enormous",
    });
    expect(second.error).toBeUndefined();
    await awaitRunTerminal(client, second.result?.run.runId as string);

    // The committed canonical is untouched: the turn that could not be kept was
    // never written, and the one before it still reads exactly as it did.
    expect(composed.repository.readHistory(session.sessionId, Number.MAX_SAFE_INTEGER, 50).records).toEqual(afterFirst);
    expect(executed).toEqual([{ n: 1 }]);

    client.detach();
    await composed.host.shutdown();
  });
});

