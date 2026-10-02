/**
 * Repair Batch 1.4 — R05 residuals: history is durable fact, and a lost
 * commit receipt is not a licence to publish a terminal.
 *
 * Two gaps are closed here, and both are the same rule seen from two sides.
 *
 * `sessions.history` used to publish committed records without asking whether
 * the turn they belong to is a turn any run is proven to have committed: an
 * exchanged run pointer, a rewritten canonical user fact and a migrated legacy
 * turn all still came out of it as trusted history. Now every distinct turn a
 * served page covers is held to the ownership proof — owner binding, exact
 * range, reason, accepted input — while a page stays a legal fragment.
 *
 * And the confirmation of a lost commit receipt used to accept a batch whose
 * own turn index and run row disagreed about the range. That confirmation is
 * what decides whether a terminal is published, so it now asks the same
 * ownership proof; a batch the store cannot prove is not published, and the
 * durable rows are left exactly as they were found.
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
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-repair-14-own-"));
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
  readonly damagedSession: string;
  readonly bystanderSession: string;
  readonly first: string;
  readonly second: string;
  readonly bystanderRun: string;
}

/**
 * Two sessions on one durable store: the first holds two tool-carrying runs
 * that really committed turns (the pair every tamper below targets), the
 * second holds one plain run whose facts must survive whatever happens.
 */
async function seed(path: string): Promise<Seeded> {
  const composed = composeTestHost({
    modelClient: scriptedModel(
      [
        toolReply("c-1", "observer", { n: 1 }),
        textReply("one"),
        toolReply("c-2", "observer", { n: 2 }),
        textReply("two"),
        textReply("bystander"),
      ],
      { repeatLast: true },
    ).client,
    plugins: [testPlugin({ id: "tools", tools: [constantTool("observer")] })],
    location: path,
  });
  const client = connect(composed.host);
  await client.describe();
  await client.call("plugins.enable", { pluginId: "tools" });

  const damaged = await createSessionThrough(client);
  const one = await client.call("runs.start", {
    sessionId: damaged.sessionId,
    submissionId: "sub-first",
    text: "same input",
  });
  const first = one.result?.run.runId as string;
  await awaitRunTerminal(client, first);
  const two = await client.call("runs.start", {
    sessionId: damaged.sessionId,
    submissionId: "sub-second",
    text: "same input",
  });
  const second = two.result?.run.runId as string;
  await awaitRunTerminal(client, second);

  const bystander = await createSessionThrough(client);
  const other = await client.call("runs.start", {
    sessionId: bystander.sessionId,
    submissionId: "sub-bystander",
    text: "bystander",
  });
  const bystanderRun = other.result?.run.runId as string;
  await awaitRunTerminal(client, bystanderRun);

  client.detach();
  await composed.host.shutdown();
  return {
    damagedSession: damaged.sessionId,
    bystanderSession: bystander.sessionId,
    first,
    second,
    bystanderRun,
  };
}

/** One run row's committed claim, as the tests tamper with it. */
function runClaim(database: DatabaseSync, runId: string): { turn_id: string; from: number; to: number } {
  const row = database
    .prepare("SELECT turn_id, committed_from_seq, committed_to_seq FROM runs WHERE run_id = ?")
    .get(runId) as { readonly turn_id?: string; readonly committed_from_seq?: number; readonly committed_to_seq?: number };
  return {
    turn_id: row.turn_id as string,
    from: row.committed_from_seq as number,
    to: row.committed_to_seq as number,
  };
}

/**
 * Every durable canonical row the ownership proof is made of, for "nothing
 * was rewritten": the runs, the turn index (named columns, so the fingerprint
 * is stable) and the log.
 */
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

const TAMPERED_USER = JSON.stringify({ text: "TAMPERED" });

/** Rewrites the newest canonical user fact of one session. */
function tamperNewestUserFact(database: DatabaseSync, sessionId: string): void {
  const row = database
    .prepare("SELECT seq FROM session_events WHERE session_id = ? AND type = 'message/user' ORDER BY seq DESC LIMIT 1")
    .get(sessionId) as { readonly seq?: number };
  database
    .prepare("UPDATE session_events SET data = ? WHERE session_id = ? AND seq = ?")
    .run(TAMPERED_USER, sessionId, row.seq as number);
}

// ---------------------------------------------------------------------------
// R05-a — a history page may be a fragment, never an unprovable fact.
// ---------------------------------------------------------------------------

describe("R05 history is held to the ownership proof", () => {
  it("refuses history whose turns are not the turns their runs committed", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "swap.db");
      const seeded = await seed(path);

      // The exchange: each run takes the other's turn pointer and range. The
      // turn index keeps its original owner binding, so the two sides now
      // disagree — and the canonical log is untouched.
      const database = new DatabaseSync(path);
      const first = runClaim(database, seeded.first);
      const second = runClaim(database, seeded.second);
      const write = database.prepare(
        "UPDATE runs SET turn_id = ?, committed_from_seq = ?, committed_to_seq = ? WHERE run_id = ?",
      );
      write.run(second.turn_id, second.from, second.to, seeded.first);
      write.run(first.turn_id, first.from, first.to, seeded.second);
      database.close();
      const damaged = canonicalFingerprint(path, seeded.damagedSession);

      const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();

      // The history read is the first thing to touch this session, and it must
      // find the damage on its own: no fragment is served, and the refusal is
      // the existing corruption answer, never a payload.
      const page = await client.call("sessions.history", { sessionId: seeded.damagedSession, limit: 5 });
      expect(page.error?.code).toBe("INTERNAL_ERROR");
      expect(page.result).toBeUndefined();
      expect(composed.repository.getSession(seeded.damagedSession)?.status).toBe("blocked");

      // The damage is contained: the other session's history and runs are
      // served exactly as committed, and nothing executed anywhere.
      const bystander = await client.call("sessions.history", { sessionId: seeded.bystanderSession, limit: 5 });
      expect(bystander.error).toBeUndefined();
      expect(bystander.result?.page.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
      const kept = await client.call("runs.get", { runId: seeded.bystanderRun });
      expect(kept.result?.run.status).toBe("completed");

      // A blocked session is still an administrable one.
      const summary = await client.call("sessions.get", { sessionId: seeded.damagedSession });
      expect(summary.result?.session.status).toBe("blocked");
      const renamed = await client.call("sessions.rename", {
        sessionId: seeded.damagedSession,
        expectedRevision: summary.result?.session.metadataRevision as number,
        title: "still mine",
      });
      expect(renamed.error).toBeUndefined();

      client.detach();
      await composed.host.shutdown();
      // Nothing was rewritten to make the damage go away: the store holds the
      // exchange exactly as it was found.
      expect(canonicalFingerprint(path, seeded.damagedSession)).toBe(damaged);

      // A restart reconciles nothing here: the block is durable, the ownership
      // damage is durable, and the history is still refused.
      const restarted = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const reader = connect(restarted.host);
      await reader.describe();
      const again = await reader.call("sessions.history", { sessionId: seeded.damagedSession, limit: 5 });
      expect(again.error?.code).toBe("INTERNAL_ERROR");
      expect(again.result).toBeUndefined();
      const run = await reader.call("runs.get", { runId: seeded.first });
      expect(run.error?.code).toBe("INTERNAL_ERROR");

      reader.detach();
      await restarted.host.shutdown();
      // Not even the restart rewrote a row.
      expect(canonicalFingerprint(path, seeded.damagedSession)).toBe(damaged);
    });
  });

  it("refuses history whose canonical user fact is not the accepted input", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "tamper.db");
      const seeded = await seed(path);

      // The run keeps the input it accepted; the canonical first user fact of
      // its turn is rewritten. Only the input binding can tell.
      const database = new DatabaseSync(path);
      tamperNewestUserFact(database, seeded.damagedSession);
      database.close();
      const damaged = canonicalFingerprint(path, seeded.damagedSession);

      const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();

      const page = await client.call("sessions.history", { sessionId: seeded.damagedSession, limit: 5 });
      expect(page.error?.code).toBe("INTERNAL_ERROR");
      expect(page.result).toBeUndefined();
      expect(composed.repository.getSession(seeded.damagedSession)?.status).toBe("blocked");

      client.detach();
      await composed.host.shutdown();
      // The TAMPERED fact was neither published nor repaired away.
      expect(canonicalFingerprint(path, seeded.damagedSession)).toBe(damaged);
    });
  });

  it("serves valid modern history, fragments included, exactly as committed", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "valid.db");
      const seeded = await seed(path);

      const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();

      // One item per page: the traversal splits the tool occurrence, and every
      // page — call-only, result-only, turn-middle — is served and provable.
      const items: { readonly kind: string; readonly seq: number }[] = [];
      const pagesWith: string[][] = [];
      let cursor: string | undefined;
      let previousFrom: number | undefined;
      let pages = 0;
      for (;;) {
        const answer = await client.call("sessions.history", {
          sessionId: seeded.damagedSession,
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(answer.error).toBeUndefined();
        const page = answer.result?.page;
        if (page === undefined) throw new Error("the page was not served");
        pages += 1;
        expect(page.items.length).toBeLessThanOrEqual(1);
        if (previousFrom !== undefined) expect(page.coverage.toSeq).toBe(previousFrom);
        previousFrom = page.coverage.fromSeq;
        items.unshift(...page.items.map((item) => ({ kind: item.kind, seq: item.seq })));
        pagesWith.push(page.items.map((item) => item.kind));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
        if (pages > 40) throw new Error("the traversal did not end");
      }

      expect(items.map((item) => item.kind)).toEqual([
        "user",
        "assistant",
        "tool-call",
        "tool-result",
        "assistant",
        "user",
        "assistant",
        "tool-call",
        "tool-result",
        "assistant",
      ]);
      expect(pagesWith.some((kinds) => kinds.length === 1 && kinds[0] === "tool-call")).toBe(true);
      expect(pagesWith.some((kinds) => kinds.length === 1 && kinds[0] === "tool-result")).toBe(true);
      // Reading fragments is not corruption: the session is ready and usable.
      expect(composed.repository.getSession(seeded.damagedSession)?.status).toBe("ready");

      client.detach();
      await composed.host.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// The legacy store: migrated, still unprovable, and refused by history too.
// ---------------------------------------------------------------------------

/** A store exactly as the pre-binding build wrote it: schema version 1, no owner column. */
function writeV1Store(path: string): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, title TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      metadata_revision INTEGER NOT NULL, history_revision INTEGER NOT NULL,
      committed_seq INTEGER NOT NULL, status TEXT NOT NULL, blocked_reason TEXT, active_run_id TEXT
    );
    CREATE TABLE deleted_sessions (session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, deleted_at INTEGER NOT NULL);
    CREATE TABLE session_events (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, turn_id TEXT NOT NULL, type TEXT NOT NULL, time INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE turns (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL, reason TEXT NOT NULL,
      PRIMARY KEY (session_id, turn_id)
    );
    CREATE INDEX turns_by_start ON turns (session_id, start_seq DESC);
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, session_id TEXT NOT NULL, text TEXT NOT NULL,
      accepted_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, host_instance_id TEXT NOT NULL,
      status TEXT NOT NULL, end_reason TEXT, error_code TEXT, execution_knowledge TEXT, turn_id TEXT,
      cancel_requested INTEGER NOT NULL, committed_from_seq INTEGER, committed_to_seq INTEGER
    );
    CREATE INDEX runs_by_session ON runs (session_id, accepted_at DESC, run_id DESC);
    CREATE TABLE submissions (
      submission_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      run_id TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE collections (name TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    INSERT INTO collections (name, revision) VALUES ('sessions', 0), ('runs', 0), ('plugins', 0);
  `);
  database.prepare("INSERT INTO meta (key, value) VALUES ('storageId', ?)").run("legacy-storage");
  const events = [
    { seq: 0, turnId: "t-legacy", type: "turn/start", data: {} },
    { seq: 1, turnId: "t-legacy", type: "message/user", data: { text: "hello legacy" } },
    { seq: 2, turnId: "t-legacy", type: "message/assistant", data: { text: "ok", toolCalls: [] } },
    { seq: 3, turnId: "t-legacy", type: "turn/end", data: { reason: "completed" } },
  ];
  database
    .prepare(
      `INSERT INTO sessions (session_id, generation, title, created_at, updated_at, metadata_revision,
         history_revision, committed_seq, status, blocked_reason, active_run_id)
       VALUES ('s-legacy', 1, 'legacy', 1, 1, 0, 1, 4, 'ready', NULL, NULL)`,
    )
    .run();
  for (const event of events) {
    database
      .prepare("INSERT INTO session_events (session_id, seq, turn_id, type, time, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s-legacy", event.seq, event.turnId, event.type, 1 + event.seq, JSON.stringify(event.data));
  }
  database
    .prepare("INSERT INTO turns (session_id, turn_id, start_seq, end_seq, reason) VALUES ('s-legacy', 't-legacy', 0, 4, 'completed')")
    .run();
  database
    .prepare(
      `INSERT INTO runs (run_id, submission_id, session_id, text, accepted_at, started_at, ended_at, host_instance_id,
         status, end_reason, error_code, execution_knowledge, turn_id, cancel_requested, committed_from_seq, committed_to_seq)
       VALUES ('r-legacy', 'sub-legacy', 's-legacy', 'hello legacy', 1, 2, 4, 'h-old', 'completed', 'completed', NULL, NULL,
         't-legacy', 0, 0, 4)`,
    )
    .run();
  database
    .prepare("INSERT INTO submissions (submission_id, session_id, input_hash, run_id, state, created_at) VALUES ('sub-legacy', 's-legacy', 'hash', 'r-legacy', 'active', 1)")
    .run();
  database.exec("PRAGMA user_version = 1");
  database.close();
}

describe("R05 legacy history fails closed", () => {
  it("migrates the store but never presents the unowned turn as trusted history", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "legacy.db");
      writeV1Store(path);
      const before = canonicalFingerprint(path, "s-legacy");

      const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      expect(composed.repository.schemaVersion).toBe(2);
      const client = connect(composed.host);
      await client.describe();

      // The migration succeeded, and that is exactly what must not be mistaken
      // for proof: the legacy turn still has no owner, so its history is not
      // published — the page is refused and the session blocked.
      const page = await client.call("sessions.history", { sessionId: "s-legacy", limit: 5 });
      expect(page.error?.code).toBe("INTERNAL_ERROR");
      expect(page.result).toBeUndefined();
      expect(composed.repository.getSession("s-legacy")?.status).toBe("blocked");

      client.detach();
      await composed.host.shutdown();

      // The store is preserved: schema advanced, no backfilled owner, every
      // legacy row byte-for-byte as the old build wrote it.
      const database = new DatabaseSync(path);
      const version = database.prepare("PRAGMA user_version").get() as { readonly user_version?: number };
      expect(version.user_version).toBe(2);
      const owners = database.prepare("SELECT run_id FROM turns").all() as { readonly run_id?: string | null }[];
      expect(owners.map((row) => row.run_id ?? null)).toEqual([null]);
      database.close();
      expect(canonicalFingerprint(path, "s-legacy")).toBe(before);
    });
  });
});

// ---------------------------------------------------------------------------
// R05-b — the commit confirmation asks the same ownership proof.
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

/**
 * One run started on a durable store, whose terminal commit is about to land
 * and lose its receipt.
 */
async function runAwaitingLostReceipt(
  path: string,
  damage: ((database: DatabaseSync, runId: string) => void) | undefined,
): Promise<{
  readonly composed: ReturnType<typeof composeTestHost>;
  readonly model: ReturnType<typeof scriptedModel>;
  readonly client: ReturnType<typeof connect>;
  readonly sessionId: string;
  readonly runId: string;
  readonly interference: { injected(): number; restore(): void };
}> {
  const model = scriptedModel([textReply("answer")]);
  const composed = composeTestHost({ modelClient: model.client, location: path });
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

describe("R05 lost commit receipts are confirmed by the ownership proof", () => {
  it("publishes the real terminal when the landed batch proves itself", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "landed.db");
      const landed = await runAwaitingLostReceipt(path, undefined);

      const terminal = await awaitRunTerminal(landed.client, landed.runId);
      expect(landed.interference.injected()).toBe(1);
      landed.interference.restore();

      // The lost receipt was reconciled against the batch's own evidence, and
      // the recovered outcome is the real one — no fabricated failure, and no
      // second execution.
      expect(terminal.status).toBe("completed");
      const got = await landed.client.call("runs.get", { runId: landed.runId });
      expect(got.result?.run.status).toBe("completed");
      expect(landed.model.requests).toHaveLength(1);
      expect(landed.composed.repository.getRun(landed.runId)?.status).toBe("completed");
      // The history of the recovered turn is served as any committed one.
      const page = await landed.client.call("sessions.history", { sessionId: landed.sessionId, limit: 5 });
      expect(page.result?.page.items.map((item) => item.kind)).toEqual(["user", "assistant"]);

      landed.client.detach();
      await landed.composed.host.shutdown();
    });
  });

  const DAMAGE: readonly {
    readonly what: string;
    readonly harm: (database: DatabaseSync, runId: string) => void;
  }[] = [
    {
      what: "the run's committed start moves off the turn",
      harm: (database, runId) =>
        database.prepare("UPDATE runs SET committed_from_seq = committed_from_seq - 1 WHERE run_id = ?").run(runId),
    },
    {
      what: "the run's committed end moves off the turn",
      harm: (database, runId) =>
        database.prepare("UPDATE runs SET committed_to_seq = committed_to_seq - 1 WHERE run_id = ?").run(runId),
    },
    {
      what: "the run names a turn it did not commit",
      harm: (database, runId) =>
        database.prepare("UPDATE runs SET turn_id = 'other-turn' WHERE run_id = ?").run(runId),
    },
    {
      what: "the turn index names another owner",
      harm: (database, runId) => {
        const row = database.prepare("SELECT session_id, turn_id FROM runs WHERE run_id = ?").get(runId) as {
          readonly session_id?: string;
          readonly turn_id?: string;
        };
        database
          .prepare("UPDATE turns SET run_id = 'other-run' WHERE session_id = ? AND turn_id = ?")
          .run(row.session_id as string, row.turn_id as string);
      },
    },
    {
      what: "the accepted input no longer matches the canonical user fact",
      harm: (database, runId) =>
        database.prepare("UPDATE runs SET text = 'TAMPERED' WHERE run_id = ?").run(runId),
    },
  ];

  for (const { what, harm } of DAMAGE) {
    it(`refuses to publish a terminal whose evidence disagrees: ${what}`, async () => {
      await withTempDir(async (dir) => {
        const path = join(dir, "damaged.db");
        const damaged = await runAwaitingLostReceipt(path, harm);

        // The refusal and the publication are the two possible outcomes; the
        // wait ends at whichever happens first, so the assertion below is what
        // judges it rather than a timeout.
        const published = (): boolean =>
          damaged.client.events.some(
            (event) => event.type === "run.ended" && event.payload.run.runId === damaged.runId,
          );
        await until(() => damaged.client.isClosed || published(), "the host to refuse or publish");
        expect(damaged.interference.injected()).toBe(1);
        damaged.interference.restore();

        // No terminal was published for a batch the store cannot prove: the
        // run ends nowhere — no run.ended, no fabricated outcome — and the
        // host stops answering, exactly as an unconfirmable commit must.
        expect(
          damaged.client.events.filter(
            (event) => event.type === "run.ended" && event.payload.run.runId === damaged.runId,
          ),
        ).toHaveLength(0);
        expect(damaged.client.isClosed).toBe(true);
        expect(damaged.model.requests).toHaveLength(1);

        damaged.client.detach();
        await damaged.composed.host.shutdown();

        // Nothing was repaired into place, and nothing was re-run: the batch
        // the store holds is still the batch it landed — with the damage.
        const database = new DatabaseSync(path);
        const run = database
          .prepare("SELECT status, turn_id, committed_from_seq, committed_to_seq, text FROM runs WHERE run_id = ?")
          .get(damaged.runId) as Record<string, unknown>;
        database.close();
        expect(run["status"]).toBe("completed");

        // And the damaged evidence is refused wherever it is read: the run and
        // the history of its turn are both corruption now, never a payload.
        const restarted = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
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
  }
});
