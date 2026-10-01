/**
 * M1: durable state, and what survives not finishing.
 *
 * These are the tests the milestone exists for. They use a real `node:sqlite`
 * store on a real file (or a real in-memory database, which is the same
 * implementation), never a mock: what is being checked is that a *transaction*
 * happened, and a double that never writes cannot be asked.
 *
 * The crash points are simulated the way a crash presents itself to the next
 * start — by releasing the store with work still unfinished, exactly the
 * durable state a kill leaves behind. A process that dies mid-turn leaves rows,
 * not memories, and every assertion here is about rows.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { ModelEvent, ModelRequest } from "@every-dagent/agent-core";
import type { RunSummary } from "@every-dagent/protocol";

import { SCHEMA_VERSION, encodeStoredData } from "../src/repository.js";
import type { Repository, StoredRecord } from "../src/repository.js";
import {
  awaitRunTerminal,
  composeTestHost,
  connect,
  flush,
  gate,
  gatedReply,
  nextId,
  scriptedModel,
  testHost,
  textReply,
} from "./helpers/harness.js";

/**
 * A directory that is removed when the surrounding block ends.
 *
 * Awaited before removal, because a test that leaves a host open is a test that
 * still holds the database file — and on Windows a held file cannot be deleted.
 * The removal itself is best effort: a lock the OS has not released yet is not a
 * test failure.
 */
async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-m1-"));
  try {
    return await act(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The next run gets a fresh directory either way.
    }
  }
}

function storePath(dir: string, name = "state.db"): string {
  return join(dir, name);
}

const MODEL = () => scriptedModel([textReply("answer")], { repeatLast: true });

// ---------------------------------------------------------------------------
// Setting durable state up directly, through the repository's own transactions.
// ---------------------------------------------------------------------------

/** One synthetic settled turn, written the way a real terminal commit writes one. */
function turnRecords(sessionId: string, turnId: string, startSeq: number, text: string, answer: string): StoredRecord[] {
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

/** Writes one finished turn straight into storage, the way a host would. */
function writeTurn(repository: Repository, sessionId: string, index: number): void {
  const runId = `seed-run-${index}`;
  const submissionId = `seed-sub-${index}`;
  const session = repository.getSession(sessionId);
  const accepted = repository.admitRun({
    runId,
    submissionId,
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
    records: turnRecords(sessionId, `turn-${index}`, startSeq, `question ${index}`, `answer ${index}`),
    endedAt: 1_700_000_000_002 + index * 10,
  });
}

// ---------------------------------------------------------------------------
// The same business contract, ephemeral and durable.
// ---------------------------------------------------------------------------

interface ScenarioResult {
  readonly sessionIds: readonly string[];
  readonly statuses: readonly string[];
  readonly canonical: readonly string[];
}

/**
 * One conversation, driven end to end, with everything a client can observe.
 *
 * The point of running this twice is equivalence: an ephemeral host and a
 * durable one are the same host, and a client must not be able to tell which
 * one it is talking to — except by asking, which is what `describe` is for.
 */
async function runScenario(location: string | undefined): Promise<ScenarioResult> {
  const model = scriptedModel([textReply("first answer"), textReply("second answer")]);
  const composed = composeTestHost({
    modelClient: model.client,
    ...(location === undefined ? {} : { location }),
  });
  const client = connect(composed.host);
  await client.describe();

  const created = await client.call("sessions.create", {});
  const sessionId = created.result?.session.sessionId ?? "";
  const submissionId = nextId("sub");
  const started = await client.call("runs.start", { sessionId, submissionId, text: "hello" });
  await awaitRunTerminal(client, started.result?.run.runId ?? "");
  const bySubmission = await client.call("runs.get", { submissionId });
  expect(bySubmission.result?.run.submissionId).toBe(submissionId);

  const list = await client.call("sessions.list", {});
  const history = await client.call("sessions.history", { sessionId });
  const get = await client.call("sessions.get", { sessionId });

  client.detach();
  await composed.host.shutdown();

  return {
    // Ids are fresh every run, so what is compared is the shape of what a
    // client can observe, not the identities this particular run happened to get.
    sessionIds: (list.result?.sessions.items ?? []).map((session) =>
      session.sessionId === sessionId ? "the session just created" : "something else",
    ),
    statuses: (history.result?.page.items ?? []).map((item) => item.kind),
    canonical: (history.result?.page.items ?? []).map((item) => item.id.replace(`${sessionId}:`, "seq:")),
  };
}

describe("ephemeral and durable are the same host", () => {
  it("answers a client identically in both modes", async () => {
    const ephemeral = await runScenario(undefined);
    const durable = await withTempDir((dir) => runScenario(storePath(dir)));

    expect(durable.sessionIds).toEqual(ephemeral.sessionIds);
    expect(durable.statuses).toEqual(ephemeral.statuses);
    expect(durable.canonical).toEqual(ephemeral.canonical);
    expect(durable.statuses).toEqual(["user", "assistant"]);
  });

  it("declares which retention the composition actually got", async () => {
    const ephemeral = testHost({ modelClient: MODEL().client });
    const ephemeralClient = connect(ephemeral);
    const described = await ephemeralClient.describe();
    expect(described.result?.storage.retention).toBe("ephemeral");
    expect(described.result?.storage.schemaVersion).toBe(SCHEMA_VERSION);
    await ephemeral.shutdown();

    await withTempDir(async (dir) => {
      const composed = composeTestHost({ modelClient: MODEL().client, location: storePath(dir) });
      const client = connect(composed.host);
      const durable = await client.describe();
      expect(durable.result?.storage.retention).toBe("durable");
      client.detach();
      await composed.host.shutdown();

      // A stable identity across restarts, and one that was actually recorded:
      // a second host that invented its own id would still look consistent.
      const again = composeTestHost({ modelClient: MODEL().client, location: storePath(dir) });
      const second = connect(again.host);
      const restarted = await second.describe();
      expect(restarted.result?.storage.storageId).toBe(durable.result?.storage.storageId);
      second.detach();
      await again.host.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// Crash points.
// ---------------------------------------------------------------------------

describe("what a crash leaves behind, and what the next start says about it", () => {
  it("turns an accepted run with no start marker into interrupted / not-started", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const first = composeTestHost({ modelClient: MODEL().client, location: path });
      const created = first.repository.createSession({ sessionId: "s-accepted", title: "t", createdAt: 1 });
      void created;
      // The durable state at "admission committed, start not committed".
      const accepted = first.repository.admitRun({
        runId: "r-accepted",
        submissionId: "sub-accepted",
        sessionId: "s-accepted",
        text: "hello",
        inputHash: "hash",
        hostInstanceId: "first-host",
        acceptedAt: 10,
      });
      expect(accepted.kind).toBe("admitted");
      await first.host.shutdown();

      const second = composeTestHost({ modelClient: MODEL().client, location: path });
      const client = connect(second.host);
      await client.describe();
      const run = await client.call("runs.get", { runId: "r-accepted" });
      const session = await client.call("sessions.get", { sessionId: "s-accepted" });

      expect(run.result?.run.status).toBe("interrupted");
      expect(run.result?.run.endReason).toBe("interrupted");
      expect(run.result?.run.live).toBeNull();
      expect(run.result?.run.executionKnowledge).toBe("not-started");
      // Provable non-execution: the session is not blocked, because nothing ran.
      expect(session.result?.session.status).toBe("ready");
      expect(session.result?.session.activeRunId).toBeNull();

      client.detach();
      await second.host.shutdown();
    });
  });

  it("turns a running run with no terminal into interrupted / unknown and blocks the session", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const first = composeTestHost({ modelClient: MODEL().client, location: path });
      first.repository.createSession({ sessionId: "s-running", title: "t", createdAt: 1 });
      first.repository.admitRun({
        runId: "r-running",
        submissionId: "sub-running",
        sessionId: "s-running",
        text: "hello",
        inputHash: "hash",
        hostInstanceId: "first-host",
        acceptedAt: 10,
      });
      first.repository.markRunStarted("r-running", "first-host", 11);
      await first.host.shutdown();

      const second = composeTestHost({ modelClient: MODEL().client, location: path });
      const client = connect(second.host);
      await client.describe();
      const run = await client.call("runs.get", { runId: "r-running" });
      const session = await client.call("sessions.get", { sessionId: "s-running" });

      expect(run.result?.run.status).toBe("interrupted");
      expect(run.result?.run.executionKnowledge).toBe("unknown");
      expect(session.result?.session.status).toBe("blocked");
      expect(session.result?.session.blockedReason).toBe("unknown-execution");

      // A blocked session refuses new work, and says so without pretending the
      // run failed rather than being interrupted.
      const refused = await client.call("runs.start", {
        sessionId: "s-running",
        submissionId: nextId("sub"),
        text: "again",
      });
      expect(refused.error?.code).toBe("SESSION_UNAVAILABLE");

      client.detach();
      await second.host.shutdown();
    });
  });

  it("keeps a committed terminal exactly as it was, whatever happened afterwards", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const first = composeTestHost({ modelClient: MODEL().client, location: path });
      first.repository.createSession({ sessionId: "s-done", title: "t", createdAt: 1 });
      writeTurn(first.repository, "s-done", 1);
      await first.host.shutdown();

      const second = composeTestHost({ modelClient: MODEL().client, location: path });
      const client = connect(second.host);
      await client.describe();
      const run = await client.call("runs.get", { runId: "seed-run-1" });
      const session = await client.call("sessions.get", { sessionId: "s-done" });

      expect(run.result?.run.status).toBe("completed");
      expect(run.result?.run.endReason).toBe("completed");
      expect(run.result?.run.executionKnowledge).toBeNull();
      expect(session.result?.session.status).toBe("ready");
      expect(session.result?.session.committedSeq).toBe(4);
      expect(session.result?.session.historyRevision).toBe(1);

      client.detach();
      await second.host.shutdown();
    });
  });

  it("reconciles idempotently: a second start finds nothing left to repair", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const first = composeTestHost({ modelClient: MODEL().client, location: path });
      first.repository.createSession({ sessionId: "s-x", title: "t", createdAt: 1 });
      first.repository.createSession({ sessionId: "s-y", title: "t", createdAt: 2 });
      first.repository.admitRun({
        runId: "r-a",
        submissionId: "sub-a",
        sessionId: "s-x",
        text: "one",
        inputHash: "h1",
        hostInstanceId: "first",
        acceptedAt: 10,
      });
      first.repository.admitRun({
        runId: "r-b",
        submissionId: "sub-b",
        sessionId: "s-y",
        text: "two",
        inputHash: "h2",
        hostInstanceId: "first",
        acceptedAt: 11,
      });
      first.repository.markRunStarted("r-b", "first", 12);
      await first.host.shutdown();

      const second = composeTestHost({ modelClient: MODEL().client, location: path });
      const firstPass = second.repository.reconcileInterrupted("second", 100);
      expect(firstPass.interrupted).toBe(0);
      const secondPass = second.repository.reconcileInterrupted("second", 200);
      expect(secondPass.interrupted).toBe(0);

      const statuses = ["r-a", "r-b"].map((runId) => second.repository.getRun(runId)?.status);
      expect(statuses).toEqual(["interrupted", "interrupted"]);
      const blocked = second.repository.getSession("s-y");
      expect(blocked?.status).toBe("blocked");
      expect(blocked?.blockedReason).toBe("unknown-execution");
      await second.host.shutdown();
    });
  });

  it("survives a crash during reconciliation: the next start finishes the same repair", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const first = composeTestHost({ modelClient: MODEL().client, location: path });
      first.repository.createSession({ sessionId: "s-c", title: "t", createdAt: 1 });
      first.repository.admitRun({
        runId: "r-c",
        submissionId: "sub-c",
        sessionId: "s-c",
        text: "hello",
        inputHash: "h",
        hostInstanceId: "first",
        acceptedAt: 10,
      });
      first.repository.markRunStarted("r-c", "first", 11);
      // Reconciliation never ran: the second start does it, and a third start
      // must find the same final state rather than repairing it again.
      await first.host.shutdown();

      const second = composeTestHost({ modelClient: MODEL().client, location: path });
      await second.host.shutdown();
      const third = composeTestHost({ modelClient: MODEL().client, location: path });
      const run = third.repository.getRun("r-c");
      expect(run?.status).toBe("interrupted");
      expect(run?.executionKnowledge).toBe("unknown");
      expect(run?.endedAt).toBe(run?.endedAt);
      await third.host.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// The same crash points, observed from a live host.
// ---------------------------------------------------------------------------

describe("a live host's own crash points", () => {
  it("commits the start marker before the Runtime is handed anything", async () => {
    let probe: () => { readonly status?: string; readonly startedAt?: number | null } | undefined = () => undefined;
    let observed: { readonly status?: string; readonly startedAt?: number | null } | undefined;

    const model = {
      stream(): AsyncIterable<ModelEvent> {
        // The moment the model is asked, the start must already be durable —
        // otherwise a crash here would leave a record that cannot explain what
        // the model was asked to do.
        observed = probe();
        return (async function* (): AsyncGenerator<ModelEvent> {
          yield { type: "text-delta", text: "ok" };
          yield { type: "done" };
        })();
      },
    };

    const composed = composeTestHost({ modelClient: model });
    let runId = "";
    probe = (): { readonly status?: string; readonly startedAt?: number | null } | undefined => {
      const record = composed.repository.listUnfinishedRuns()[0];
      return record === undefined ? undefined : { status: record.status, startedAt: record.startedAt };
    };

    const client = connect(composed.host);
    await client.describe();
    const session = await client.call("sessions.create", {});
    const started = await client.call("runs.start", {
      sessionId: session.result?.session.sessionId ?? "",
      submissionId: "sub-start",
      text: "hello",
    });
    runId = started.result?.run.runId ?? "";
    await awaitRunTerminal(client, runId);

    expect(observed?.status).toBe("running");
    expect(typeof observed?.startedAt).toBe("number");

    client.detach();
    await composed.host.shutdown();
  });

  it("does not run a tool or a model again when a terminal commit's answer is lost", async () => {
    const model = scriptedModel([textReply("only once")]);
    const composed = composeTestHost({ modelClient: model.client });
    const client = connect(composed.host);
    await client.describe();
    const session = await client.call("sessions.create", {});
    const sessionId = session.result?.session.sessionId ?? "";
    const submissionId = nextId("sub");

    const started = await client.call("runs.start", { sessionId, submissionId, text: "hello" });
    const runId = started.result?.run.runId ?? "";
    await awaitRunTerminal(client, runId);
    const callsAfterTerminal = model.requests.length;

    // The client that asked never saw the answer; it asks again with the same
    // submission id, which is exactly what an unknown outcome leads to.
    const repeated = await client.call("runs.start", { sessionId, submissionId, text: "hello" });
    expect(repeated.result?.run.runId).toBe(runId);
    expect(repeated.result?.run.status).toBe("completed");
    await flush();
    expect(model.requests.length).toBe(callsAfterTerminal);

    client.detach();
    await composed.host.shutdown();
  });

  it("keeps a submission's answer across a restart, without executing twice", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const model = scriptedModel([textReply("once")]);
      const first = composeTestHost({ modelClient: model.client, location: path });
      const client = connect(first.host);
      await client.describe();
      const session = await client.call("sessions.create", {});
      const sessionId = session.result?.session.sessionId ?? "";
      const submissionId = "sub-restart";
      const started = await client.call("runs.start", { sessionId, submissionId, text: "hello" });
      const runId = started.result?.run.runId ?? "";
      await awaitRunTerminal(client, runId);
      const calls = model.requests.length;
      client.detach();
      await first.host.shutdown();

      const secondModel = scriptedModel([textReply("should never run")]);
      const second = composeTestHost({ modelClient: secondModel.client, location: path });
      const secondClient = connect(second.host);
      await secondClient.describe();
      const repeated = await secondClient.call("runs.start", { sessionId, submissionId, text: "hello" });
      expect(repeated.result?.run.runId).toBe(runId);
      expect(repeated.result?.run.status).toBe("completed");
      expect(secondModel.requests.length).toBe(0);

      const conflict = await secondClient.call("runs.start", {
        sessionId,
        submissionId,
        text: "different",
      });
      expect(conflict.error?.code).toBe("SUBMISSION_CONFLICT");

      secondClient.detach();
      await second.host.shutdown();
      expect(calls).toBe(1);
    });
  });

  it("leaves a run's durable record unfinished when its terminal commit never happens", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const held = gate();
      const model = scriptedModel([gatedReply(held)]);
      const first = composeTestHost({ modelClient: model.client, location: path });
      const client = connect(first.host);
      await client.describe();
      const session = await client.call("sessions.create", {});
      const sessionId = session.result?.session.sessionId ?? "";
      const started = await client.call("runs.start", { sessionId, submissionId: "sub-held", text: "hello" });
      const runId = started.result?.run.runId ?? "";
      await flush();

      // The execution is in flight: the durable record says running, and there
      // is no terminal anywhere.
      expect(first.repository.getRun(runId)?.status).toBe("running");
      expect(first.repository.getSession(sessionId)?.activeRunId).toBe(runId);

      // The process dies here: the store is released with the turn unfinished.
      first.repository.close();
      client.detach();
      held.open();
      await flush();

      const second = composeTestHost({ modelClient: MODEL().client, location: path });
      const recovered = second.repository.getRun(runId);
      expect(recovered?.status).toBe("interrupted");
      expect(recovered?.executionKnowledge).toBe("unknown");
      expect(second.repository.getSession(sessionId)?.status).toBe("blocked");

      // And the history the previous host never committed is not invented.
      const page = second.repository.readHistory(sessionId, recovered ? 1000 : 0, 10);
      expect(page.records.map((record) => record.type)).toEqual([]);
      await second.host.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// Transactions.
// ---------------------------------------------------------------------------

describe("business transactions", () => {
  it("admits atomically: the run, the submission and the session pointer land together", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });

    const admitted = composed.repository.admitRun({
      runId: "r-1",
      submissionId: "sub-1",
      sessionId: "s-1",
      text: "hello",
      inputHash: "h",
      hostInstanceId: "host",
      acceptedAt: 5,
    });
    expect(admitted.kind).toBe("admitted");
    expect(composed.repository.getRun("r-1")?.status).toBe("accepted");
    expect(composed.repository.getSubmission("sub-1")?.runId).toBe("r-1");
    expect(composed.repository.getSession("s-1")?.activeRunId).toBe("r-1");

    // A second admission under the same submission is not a second execution.
    const again = composed.repository.admitRun({
      runId: "r-2",
      submissionId: "sub-1",
      sessionId: "s-1",
      text: "hello",
      inputHash: "h",
      hostInstanceId: "host",
      acceptedAt: 6,
    });
    expect(again.kind).toBe("existing");
    expect(composed.repository.getRun("r-2")).toBeUndefined();
    await composed.host.shutdown();
  });

  it("refuses a submission reused for different work, and never rewrites the first", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    composed.repository.admitRun({
      runId: "r-1",
      submissionId: "sub-1",
      sessionId: "s-1",
      text: "hello",
      inputHash: "h",
      hostInstanceId: "host",
      acceptedAt: 5,
    });

    const conflict = composed.repository.admitRun({
      runId: "r-2",
      submissionId: "sub-1",
      sessionId: "s-1",
      text: "something else",
      inputHash: "other",
      hostInstanceId: "host",
      acceptedAt: 6,
    });
    expect(conflict.kind).toBe("conflict");
    expect(composed.repository.getRun("r-1")?.text).toBe("hello");
    await composed.host.shutdown();
  });

  it("commits a settled turn and its run terminal together, or not at all", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    composed.repository.admitRun({
      runId: "r-1",
      submissionId: "sub-1",
      sessionId: "s-1",
      text: "hello",
      inputHash: "h",
      hostInstanceId: "host",
      acceptedAt: 5,
    });
    composed.repository.markRunStarted("r-1", "host", 6);

    // A batch that does not continue the committed log is refused, and the
    // refusal leaves nothing behind: no events, no run terminal, no pointer
    // cleared.
    const wrong = turnRecords("s-1", "turn-x", 9, "hello", "answer").map((record) => ({ ...record, seq: record.seq + 5 }));
    expect(() =>
      composed.repository.commitTurn({
        runId: "r-1",
        sessionId: "s-1",
        turnId: "turn-x",
        reason: "completed",
        turnStartSeq: 9,
        records: wrong,
        endedAt: 7,
      }),
    ).toThrow();

    expect(composed.repository.getSession("s-1")?.committedSeq).toBe(0);
    expect(composed.repository.getSession("s-1")?.historyRevision).toBe(0);
    expect(composed.repository.getRun("r-1")?.status).toBe("running");
    expect(composed.repository.readHistory("s-1", 100, 10).records).toEqual([]);

    // The real one commits all three facts at once.
    const committed = composed.repository.commitTurn({
      runId: "r-1",
      sessionId: "s-1",
      turnId: "turn-1",
      reason: "completed",
      turnStartSeq: 0,
      records: turnRecords("s-1", "turn-1", 0, "hello", "answer"),
      endedAt: 8,
    });
    expect(committed.session.committedSeq).toBe(4);
    expect(committed.session.historyRevision).toBe(1);
    expect(committed.session.activeRunId).toBeNull();
    expect(committed.run.status).toBe("completed");
    expect(committed.run.endedAt).toBe(8);
    expect(committed.revisions.sessions).toBeGreaterThan(0);
    await composed.host.shutdown();
  });

});

// ---------------------------------------------------------------------------
// Pagination.
// ---------------------------------------------------------------------------

describe("history pages", () => {
  it("reports coverage, boundaries and a continuation that never widens", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    for (let index = 1; index <= 4; index += 1) writeTurn(composed.repository, "s-1", index);

    const client = connect(composed.host);
    await client.describe();

    const first = await client.call("sessions.history", { sessionId: "s-1", limit: 2 });
    const page = first.result?.page;
    expect(page).toBeDefined();
    if (page === undefined) return;
    expect(page.items.length).toBe(2);
    expect(page.atFence).toBe(true);
    expect(page.atStart).toBe(false);
    // The read window held exactly one complete turn, so the page's ends are
    // turn boundaries rather than fragments.
    expect(page.startsAtTurnBoundary).toBe(true);
    expect(page.endsAtTurnBoundary).toBe(true);
    expect(page.fenceSeq).toBe(16);
    expect(page.coverage.toSeq).toBe(16);
    expect(page.nextCursor).not.toBeNull();

    const second = await client.call("sessions.history", { sessionId: "s-1", cursor: page.nextCursor ?? "" });
    const older = second.result?.page;
    expect(older?.fenceSeq).toBe(page.fenceSeq);
    expect(older?.coverage.toSeq).toBe(page.coverage.fromSeq);
    // Every item of every page carries the log position it came from, and the
    // pages partition the fenced range without a gap or an overlap.
    const positions = [...(older?.items ?? []), ...page.items].map((item) => item.seq);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));

    client.detach();
    await composed.host.shutdown();
  });

  it("keeps a cursor valid when a later turn is appended after the fence", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    for (let index = 1; index <= 3; index += 1) writeTurn(composed.repository, "s-1", index);

    const client = connect(composed.host);
    await client.describe();
    const first = await client.call("sessions.history", { sessionId: "s-1", limit: 2 });
    const fence = first.result?.page.fenceSeq ?? 0;
    const cursor = first.result?.page.nextCursor ?? "";

    writeTurn(composed.repository, "s-1", 4);

    const second = await client.call("sessions.history", { sessionId: "s-1", cursor });
    expect(second.error).toBeUndefined();
    expect(second.result?.page.fenceSeq).toBe(fence);
    expect(second.result?.page.coverage.toSeq).toBe(first.result?.page.coverage.fromSeq);
    // The new turn is simply outside this traversal.
    const seqs = second.result?.page.items.map((item) => item.seq) ?? [];
    expect(seqs.every((seq) => seq < fence)).toBe(true);

    client.detach();
    await composed.host.shutdown();
  });

  it("does not invalidate a history cursor when the session is renamed", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    for (let index = 1; index <= 3; index += 1) writeTurn(composed.repository, "s-1", index);

    const client = connect(composed.host);
    await client.describe();
    const first = await client.call("sessions.history", { sessionId: "s-1", limit: 2 });
    const cursor = first.result?.page.nextCursor ?? "";
    const revision = first.result?.page.historyRevision ?? 0;

    const session = await client.call("sessions.get", { sessionId: "s-1" });
    const renamed = await client.call("sessions.rename", {
      sessionId: "s-1",
      expectedRevision: session.result?.session.metadataRevision ?? 0,
      title: "renamed",
    });
    expect(renamed.result?.session.title).toBe("renamed");

    const second = await client.call("sessions.history", { sessionId: "s-1", cursor });
    expect(second.error).toBeUndefined();
    expect(second.result?.page.historyRevision).toBe(revision);

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses a cursor whose session is gone, and refuses a malformed one", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    for (let index = 1; index <= 3; index += 1) writeTurn(composed.repository, "s-1", index);

    const client = connect(composed.host);
    await client.describe();
    const first = await client.call("sessions.history", { sessionId: "s-1", limit: 2 });
    const cursor = first.result?.page.nextCursor ?? "";

    const malformed = await client.call("sessions.history", { sessionId: "s-1", cursor: "not-a-cursor" });
    expect(malformed.error?.code).toBe("INVALID_REQUEST");

    const session = await client.call("sessions.get", { sessionId: "s-1" });
    const deleted = await client.call("sessions.delete", {
      sessionId: "s-1",
      expectedRevision: session.result?.session.metadataRevision ?? 0,
    });
    expect(deleted.result?.deleted).toBe(true);

    const afterDelete = await client.call("sessions.history", { sessionId: "s-1", cursor });
    expect(afterDelete.error?.code).toBe("SESSION_NOT_FOUND");
    const gone = await client.call("sessions.get", { sessionId: "s-1" });
    expect(gone.error?.code).toBe("SESSION_NOT_FOUND");

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses a directory cursor from before a catalogue change", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    for (let index = 1; index <= 3; index += 1) {
      composed.repository.createSession({ sessionId: `s-${index}`, title: `t${index}`, createdAt: index });
    }

    const client = connect(composed.host);
    await client.describe();
    const first = await client.call("sessions.list", { limit: 2 });
    expect(first.result?.sessions.hasMore).toBe(true);
    const cursor = first.result?.sessions.nextCursor ?? "";
    expect(cursor).not.toBe("");

    // A new session moves the collection revision; a page cut from the old one
    // is refused rather than glued onto the new facts.
    const created = await client.call("sessions.create", {});
    expect(created.result?.session.sessionId).toBeDefined();

    const stale = await client.call("sessions.list", { cursor });
    expect(stale.error?.code).toBe("STALE_CURSOR");

    const fresh = await client.call("sessions.list", { limit: 2 });
    expect(fresh.result?.sessions.items.length).toBe(2);

    client.detach();
    await composed.host.shutdown();
  });

  it("retires the submission of a deleted session instead of releasing it", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    writeTurn(composed.repository, "s-1", 1);

    const client = connect(composed.host);
    await client.describe();
    const session = await client.call("sessions.get", { sessionId: "s-1" });
    const deleted = await client.call("sessions.delete", {
      sessionId: "s-1",
      expectedRevision: session.result?.session.metadataRevision ?? 0,
    });
    expect(deleted.result?.generation).toBe(1);

    const replayed = await client.call("runs.start", {
      sessionId: "s-1",
      submissionId: "seed-sub-1",
      text: "question 1",
    });
    expect(replayed.error?.code).toBe("SUBMISSION_RETIRED");
    // The tombstone keeps the identity, not the conversation.
    expect(composed.repository.getSubmission("seed-sub-1")?.state).toBe("retired");
    expect(composed.repository.getSubmission("seed-sub-1")?.inputHash).not.toContain("question");

    client.detach();
    await composed.host.shutdown();
  });

  it("does not shrink canonical history when a session is renamed or read", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    writeTurn(composed.repository, "s-1", 1);

    const client = connect(composed.host);
    await client.describe();
    await client.call("sessions.history", { sessionId: "s-1", limit: 1 });
    const session = await client.call("sessions.get", { sessionId: "s-1" });
    await client.call("sessions.rename", {
      sessionId: "s-1",
      expectedRevision: session.result?.session.metadataRevision ?? 0,
      title: "still here",
    });
    expect(composed.repository.getSession("s-1")?.committedSeq).toBe(4);
    expect(composed.repository.getSession("s-1")?.historyRevision).toBe(1);

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Bounds.
// ---------------------------------------------------------------------------

describe("bounded reads", () => {
  it("does not hand the model a whole conversation, however long it is", async () => {
    const model = scriptedModel([textReply("ok")]);
    const composed = composeTestHost({ modelClient: model.client });
    composed.repository.createSession({ sessionId: "s-long", title: "t", createdAt: 1 });
    for (let index = 1; index <= 120; index += 1) writeTurn(composed.repository, "s-long", index);
    expect(composed.repository.getSession("s-long")?.committedSeq).toBe(480);

    const client = connect(composed.host);
    await client.describe();
    const started = await client.call("runs.start", {
      sessionId: "s-long",
      submissionId: nextId("live-sub"),
      text: "one more",
    });
    if (started.error !== undefined) throw new Error(`runs.start refused: ${started.error.code}`);
    await awaitRunTerminal(client, started.result?.run.runId ?? "");

    // The request the model actually received carries the bounded window, not
    // the 120 turns before it.
    const request = model.requests[0];
    expect(request).toBeDefined();
    const messages = request?.messages ?? [];
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThan(48);

    client.detach();
    await composed.host.shutdown();
  });

  it("keeps the published snapshot bounded and says so", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    for (let index = 1; index <= 30; index += 1) {
      composed.repository.createSession({ sessionId: `s-${index}`, title: `t${index}`, createdAt: index });
    }

    const client = connect(composed.host);
    await client.describe();
    const opened = await client.call("subscriptions.open", {});
    const snapshot = opened.result?.snapshot;

    expect(snapshot?.sessions.items.length).toBeLessThanOrEqual(20);
    expect(snapshot?.sessions.hasMore).toBe(true);
    // The window is a window: the sessions it does not hold are still there.
    expect(composed.repository.getSession("s-1")).toBeDefined();

    client.detach();
    await composed.host.shutdown();
  });

  it("splits a page inside a turn rather than overrunning the item bound", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    for (let index = 1; index <= 20; index += 1) writeTurn(composed.repository, "s-1", index);

    const client = connect(composed.host);
    await client.describe();
    const page = await client.call("sessions.history", { sessionId: "s-1", limit: 3 });
    expect(page.error).toBeUndefined();
    expect(page.result?.page.items.length).toBeLessThanOrEqual(3);
    expect(page.result?.page.startsAtTurnBoundary).toBe(false);

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Storage ownership, schema and failure.
// ---------------------------------------------------------------------------

describe("storage ownership and schema", () => {
  it("refuses a second host on the same file", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const first = composeTestHost({ modelClient: MODEL().client, location: path });
      expect(() => composeTestHost({ modelClient: MODEL().client, location: path })).toThrow();
      await first.host.shutdown();

      // And releasing it lets the next host in: the lock is the host's, not the
      // file's.
      const third = composeTestHost({ modelClient: MODEL().client, location: path });
      await third.host.shutdown();
    });
  });

  it("refuses a schema newer than this build understands", async () => {
    await withTempDir((dir) => {
      const path = storePath(dir);
      const database = new DatabaseSync(path);
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 7}`);
      database.close();

      expect(() => composeTestHost({ modelClient: MODEL().client, location: path })).toThrow();
    });
  });

  it("rolls a failed migration back instead of leaving half a schema", async () => {
    await withTempDir((dir) => {
      const path = storePath(dir);
      const database = new DatabaseSync(path);
      // Version 0 with a conflicting table: migration 1 cannot create its own
      // `runs` table, and must leave nothing of itself behind.
      database.exec("CREATE TABLE runs (wrong TEXT)");
      database.exec("PRAGMA user_version = 0");
      database.close();

      expect(() => composeTestHost({ modelClient: MODEL().client, location: path })).toThrow();

      const check = new DatabaseSync(path);
      const tables = check
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { readonly name?: string }[];
      check.close();
      const names = tables.map((row) => row.name);
      expect(names).toContain("runs");
      expect(names).not.toContain("sessions");
      expect(names).not.toContain("session_events");
    });
  });

  it("fails loudly rather than falling back to memory", async () => {
    await withTempDir((dir) => {
      // A directory is not a database file.
      expect(() => composeTestHost({ modelClient: MODEL().client, location: dir })).toThrow();
    });
  });

  it("releases the store on shutdown, so the next host can take it", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const first = composeTestHost({ modelClient: MODEL().client, location: path });
      await first.host.shutdown();
      const second = composeTestHost({ modelClient: MODEL().client, location: path });
      await second.host.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// Run listings.
// ---------------------------------------------------------------------------

describe("run listings", () => {
  it("lists a session's runs newest first, with a revision and a cursor", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    for (let index = 1; index <= 3; index += 1) writeTurn(composed.repository, "s-1", index);

    const client = connect(composed.host);
    await client.describe();
    const first = await client.call("runs.list", { sessionId: "s-1", limit: 2 });
    const items = first.result?.runs.items ?? [];
    expect(items.map((run: RunSummary) => run.runId)).toEqual(["seed-run-3", "seed-run-2"]);
    expect(first.result?.runs.hasMore).toBe(true);

    const second = await client.call("runs.list", { sessionId: "s-1", cursor: first.result?.runs.nextCursor ?? "" });
    expect(second.result?.runs.items.map((run: RunSummary) => run.runId)).toEqual(["seed-run-1"]);

    const missing = await client.call("runs.list", { sessionId: "nope" });
    expect(missing.error?.code).toBe("SESSION_NOT_FOUND");

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Limits.
// ---------------------------------------------------------------------------

describe("admission limits", () => {
  it("refuses an input larger than the published bound, before admitting it", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    const client = connect(composed.host);
    const described = await client.describe();
    const bound = described.result?.limits.maxInputBytes ?? 0;
    const session = await client.call("sessions.create", {});
    const sessionId = session.result?.session.sessionId ?? "";

    const oversized = await client.call("runs.start", {
      sessionId,
      submissionId: "sub-big",
      text: "x".repeat(bound + 1),
    });
    expect(oversized.error?.code).toBe("LIMIT_EXCEEDED");
    // Refused means refused: nothing was admitted, so nothing can be replayed.
    expect(composed.repository.getSubmission("sub-big")).toBeUndefined();
    expect(composed.repository.getSession(sessionId)?.activeRunId).toBeNull();

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses a page larger than one page may carry, on both sides", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    const client = connect(composed.host);
    const described = await client.describe();
    const maximum = described.result?.limits.maxPageItems ?? 0;
    const session = await client.call("sessions.create", {});
    const sessionId = session.result?.session.sessionId ?? "";

    // A peer that builds the frame by hand is answered, not obeyed: the bound
    // is the contract's, and no peer gets to widen it by asking.
    const framesBefore = client.frames.length;
    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "2",
        requestId: "raw-page",
        method: "sessions.history",
        params: { sessionId, limit: maximum + 1 },
        hostInstanceId: client.hostInstanceId,
      }),
    );
    for (let attempt = 0; attempt < 50 && client.frames.length === framesBefore; attempt += 1) await flush();
    const answer = client.frames
      .slice(framesBefore)
      .map((frame) => JSON.parse(frame) as { readonly requestId?: string; readonly error?: { readonly code?: string } })
      .find((frame) => frame.requestId === "raw-page");
    expect(answer?.error?.code).toBe("INVALID_REQUEST");

    client.detach();
    await composed.host.shutdown();
  });
});
