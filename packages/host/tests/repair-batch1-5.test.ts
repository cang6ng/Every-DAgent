/**
 * Repair Batch 1.5 — the two R05 residuals the closure re-review proved open.
 *
 * A page was still allowed to publish a record whose own sequence the turn it
 * names never committed: proving the turn was owned is not the same as proving
 * the record is a position that turn holds. Every record is now measured
 * against the range its turn's own index row returned — the same proof as
 * before, asked in the form that answers *where* as well as *whether* — while
 * a page stays a legal fragment.
 *
 * And the confirmation of a lost commit receipt still accepted a batch whose
 * records had been rewritten inside their own range: it checked the pointers
 * and a record *count*, never what the records were. The confirmation now ends
 * with the run read's own authority over the exact committed range, so it can
 * never be weaker than `runs.get`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  awaitRunTerminal,
  composeTestHost,
  connect,
  constantTool,
  createSessionThrough,
  flush,
  scriptedModel,
  testPlugin,
  textReply,
  toolReply,
} from "./helpers/harness.js";

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-repair-15-"));
  try {
    return await act(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A store still held by a host that failed the test is not the failure.
    }
  }
}

/** Waits until `check` holds, letting the host's own microtasks run. */
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await flush();
  }
}

interface Seeded {
  readonly session: string;
  readonly first: string;
  readonly second: string;
}

/**
 * One session holding two tool-carrying runs that really committed turns —
 * the two ranges every tamper below reaches across. Each turn is seven
 * records: `turn/start`, the user fact, the declaring assistant, the call, the
 * result, the closing assistant, `turn/end`.
 */
async function seed(path: string): Promise<Seeded> {
  const composed = await composeTestHost({
    modelClient: scriptedModel(
      [toolReply("c-1", "observer", { n: 1 }), textReply("one"), toolReply("c-2", "observer", { n: 2 }), textReply("two")],
      { repeatLast: true },
    ).client,
    plugins: [testPlugin({ id: "tools", tools: [constantTool("observer")] })],
    location: path,
  });
  const client = connect(composed.host);
  await client.describe();
  await client.call("plugins.enable", { pluginId: "tools" });

  const session = await createSessionThrough(client);
  const one = await client.call("runs.start", {
    sessionId: session.sessionId,
    submissionId: "sub-first",
    text: "same input",
  });
  const first = one.result?.run.runId as string;
  await awaitRunTerminal(client, first);
  const two = await client.call("runs.start", {
    sessionId: session.sessionId,
    submissionId: "sub-second",
    text: "same input",
  });
  const second = two.result?.run.runId as string;
  await awaitRunTerminal(client, second);
  client.detach();
  await composed.host.shutdown();
  return { session: session.sessionId, first, second };
}

/** Every durable canonical row the ownership proof is made of, for "nothing was rewritten". */
function canonicalFingerprint(path: string, sessionId: string): string {
  const database = new DatabaseSync(path);
  try {
    const runs = database.prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY run_id").all(sessionId);
    const turns = database
      .prepare("SELECT session_id, turn_id, start_seq, end_seq, reason FROM turns WHERE session_id = ? ORDER BY turn_id")
      .all(sessionId);
    const events = database.prepare("SELECT * FROM session_events WHERE session_id = ? ORDER BY seq").all(sessionId);
    return JSON.stringify({ runs, turns, events });
  } finally {
    database.close();
  }
}

/** The session's turn index, oldest first, as the store wrote it. */
function turnIds(path: string, sessionId: string): { readonly first: string; readonly second: string } {
  const database = new DatabaseSync(path);
  try {
    const rows = database
      .prepare("SELECT turn_id FROM turns WHERE session_id = ? ORDER BY start_seq")
      .all(sessionId) as { readonly turn_id?: string }[];
    return { first: rows[0]?.turn_id as string, second: rows[1]?.turn_id as string };
  } finally {
    database.close();
  }
}

/** The seq of the session's newest assistant record: the second turn's closing one. */
function newestAssistantSeq(database: DatabaseSync, sessionId: string): number {
  const row = database
    .prepare("SELECT seq FROM session_events WHERE session_id = ? AND type = 'message/assistant' ORDER BY seq DESC LIMIT 1")
    .get(sessionId) as { readonly seq?: number };
  return row.seq as number;
}

// ---------------------------------------------------------------------------
// R05-A — a record is only a fact at a position its own turn committed.
// ---------------------------------------------------------------------------

describe("R05 history binds every record to its own turn's committed range", () => {
  it("refuses a record whose own seq lies outside the turn its id names", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "range.db");
      const seeded = await seed(path);
      const turns = turnIds(path, seeded.session);
      const database = new DatabaseSync(path);
      const target = newestAssistantSeq(database, seeded.session);
      database.close();

      // First the honest shape, so the refusal below is about the damage and
      // not about the page: the smallest page of this traversal is exactly the
      // second turn's closing assistant record — mid-turn, no boundary in it,
      // a fragment the page's own range rules deliberately cannot judge.
      const intactHost = await composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const intactClient = connect(intactHost.host);
      await intactClient.describe();
      const intact = await intactClient.call("sessions.history", { sessionId: seeded.session, limit: 1 });
      expect(intact.error).toBeUndefined();
      expect(intact.result?.page.items.map((item) => item.seq)).toEqual([target]);
      intactClient.detach();
      await intactHost.host.shutdown();

      // The damage: the record keeps a turn the store *can* prove — the older
      // one — and moves nowhere. Everything a turn-side ownership proof asks
      // still holds; only the record's own seq says it was never that turn's
      // to publish.
      const tamper = new DatabaseSync(path);
      tamper.prepare("UPDATE session_events SET turn_id = ? WHERE session_id = ? AND seq = ?").run(turns.first, seeded.session, target);
      tamper.close();
      const damaged = canonicalFingerprint(path, seeded.session);

      const composed = await composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();

      // The same call now carries something no run committed at that position,
      // and the page is refused — never a payload, and the session blocks.
      const page = await client.call("sessions.history", { sessionId: seeded.session, limit: 1 });
      expect(page.error?.code).toBe("INTERNAL_ERROR");
      expect(page.result).toBeUndefined();
      expect(composed.repository.getSession(seeded.session)?.status).toBe("blocked");

      // The refusal is precise: the older run's own range is intact and still
      // served; the newer run's range holds the rewritten record, and that run
      // is corruption now.
      const older = await client.call("runs.get", { runId: seeded.first });
      expect(older.result?.run.status).toBe("completed");
      const newer = await client.call("runs.get", { runId: seeded.second });
      expect(newer.error?.code).toBe("INTERNAL_ERROR");

      client.detach();
      await composed.host.shutdown();
      // Nothing was repaired, backfilled or rewritten: the record still claims
      // the wrong turn.
      expect(canonicalFingerprint(path, seeded.session)).toBe(damaged);

      // A restart reconciles nothing: the damage is durable and still refused.
      const restarted = await composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const reader = connect(restarted.host);
      await reader.describe();
      const again = await reader.call("sessions.history", { sessionId: seeded.session, limit: 1 });
      expect(again.error?.code).toBe("INTERNAL_ERROR");
      expect(again.result).toBeUndefined();
      reader.detach();
      await restarted.host.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// R05-B — a lost commit receipt is confirmed against the records themselves.
// ---------------------------------------------------------------------------

/**
 * Interferes with the terminal COMMIT so the batch lands for real and the
 * caller still sees an error — the lost receipt the store's own evidence has
 * to reconcile. `damage` runs after the commit and before the error, so the
 * evidence the reconciliation reads can be made to disagree with itself.
 */
function interfereWithTerminalCommitThen(
  damage?: (database: DatabaseSync) => void,
): { injected(): number; restore(): void } {
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  let armed = false;
  let fired = 0;

  DatabaseSync.prototype.prepare = function patchedPrepare(this: DatabaseSync, sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (sql.startsWith("INSERT INTO session_events")) armed = true;
    return statement;
  };

  DatabaseSync.prototype.exec = function patchedExec(this: DatabaseSync, sql: string): void {
    if (sql === "COMMIT" && armed && fired === 0) {
      fired += 1;
      armed = false;
      originalExec.call(this, sql);
      damage?.(this);
      throw new Error("injected: the commit receipt was lost");
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

/** One run started on a durable store, whose terminal commit is about to land and lose its receipt. */
async function runAwaitingLostReceipt(
  path: string,
  damage: ((database: DatabaseSync, runId: string) => void) | undefined,
): Promise<{
  readonly composed: Awaited<ReturnType<typeof composeTestHost>>;
  readonly model: ReturnType<typeof scriptedModel>;
  readonly client: ReturnType<typeof connect>;
  readonly sessionId: string;
  readonly runId: string;
  readonly interference: { injected(): number; restore(): void };
}> {
  const model = scriptedModel([textReply("answer")]);
  const composed = await composeTestHost({ modelClient: model.client, location: path });
  const client = connect(composed.host);
  await client.describe();
  await client.call("subscriptions.open", {});
  const session = await createSessionThrough(client);

  const started = await client.call("runs.start", {
    sessionId: session.sessionId,
    submissionId: "sub-ack",
    text: "hello",
  });
  const runId = started.result?.run.runId as string;

  const interference = interfereWithTerminalCommitThen(
    damage === undefined ? undefined : (database) => damage(database, runId),
  );
  return { composed, model, client, sessionId: session.sessionId, runId, interference };
}

describe("R05 commit confirmation holds the records to the run read's authority", () => {
  it("refuses to publish a terminal whose record was rewritten inside its own range", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "rewritten.db");
      const damaged = await runAwaitingLostReceipt(path, (database, runId) => {
        // The batch really committed; only one record's own turn id is moved
        // to a turn nothing else agrees with. The run row, the turn index, the
        // range and the count all still hold — exactly the shape the old
        // confirmation accepted.
        const run = database.prepare("SELECT session_id FROM runs WHERE run_id = ?").get(runId) as {
          readonly session_id?: string;
        };
        const seq = newestAssistantSeq(database, run.session_id as string);
        database
          .prepare("UPDATE session_events SET turn_id = 'foreign-turn' WHERE session_id = ? AND seq = ?")
          .run(run.session_id as string, seq);
      });

      // The refusal and the publication are the two possible outcomes; the
      // wait ends at whichever happens first, so the assertion below is what
      // judges it rather than a timeout.
      const published = (): boolean =>
        damaged.client.events.some((event) => event.type === "run.ended" && event.payload.run.runId === damaged.runId);
      await until(() => damaged.client.isClosed || published(), "the host to refuse or publish");
      expect(damaged.interference.injected()).toBe(1);
      damaged.interference.restore();

      // No terminal was published for a batch the store cannot prove: the run
      // ends nowhere, and the host stops answering, exactly as an
      // unconfirmable commit must.
      expect(
        damaged.client.events.filter((event) => event.type === "run.ended" && event.payload.run.runId === damaged.runId),
      ).toHaveLength(0);
      expect(damaged.client.isClosed).toBe(true);
      expect(damaged.model.requests).toHaveLength(1);

      damaged.client.detach();
      await damaged.composed.host.shutdown();

      // Nothing was repaired and nothing was re-run: the landed batch is the
      // batch the store holds, with the rewritten record still in it.
      const database = new DatabaseSync(path);
      const run = database
        .prepare("SELECT status FROM runs WHERE run_id = ?")
        .get(damaged.runId) as Record<string, unknown>;
      const rewritten = database
        .prepare("SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND turn_id = 'foreign-turn'")
        .get(damaged.sessionId) as { readonly count?: number };
      database.close();
      expect(run["status"]).toBe("completed");
      expect(rewritten.count).toBe(1);

      // And the damaged evidence is refused wherever it is read: the run and
      // the history of its turn are both corruption now, never a payload.
      const restarted = await composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const reader = connect(restarted.host);
      await reader.describe();
      const got = await reader.call("runs.get", { runId: damaged.runId });
      expect(got.error?.code).toBe("INTERNAL_ERROR");
      const page = await reader.call("sessions.history", { sessionId: damaged.sessionId, limit: 5 });
      expect(page.error?.code).toBe("INTERNAL_ERROR");
      expect(restarted.repository.getSession(damaged.sessionId)?.status).toBe("blocked");

      reader.detach();
      await restarted.host.shutdown();
    });
  });
});
