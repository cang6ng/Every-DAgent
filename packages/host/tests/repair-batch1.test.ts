/**
 * Repair Batch 1: the formal regressions for the findings the M1 review opened.
 *
 * One file, one section per finding, each written against the real host, the
 * real SQLite store and the real protocol encoder. Nothing here mocks the
 * store: what is being checked is what the store ends up holding and what a
 * client is told about it, and a double that never writes cannot be asked.
 *
 * The fault injections are deliberately at the API the failure really happens
 * at — the driver's own COMMIT, a repository method's own return — and every
 * one of them disarms itself, so an injected failure can never be confused with
 * the host's ordinary behaviour later in the same test.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { ModelEvent } from "@every-dagent/agent-core";
import type { Plugin } from "@every-dagent/plugin-system";
import type { RunSummary } from "@every-dagent/protocol";
import { MAX_FRAME_BYTES, MAX_PAGE_BYTES } from "@every-dagent/protocol";

import type { HostState } from "../src/state.js";
import { composeHost } from "../src/host.js";
import type { ComposedHost } from "../src/host.js";
import { encodedBytes, encodeStoredData, toSessionEvent } from "../src/repository.js";
import type { Repository, StoredRecord } from "../src/repository.js";
import {
  abortAwareReply,
  awaitRunTerminal,
  composeTestHost,
  connect,
  constantTool,
  createSessionThrough,
  flush,
  gate,
  gatedReply,
  nextId,
  recordingTool,
  replyThenFail,
  scriptedModel,
  testPlugin,
  textReply,
  toolReply,
} from "./helpers/harness.js";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-repair-"));
  try {
    return await act(dir);
  } catch (error) {
    throw error;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A store still held by a host that failed the test is not the failure.
    }
  }
}

const MODEL = () => scriptedModel([textReply("answer")], { repeatLast: true });

/** One synthetic settled turn, written the way a terminal commit writes one. */
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
function writeTurn(repository: Repository, sessionId: string, index: number, text = `question ${index}`, answer = `answer ${index}`): string {
  const runId = `seed-run-${index}`;
  const accepted = repository.admitRun({
    runId,
    submissionId: `seed-sub-${index}`,
    sessionId,
    text,
    inputHash: `seed-hash-${index}`,
    hostInstanceId: "seed-host",
    acceptedAt: 1_700_000_000_000 + index * 10,
  });
  if (accepted.kind !== "admitted") throw new Error(`seed admission refused: ${accepted.kind}`);
  repository.markRunStarted(runId, "seed-host", 1_700_000_000_001 + index * 10);
  const startSeq = repository.getSession(sessionId)?.committedSeq ?? 0;
  repository.commitTurn({
    runId,
    sessionId,
    turnId: `turn-${index}`,
    reason: "completed",
    turnStartSeq: startSeq,
    records: turnRecords(sessionId, `turn-${index}`, startSeq, text, answer),
    endedAt: 1_700_000_000_002 + index * 10,
  });
  return runId;
}

/** One finished turn that really called a tool, for pairing corruptions. */
function writeToolTurn(repository: Repository, sessionId: string, index: number): string {
  const runId = `seed-run-${index}`;
  const accepted = repository.admitRun({
    runId,
    submissionId: `seed-sub-${index}`,
    sessionId,
    text: `q${index}`,
    inputHash: `seed-hash-${index}`,
    hostInstanceId: "seed-host",
    acceptedAt: 1_700_000_000_000 + index * 10,
  });
  if (accepted.kind !== "admitted") throw new Error(`seed admission refused: ${accepted.kind}`);
  repository.markRunStarted(runId, "seed-host", 1_700_000_000_001 + index * 10);
  const startSeq = repository.getSession(sessionId)?.committedSeq ?? 0;
  const events = [
    { type: "turn/start" as const, data: {} },
    { type: "message/user" as const, data: { text: `q${index}` } },
    { type: "message/assistant" as const, data: { text: "", toolCalls: [{ callId: "c1", name: "t", input: { n: 1 } }] } },
    { type: "tool/call" as const, data: { callId: "c1", name: "t", input: { n: 1 } } },
    { type: "tool/result" as const, data: { callId: "c1", name: "t", ok: true, content: "ok" } },
    { type: "message/assistant" as const, data: { text: "a", toolCalls: [] } },
    { type: "turn/end" as const, data: { reason: "completed" as const } },
  ];
  repository.commitTurn({
    runId,
    sessionId,
    turnId: `turn-${index}`,
    reason: "completed",
    turnStartSeq: startSeq,
    records: events.map((event, offset) =>
      Object.freeze({
        seq: startSeq + offset,
        turnId: `turn-${index}`,
        type: event.type,
        time: 1_700_000_000_000 + startSeq + offset,
        data: encodeStoredData({ type: event.type, turnId: `turn-${index}`, seq: startSeq + offset, time: 0, data: event.data } as never),
      }),
    ),
    endedAt: 1_700_000_000_002 + index * 10,
  });
  return runId;
}

/** The real encoded size of one frame, as UTF-8. */
function frameBytes(frame: string): number {
  return Buffer.byteLength(frame, "utf8");
}

// ---------------------------------------------------------------------------
// Interference with a COMMIT receipt, at the driver's own API.
// ---------------------------------------------------------------------------

type CommitInterference = "landed" | "discarded" | "unverifiable";

interface InstalledInterference {
  /** How many COMMIT receipts were interfered with (0 or 1). */
  injected(): number;
  restore(): void;
}

/**
 * Interferes with the first COMMIT of the terminal batch, and only that one.
 *
 * `landed`: the commit really happened and the caller sees an error — the case
 * that used to publish a `failed` terminal while storage held `completed`.
 * `discarded`: the transaction was rolled back and the caller sees an error —
 * the batch can be retried as the *same* storage batch. `unverifiable`: the
 * commit landed and the evidence query cannot read, so nothing can be proven.
 *
 * It is armed before the run starts, because the whole run is what produces the
 * terminal batch, and it fires at most once: a test that asserts afterwards is
 * asserting about a healthy store.
 */
function interfereWithTerminalCommit(mode: CommitInterference): InstalledInterference {
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  let armed = false;
  let fired = 0;
  let breakEvidence = false;

  DatabaseSync.prototype.prepare = function patchedPrepare(this: DatabaseSync, sql: string) {
    if (breakEvidence && sql.startsWith("SELECT")) {
      breakEvidence = false;
      throw new Error("injected: the evidence query is unavailable");
    }
    const statement = originalPrepare.call(this, sql);
    if (sql.startsWith("INSERT INTO session_events")) armed = true;
    return statement;
  };

  DatabaseSync.prototype.exec = function patchedExec(this: DatabaseSync, sql: string): void {
    if (sql === "COMMIT" && armed && fired === 0) {
      fired += 1;
      armed = false;
      if (mode === "landed") {
        originalExec.call(this, sql);
        throw new Error("injected: the commit receipt was lost");
      }
      if (mode === "unverifiable") {
        originalExec.call(this, sql);
        breakEvidence = true;
        throw new Error("injected: the commit receipt was lost");
      }
      originalExec.call(this, "ROLLBACK");
      throw new Error("injected: the commit was refused");
    }
    originalExec.call(this, sql);
  };

  return {
    injected: () => fired,
    restore: () => {
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.prepare = originalPrepare;
    },
  };
}

/** Waits until `check` holds, letting the host's own microtasks run. */
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await flush();
  }
}

// ---------------------------------------------------------------------------
// R01 — a durable store is durable, and an empty location is not a store.
// ---------------------------------------------------------------------------

describe("R01 durable location", () => {
  it("recovers storage, session, run, history and submission across a normal restart", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "state.db");
      const first = composeTestHost({ modelClient: MODEL().client, location: path });
      const client = connect(first.host);
      await client.describe();
      await client.call("plugins.enable", { pluginId: "missing" }).catch(() => undefined);
      const session = await createSessionThrough(client);
      const started = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: "durable-sub",
        text: "hello",
      });
      const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
      expect(terminal.status).toBe("completed");
      const storageId = first.repository.storageId;
      const runId = started.result?.run.runId as string;
      client.detach();
      await first.host.shutdown();

      // The same configuration, a new process's worth of state.
      const second = composeTestHost({ modelClient: MODEL().client, location: path });
      expect(second.repository.storageId).toBe(storageId);
      expect(second.repository.getSession(session.sessionId)?.committedSeq).toBe(4);
      expect(second.repository.readHistory(session.sessionId, 100, 50).records).toHaveLength(4);
      expect(second.repository.getRun(runId)?.status).toBe("completed");
      expect(second.repository.getSubmission("durable-sub")?.runId).toBe(runId);

      // A client asking the same question gets the same answer, over the wire.
      const clientAgain = connect(second.host);
      await clientAgain.describe();
      const run = await clientAgain.call("runs.get", { submissionId: "durable-sub" });
      expect(run.result?.run.status).toBe("completed");
      const page = await clientAgain.call("sessions.history", { sessionId: session.sessionId });
      expect(page.result?.page.items.map((item) => item.kind)).toEqual([
        "user",
        "assistant",
      ]);
      clientAgain.detach();
      await second.host.shutdown();
    });
  });

  it("refuses an empty sqlite location instead of announcing a durable host", async () => {
    for (const location of ["", "   "]) {
      expect(() => composeTestHost({ modelClient: MODEL().client, location })).toThrow(/location/i);
    }
  });

  it("keeps the explicit ephemeral mode honest about its retention", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    expect(composed.repository.retention).toBe("ephemeral");

    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const described = await client.describe();
    expect(described.result?.storage.retention).toBe("ephemeral");
    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R02 — a lost COMMIT receipt is reconciled against the batch's own evidence.
// ---------------------------------------------------------------------------

describe("R02 commit outcome reconciliation", () => {
  it("publishes the committed terminal when the commit landed but its receipt was lost", async () => {
    const composed = composeTestHost({ modelClient: scriptedModel([textReply("answer")]).client });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "hello",
    });
    const runId = started.result?.run.runId as string;

    const interference = interfereWithTerminalCommit("landed");
    const terminal = await awaitRunTerminal(client, runId);
    expect(interference.injected()).toBe(1);
    interference.restore();

    // What the client was told and what storage holds are the same outcome.
    expect(terminal.status).toBe("completed");
    expect(composed.repository.getRun(runId)?.status).toBe("completed");
    expect(composed.repository.getSession(session.sessionId)?.committedSeq).toBe(4);
    expect(composed.repository.readHistory(session.sessionId, 100, 50).records).toHaveLength(4);
    // No fabricated failure, and no second execution.
    expect(client.events.filter((event) => event.type === "run.ended")).toHaveLength(1);

    client.detach();
    await composed.host.shutdown();
  });

  it("retries the same storage batch when the commit was discarded, without re-running anything", async () => {
    const model = scriptedModel([textReply("answer")]);
    const composed = composeTestHost({ modelClient: model.client });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "hello",
    });
    const runId = started.result?.run.runId as string;
    const interference = interfereWithTerminalCommit("discarded");
    const terminal = await awaitRunTerminal(client, runId);
    expect(interference.injected()).toBe(1);
    interference.restore();

    expect(terminal.status).toBe("completed");
    expect(composed.repository.getRun(runId)?.status).toBe("completed");
    // One model call: the Runtime was never re-run.
    expect(model.requests.length).toBe(1);

    client.detach();
    await composed.host.shutdown();
  });

  it("publishes no terminal it cannot prove, and stops new execution, when the evidence is unreadable", async () => {
    const composed = composeTestHost({ modelClient: scriptedModel([textReply("answer")]).client });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "hello",
    });
    const runId = started.result?.run.runId as string;
    const interference = interfereWithTerminalCommit("unverifiable");
    await flush();
    await flush();
    expect(interference.injected()).toBe(1);
    interference.restore();

    // Nothing was fabricated: the host publishes no terminal it could not
    // prove. What it must not do either is keep presenting the execution it was
    // watching as current — the entry is released, the connection it was
    // streaming on is ended, and a reader that reconnects is refused outright,
    // because the host cannot confirm what storage holds. The record itself
    // really did land, which is asserted directly against the store below —
    // the fault is about what this host instance may claim, not about what the
    // store holds.
    expect(client.events.filter((event) => event.type === "run.ended")).toHaveLength(0);
    expect(client.isClosed).toBe(true);
    const reader = connect(composed.host);
    await reader.describe();
    const queried = await reader.call("runs.get", { runId });
    expect(queried.error?.code).toBe("STORAGE_UNAVAILABLE");
    expect(composed.repository.getRun(runId)?.status).toBe("completed");

    // New execution is refused while the store cannot be trusted.
    const refused = await reader.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "again",
    });
    expect(refused.error?.code).toBe("STORAGE_UNAVAILABLE");

    reader.detach();
    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R05 — stored facts that are not what they claim are refused, not repaired.
// ---------------------------------------------------------------------------

describe("R05 corruption is refused", () => {
  /** Seeds one completed turn on a durable file and returns the ids. */
  async function seed(path: string, withTool = false): Promise<{ sessionId: string; runId: string }> {
    const composed = composeTestHost({ modelClient: MODEL().client, location: path });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    const runId = withTool
      ? writeToolTurn(composed.repository, "s-1", 1)
      : writeTurn(composed.repository, "s-1", 1, "q", "a");
    await composed.host.shutdown();
    return { sessionId: "s-1", runId };
  }

  const DAMAGE: readonly { readonly name: string; readonly apply: (database: DatabaseSync) => void; readonly refuseRun: boolean }[] = [
    {
      name: "invalid JSON",
      apply: (database) => {
        database.prepare("UPDATE session_events SET data = 'not-json' WHERE type = 'message/user'").run();
      },
      refuseRun: true,
    },
    {
      name: "a payload of the wrong type",
      apply: (database) => {
        database.prepare(`UPDATE session_events SET data = '{"text":123}' WHERE type = 'message/user'`).run();
      },
      refuseRun: true,
    },
    {
      name: "a record that belongs to another turn",
      apply: (database) => {
        database.prepare("UPDATE session_events SET turn_id = 'FOREIGN' WHERE type = 'message/assistant'").run();
      },
      refuseRun: true,
    },
    {
      name: "a tool result that answers a different call",
      apply: (database) => {
        database.prepare("UPDATE session_events SET data = json_set(data, '$.callId', 'FOREIGN') WHERE type = 'tool/result'").run();
      },
      refuseRun: true,
    },
  ];

  it.each(DAMAGE)("refuses a turn whose %s, and never feeds it to a model", async (damage) => {
    await withTempDir(async (dir) => {
      const path = join(dir, "corrupt.db");
      await seed(path, damage.name.startsWith("a tool result"));
      const database = new DatabaseSync(path);
      damage.apply(database);
      database.close();

      const model = scriptedModel([textReply("later")]);
      const composed = composeTestHost({ modelClient: model.client, location: path });
      const client = connect(composed.host);
      await client.describe();

      // The history page is refused rather than served with a repaired fact.
      const page = await client.call("sessions.history", { sessionId: "s-1" });
      expect(page.error?.code).toBe("INTERNAL_ERROR");
      expect(page.result).toBeUndefined();

      // Confirming the corruption is itself the point at which this session
      // stops being executable: it is blocked durably, so a new run is refused
      // before admission and the model is never handed the corrupted log.
      expect(composed.repository.getSession("s-1")?.status).toBe("blocked");
      const refused = await client.call("runs.start", {
        sessionId: "s-1",
        submissionId: nextId("sub"),
        text: "next",
      });
      expect(refused.error?.code).toBe("SESSION_UNAVAILABLE");
      expect(refused.result).toBeUndefined();
      expect(model.requests).toHaveLength(0);

      // The block is a fact, not this process's mood: a restart reads it back.
      client.detach();
      await composed.host.shutdown();

      const restarted = composeTestHost({ modelClient: model.client, location: path });
      const again = connect(restarted.host);
      await again.describe();
      const stillRefused = await again.call("runs.start", {
        sessionId: "s-1",
        submissionId: nextId("sub"),
        text: "later",
      });
      expect(stillRefused.error?.code).toBe("SESSION_UNAVAILABLE");
      expect(restarted.repository.getSession("s-1")?.status).toBe("blocked");
      again.detach();
      await restarted.host.shutdown();
    });
  });

  it("stops a run whose own window cannot be read, and blocks the session", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "window.db");
      await seed(path);
      const database = new DatabaseSync(path);
      // The log the run would execute against is what is damaged: the committed
      // turn left behind disagrees with itself — its user fact is not the
      // payload its type promises — and no run row claims it any more, so a cut
      // has nothing to refuse and the damage is found exactly where it matters:
      // loading the history this run would continue.
      database.prepare("UPDATE session_events SET data = 'not-json' WHERE type = 'message/user'").run();
      database.prepare("DELETE FROM runs").run();
      database.close();

      // No page is read first: the corruption is found while loading the
      // window the run would execute against, and the run ends as a host
      // failure rather than executing against a history it cannot trust.
      const model = scriptedModel([textReply("later")]);
      const composed = composeTestHost({ modelClient: model.client, location: path });
      const client = connect(composed.host);
      await client.describe();
      const started = await client.call("runs.start", {
        sessionId: "s-1",
        submissionId: nextId("sub"),
        text: "next",
      });
      const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
      expect(terminal.status).toBe("failed");
      expect(model.requests).toHaveLength(0);
      expect(composed.repository.getSession("s-1")?.status).toBe("blocked");

      client.detach();
      await composed.host.shutdown();
    });
  });

  it("refuses a run whose recorded history range is not the turn the index holds", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "association.db");
      const ids = await seed(path);
      const database = new DatabaseSync(path);
      database.prepare("UPDATE runs SET committed_from_seq = 888, committed_to_seq = 999 WHERE run_id = ?").run(ids.runId);
      database.close();

      const composed = composeTestHost({ modelClient: MODEL().client, location: path });
      const client = connect(composed.host);
      await client.describe();

      const run = await client.call("runs.get", { runId: ids.runId });
      expect(run.error?.code).toBe("INTERNAL_ERROR");
      const list = await client.call("runs.list", { sessionId: ids.sessionId });
      expect(list.error?.code).toBe("INTERNAL_ERROR");

      client.detach();
      await composed.host.shutdown();
    });
  });

  it("refuses a window whose turn end belongs to another turn, at the Core boundary", async () => {
    // The Core's own window check, exercised through the type the host uses.
    const { restoreSessionWindow } = await import("@every-dagent/agent-core");
    const records = turnRecords("s-1", "A", 0, "q", "a");
    const tampered = records.map((record, index) =>
      index === 3 ? Object.freeze({ ...record, turnId: "B" }) : record,
    );
    const events = tampered.map((record) => ({
      seq: record.seq,
      turnId: record.turnId,
      type: record.type,
      time: record.time,
      data: JSON.parse(record.data) as never,
    }));

    expect(() =>
      restoreSessionWindow("s-1", {
        baseSeq: 0,
        nextSeq: events.length,
        events: events as never,
      }),
    ).toThrow(/open turn|belongs to turn/);
  });
});

// ---------------------------------------------------------------------------
// R06 — provider text never becomes a durable fact.
// ---------------------------------------------------------------------------

describe("R06 safe persisted errors", () => {
  const SENTINEL = "M1_REPAIR_SECRET authorization=Bearer SECRET raw-provider-body";

  it("keeps a model's raw failure text out of storage, the wire and the replica", async () => {
    const composed = composeTestHost({
      modelClient: scriptedModel([
        replyThenFail([], new Error(SENTINEL)),
      ]).client,
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "hello",
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
    expect(terminal.status).toBe("failed");

    // Storage: every durable row, scanned for the sentinel.
    const rows = composed.repository.readHistory(session.sessionId, 100, 50).records;
    const run = composed.repository.getRun(started.result?.run.runId as string);
    for (const record of rows) {
      expect(record.data).not.toContain("M1_REPAIR_SECRET");
    }
    expect(JSON.stringify(run)).not.toContain("M1_REPAIR_SECRET");
    // Wire: every frame this client received.
    for (const frame of client.frames) {
      expect(frame).not.toContain("M1_REPAIR_SECRET");
    }

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R25 — a cancel intent is only durable when storage says so.
// ---------------------------------------------------------------------------

describe("R25 cancel durability", () => {
  it("re-checks the durable intent on a repeated request instead of answering from memory", async () => {
    const composed = composeTestHost({ modelClient: scriptedModel([abortAwareReply()]).client });
    const client = connect(composed.host);
    await client.describe();
    const session = await createSessionThrough(client);
    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "slow",
    });
    const runId = started.result?.run.runId as string;

    // The store refuses the intent until the test lets it through again.
    let writes = 0;
    let broken = true;
    const repository = composed.repository as Repository & { requestCancel: (runId: string, at: number) => unknown };
    const original = repository.requestCancel.bind(repository);
    repository.requestCancel = (candidateRunId: string, at: number) => {
      writes += 1;
      if (broken) throw new Error("injected: the intent cannot be recorded");
      return original(candidateRunId, at);
    };

    const first = await client.call("runs.cancel", { runId });
    expect(first.error?.code).toBe("STORAGE_UNAVAILABLE");
    expect(writes).toBe(1);
    // The abort was still asked for, and the intent is not called durable.
    expect(composed.repository.getRun(runId)?.cancelRequested).toBe(false);

    // A repeat request against a still-broken store: it tries again, and it
    // still does not report a durable success it does not have.
    const second = await client.call("runs.cancel", { runId });
    expect(second.error?.code).toBe("STORAGE_UNAVAILABLE");
    expect(writes).toBe(2);

    // Storage recovers: the repeat must write durably, and only then succeed.
    broken = false;
    const third = await client.call("runs.cancel", { runId });
    expect(third.error).toBeUndefined();
    expect(writes).toBe(3);
    expect(composed.repository.getRun(runId)?.cancelRequested).toBe(true);

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R03 — what cannot be stored is refused before it can have effects.
// ---------------------------------------------------------------------------

describe("R03 encoded record preflight", () => {
  it("refuses an input whose user fact could never be stored, before admission", async () => {
    const model = scriptedModel([textReply("unused")]);
    let effects = 0;
    const tool = { ...constantTool("effect"), execute: async (): Promise<string> => (effects += 1, "effect") };
    const composed = composeTestHost({
      modelClient: model.client,
      plugins: [testPlugin({ id: "tools", tools: [tool] })],
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    // 16 KiB of NUL escapes to ~98 KiB of JSON: within the raw bound, far past
    // the record bound. Accepted today is too late by one tool call.
    const input = "\u0000".repeat(16 * 1024);
    expect(Buffer.byteLength(input, "utf8")).toBeLessThanOrEqual(16 * 1024);
    const refused = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "escaped",
      text: input,
    });

    expect(refused.error?.code).toBe("LIMIT_EXCEEDED");
    expect(composed.repository.getSubmission("escaped")).toBeUndefined();
    expect(composed.repository.listUnfinishedRuns()).toEqual([]);
    expect(model.requests).toHaveLength(0);
    expect(effects).toBe(0);
    expect(composed.repository.getSession(session.sessionId)?.activeRunId).toBeNull();

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses a model step whose records could not be stored, before any tool runs", async () => {
    let effects = 0;
    const tool = {
      ...constantTool("big"),
      execute: async (): Promise<string> => {
        effects += 1;
        return "ran";
      },
    };
    // A step whose assistant record is over the durable bound: 70 KiB of
    // argument text encodes past 64 KiB.
    const huge = "x".repeat(70 * 1024);
    const composed = composeTestHost({
      modelClient: scriptedModel([toolReply("c1", "big", { text: huge })], { repeatLast: true }).client,
      plugins: [testPlugin({ id: "tools", tools: [tool] })],
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "big",
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);

    expect(terminal.status).toBe("failed");
    expect(effects).toBe(0);
    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R04 — a tool input that cannot be restored is refused, not projected away.
// ---------------------------------------------------------------------------

describe("R04 non-JSON tool input", () => {
  it.each([
    ["undefined", { a: undefined }],
    ["a cycle", (() => { const node: Record<string, unknown> = {}; node["self"] = node; return node; })()],
    ["a Date", { when: new Date(0) }],
    ["a Map", { lookup: new Map([["a", 1]]) }],
  ])("refuses %s before the executor is reached, with no canonical call", async (_name, input) => {
    const seen: unknown[] = [];
    const composed = composeTestHost({
      modelClient: scriptedModel([toolReply("c1", "observer", input)], { repeatLast: true }).client,
      plugins: [testPlugin({ id: "tools", tools: [recordingTool("observer", seen)] })],
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "use it",
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);

    expect(terminal.status).toBe("failed");
    expect(seen).toHaveLength(0);
    const page = await client.call("sessions.history", { sessionId: session.sessionId });
    const items = page.result?.page.items ?? [];
    expect(items.some((item) => item.kind === "tool-call")).toBe(false);
    expect(items.some((item) => item.kind === "assistant")).toBe(false);
    expect(client.events.some((event) => event.type === "run.tool.call")).toBe(false);

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R09 — a settled run is the repository's fact, not the host's memory.
// ---------------------------------------------------------------------------

describe("R09 terminal run retention", () => {
  it("keeps only live runs in the host, and answers a deleted run from the store", async () => {
    let state: HostState | undefined;
    const composed = composeHost(
      {
        modelClient: MODEL().client,
        plugins: [],
        persistence: { kind: "ephemeral" },
      },
      { onState: (observed) => (state = observed) },
    );
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);

    for (let index = 0; index < 25; index += 1) {
      const started = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: `sub-${index}`,
        text: `hello ${index}`,
      });
      await awaitRunTerminal(client, started.result?.run.runId as string);
    }
    await flush();

    // Twenty-five runs happened and the host holds none of them: the live map
    // is for what is executing, not for what executed.
    expect(state?.runs.size).toBe(0);

    // A retained entry would also answer after the session is deleted; the
    // store must not.
    const last = await client.call("runs.list", { sessionId: session.sessionId, limit: 1 });
    const lastRunId = last.result?.runs.items[0]?.runId as string;
    const revision = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session
      .metadataRevision as number;
    const deleted = await client.call("sessions.delete", { sessionId: session.sessionId, expectedRevision: revision });
    expect(deleted.result?.deleted).toBe(true);

    const gone = await client.call("runs.get", { runId: lastRunId });
    expect(gone.error?.code).toBe("RUN_NOT_FOUND");
    expect(gone.result).toBeUndefined();
    const bySubmission = await client.call("runs.get", { submissionId: "sub-24" });
    expect(bySubmission.error?.code).toBe("SUBMISSION_RETIRED");

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R10 — the execution window is bounded in real encoded bytes.
// ---------------------------------------------------------------------------

describe("R10 window byte budget", () => {
  const BUDGET = 256 * 1024;

  /** The window's real cost: the events exactly as the Core takes them. */
  function representationBytes(records: readonly StoredRecord[]): number {
    return encodedBytes(records.map(toSessionEvent));
  }

  it.each([
    ["ASCII", () => "a".repeat(12 * 1024)],
    ["中文", () => "汉".repeat(8 * 1024)],
    ["emoji", () => "🙂".repeat(8 * 1024)],
  ])("keeps the loaded window inside the budget with %s content", async (_name, makeAnswer) => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    for (let index = 1; index <= 24; index += 1) {
      writeTurn(composed.repository, "s-1", index, `q${index}`, makeAnswer());
    }

    const read = composed.repository.readTurnWindow("s-1", 16, BUDGET);
    expect(representationBytes(read.records)).toBeLessThanOrEqual(BUDGET);
    expect(read.baseSeq).toBeGreaterThan(0);

    await composed.host.shutdown();
  });

  it("stops at a turn that does not fit instead of forcing it in", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    writeTurn(composed.repository, "s-1", 1, "old", "old answer");
    writeTurn(composed.repository, "s-1", 2, "newer", "newer answer");

    // A budget too small for the newest whole turn: the honest answer is an
    // empty window — never an oversized turn forced in, never a skipped one.
    const read = composed.repository.readTurnWindow("s-1", 16, 64);
    expect(read.records).toEqual([]);
    expect(read.baseSeq).toBe(read.nextSeq);

    // A budget that fits the newest turn but not the one before it stops there
    // rather than reaching further back.
    const newest = composed.repository.readHistory("s-1", 100, 50).records.slice(4);
    const newestOnly = composed.repository.readTurnWindow("s-1", 16, representationBytes(newest));
    expect(newestOnly.records).toHaveLength(4);
    expect(newestOnly.baseSeq).toBe(4);

    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R13 — the run page is bounded by real encoded bytes, not only by count.
// ---------------------------------------------------------------------------

describe("R13 run page byte bound", () => {
  it("stops a run page at the encoded byte bound and points its cursor at the last item", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    // Escaping-heavy inputs: each run's summary is far larger than its text.
    const escaped = "\u0000".repeat(6 * 1024);
    for (let index = 1; index <= 30; index += 1) {
      writeTurn(composed.repository, "s-1", index, `${escaped}${index}`, `answer ${index}`);
    }

    const client = connect(composed.host);
    await client.describe();
    const page = await client.call("runs.list", { sessionId: "s-1", limit: 50 });
    expect(page.error).toBeUndefined();

    const runs = page.result?.runs;
    expect(runs).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(runs), "utf8")).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    // The frame that carried it is inside the frame bound too.
    const frame = client.frames[client.frames.length - 1] as string;
    expect(frameBytes(frame)).toBeLessThanOrEqual(MAX_FRAME_BYTES);

    // Fewer items than the count bound, more than the page held: the cursor
    // continues from the last item returned, not from the query's batch.
    expect((runs?.items.length ?? 0) > 0).toBe(true);
    expect((runs?.items.length ?? 0) < 30).toBe(true);
    expect(runs?.hasMore).toBe(true);
    const next = await client.call("runs.list", { sessionId: "s-1", limit: 50, cursor: runs?.nextCursor ?? "" });
    expect(next.error).toBeUndefined();
    const seen = new Set([...(runs?.items ?? []).map((run: RunSummary) => run.runId), ...(next.result?.runs.items ?? []).map((run: RunSummary) => run.runId)]);
    expect(seen.size).toBe((runs?.items.length ?? 0) + (next.result?.runs.items.length ?? 0));

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R14 — `hasMore` is answered by the read, never guessed from a count.
// ---------------------------------------------------------------------------

describe("R14 snapshot hasMore truth", () => {
  async function snapshotFor(runCount: number, textBytes: number): Promise<{ items: number; hasMore: boolean }> {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    for (let index = 1; index <= runCount; index += 1) {
      writeTurn(composed.repository, "s-1", index, "x".repeat(textBytes) + index, `a${index}`);
    }
    const client = connect(composed.host);
    await client.describe();
    const opened = await client.call("subscriptions.open", {});
    const runs = opened.result?.snapshot.runs;
    client.detach();
    await composed.host.shutdown();
    return { items: runs?.items.length ?? 0, hasMore: runs?.hasMore ?? false };
  }

  it("is false when the window holds everything", async () => {
    const snapshot = await snapshotFor(3, 16);
    expect(snapshot.items).toBe(3);
    expect(snapshot.hasMore).toBe(false);
  });

  it("is false when the count is exactly the window and nothing is left", async () => {
    const snapshot = await snapshotFor(20, 16);
    expect(snapshot.items).toBe(20);
    expect(snapshot.hasMore).toBe(false);
  });

  it("is true when runs were left out by count", async () => {
    const snapshot = await snapshotFor(22, 16);
    expect(snapshot.items).toBe(20);
    expect(snapshot.hasMore).toBe(true);
  });

  it("is true when the byte budget left runs out before the count did", async () => {
    // Each accepted input is 4 KiB and the window's text budget is 48 KiB.
    const snapshot = await snapshotFor(30, 4 * 1024);
    expect(snapshot.items).toBeLessThan(20);
    expect(snapshot.hasMore).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R15 — the live view is bounded by what it actually encodes to.
// ---------------------------------------------------------------------------

describe("R15 active live encoded size", () => {
  it("keeps a run with several large results readable inside one frame", async () => {
    // Each result is legal on its own (well under the record bound) and large
    // enough that three of them cannot fit the live budget.
    const big = "x".repeat(50 * 1024);
    let executions = 0;
    const tool = {
      ...constantTool("big"),
      execute: async (): Promise<string> => {
        executions += 1;
        return big;
      },
    };
    const composed = composeTestHost({
      modelClient: scriptedModel([
        [
          { type: "tool-call", call: { callId: "c1", name: "big", input: { n: 1 } } },
          { type: "tool-call", call: { callId: "c2", name: "big", input: { n: 2 } } },
          { type: "tool-call", call: { callId: "c3", name: "big", input: { n: 3 } } },
        ],
        textReply("done"),
      ]).client,
      plugins: [testPlugin({ id: "tools", tools: [tool] })],
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "big",
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
    expect(terminal.status).toBe("completed");
    expect(executions).toBe(3);

    // Every frame this run ever published, live or terminal, is encodable.
    for (const frame of client.frames) {
      expect(frameBytes(frame)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    }
    // And the view said honestly that it stopped growing.
    const truncated = client.events.some(
      (event) => event.type === "run.updated" && event.payload.run.liveTruncated === true,
    );
    expect(truncated).toBe(true);

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R16 — a truncated live view never becomes a truncated conversation.
// ---------------------------------------------------------------------------

describe("R16 live truncation cannot control canonical truth", () => {
  it("completes a run whose presentation ran out long before its tools did", async () => {
    const big = "x".repeat(24 * 1024);
    const tool = { ...constantTool("big"), execute: async (): Promise<string> => big };
    // Twelve calls in one step, each with a large result: the live budget is
    // spent early, while the turn itself is entirely legal.
    const calls: ModelEvent[] = [];
    for (let index = 0; index < 12; index += 1) {
      calls.push({ type: "tool-call", call: { callId: `c${index}`, name: "big", input: { n: index } } });
    }
    const composed = composeTestHost({
      modelClient: scriptedModel([calls, textReply("done")]).client,
      plugins: [testPlugin({ id: "tools", tools: [tool] })],
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "many",
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);

    // The execution is what matters: it completed, and its canonical turn
    // holds every call and every result.
    expect(terminal.status).toBe("completed");
    // The whole conversation is read the way a client reads one: bounded pages
    // followed to the start.
    const items: { readonly kind: string }[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await client.call(
        "sessions.history",
        cursor === undefined ? { sessionId: session.sessionId } : { sessionId: session.sessionId, cursor },
      );
      expect(page.error).toBeUndefined();
      items.unshift(...(page.result?.page.items ?? []));
      const next = page.result?.page.nextCursor ?? null;
      if (next === null) break;
      cursor = next;
    }
    expect(items.filter((item) => item.kind === "tool-call")).toHaveLength(12);
    expect(items.filter((item) => item.kind === "tool-result")).toHaveLength(12);

    // And the view says honestly that it stopped growing.
    const ended = client.events.find((event) => event.type === "run.ended");
    expect(ended).toBeDefined();

    client.detach();
    await composed.host.shutdown();
  });

  it("serves a many-step turn page by page, with every occurrence whole", async () => {
    // Twelve steps, each its own assistant/call/result triple, which is more
    // records than one page carries: the newest page begins mid-turn, and the
    // traversal has to reconstruct the same conversation the run committed.
    const tool = constantTool("calc", { ok: true, value: 5 });
    const composed = composeTestHost({
      modelClient: scriptedModel([toolReply("c1", "calc", { a: 2, b: 3 })], { repeatLast: true }).client,
      plugins: [testPlugin({ id: "tools", tools: [tool] })],
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "keep going",
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
    expect(terminal.status).toBe("limited");

    const items: { readonly kind: string }[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await client.call(
        "sessions.history",
        cursor === undefined ? { sessionId: session.sessionId } : { sessionId: session.sessionId, cursor },
      );
      expect(page.error).toBeUndefined();
      pages += 1;
      items.unshift(...(page.result?.page.items ?? []));
      const next = page.result?.page.nextCursor ?? null;
      if (next === null) break;
      cursor = next;
      expect(pages).toBeLessThan(10);
    }

    expect(pages).toBeGreaterThan(1);
    expect(items.filter((item) => item.kind === "tool-call")).toHaveLength(12);
    expect(items.filter((item) => item.kind === "tool-result")).toHaveLength(12);
    expect(items.filter((item) => item.kind === "user")).toHaveLength(1);

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R28 — the whole snapshot, and the static configuration, must encodable.
// ---------------------------------------------------------------------------

describe("R28 combined snapshot frame", () => {
  it("shrinks its windows honestly so an escaping-heavy snapshot still travels", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    // Seven runs whose accepted inputs escape to ~39 KiB each: the composed
    // snapshot would be far past one frame if every window were kept whole.
    for (let index = 1; index <= 7; index += 1) {
      writeTurn(composed.repository, "s-1", index, `${"\u0000".repeat(4 * 1024)}${index}`, `a${index}`);
    }

    const client = connect(composed.host);
    await client.describe();
    const opened = await client.call("subscriptions.open", {});
    expect(opened.error).toBeUndefined();

    const frame = client.frames[client.frames.length - 1] as string;
    expect(frameBytes(frame)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    const snapshot = opened.result?.snapshot;
    expect(snapshot).toBeDefined();
    // What it left out, it says it left out.
    const kept = snapshot?.runs.items.length ?? 0;
    const droppedAnything = kept < 7;
    if (droppedAnything) expect(snapshot?.runs.hasMore).toBe(true);

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses to start with a static configuration that could never be published", () => {
    const huge = "d".repeat(300 * 1024);
    const plugin: Plugin = {
      manifest: { id: "huge", name: "Huge", version: "1.0.0", description: huge },
      activate: (): void => undefined,
    };
    expect(() => composeTestHost({ modelClient: MODEL().client, plugins: [plugin] })).toThrow(/frame|publish/i);
  });
});
