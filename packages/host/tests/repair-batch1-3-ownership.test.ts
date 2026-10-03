/**
 * Repair Batch 1.3 — E2: Run / Turn durable ownership.
 *
 * A run's pointer to its turn and the turn index's own row are two halves of
 * one commit. The regressions here exchange them, move them, and rewrite the
 * accepted input they bind, and check that every public path still refuses the
 * result — while a store written before the binding existed is neither
 * repaired nor guessed at, and its unprovable facts never reach a model.
 *
 * The corruption matrix a reviewer will look for: an exchange (A), a tampered
 * accepted input (B), two claimants (C, covered with the other one-sided
 * cases in the earlier batches), a range that disagrees with the binding (D),
 * a binding in another session (E), the behavior after corruption (F), and
 * the rule that nothing is rewritten to make the damage go away (G).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../src/repository.js";

import {
  abortAwareReply,
  awaitRunTerminal,
  composeTestHost,
  connect,
  constantTool,
  createSessionThrough,
  flush,
  nextId,
  runToTerminal,
  scriptedModel,
  testPlugin,
  textReply,
  toolReply,
} from "./helpers/harness.js";

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-repair-13-own-"));
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

interface Seeded {
  readonly swapSession: string;
  readonly bystanderSession: string;
  readonly first: string;
  readonly second: string;
  readonly bystanderRun: string;
}

/**
 * Two sessions on one durable store: the first holds two tool-carrying runs
 * that really committed turns, the second holds one plain run — the bystander
 * that must survive whatever happens to the first.
 *
 * The two swap-session runs deliberately accept the *same* input text: their
 * turns are then indistinguishable by their content, and only the turn
 * index's own owner binding can tell which run committed which.
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

  const swap = await createSessionThrough(client);
  const one = await client.call("runs.start", {
    sessionId: swap.sessionId,
    submissionId: "sub-first",
    text: "same input",
  });
  const first = one.result?.run.runId as string;
  await awaitRunTerminal(client, first);
  const two = await client.call("runs.start", {
    sessionId: swap.sessionId,
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
    swapSession: swap.sessionId,
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
 * Every durable *canonical* row the ownership proof is made of, for "nothing
 * was rewritten".
 *
 * The session row is deliberately not part of it: blocking a session whose
 * facts cannot be read is a legitimate, required change, and it is asserted
 * where it happens. What must never change is the committed record itself —
 * the runs, the turn index and the log — and that is what this compares. The
 * turn columns are named rather than `*` so the fingerprint is also stable
 * across the migration that adds the owner column.
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

describe("E2 run/turn ownership", () => {
  it("refuses an exchange of two runs' committed turns, on every public path", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "swap.db");
      const seeded = await seed(path);

      // The exchange: each run takes the other's turn pointer and range. Each
      // turn still has exactly one claimant, each range still matches the turn
      // it names, every record is untouched and — because both runs accepted
      // the same input — the accepted-input binding cannot tell them apart
      // either. What changed is who committed what, and only the turn index's
      // own owner binding records that.
      const database = new DatabaseSync(path);
      const first = runClaim(database, seeded.first);
      const second = runClaim(database, seeded.second);
      const write = database.prepare(
        "UPDATE runs SET turn_id = ?, committed_from_seq = ?, committed_to_seq = ? WHERE run_id = ?",
      );
      write.run(second.turn_id, second.from, second.to, seeded.first);
      write.run(first.turn_id, first.from, first.to, seeded.second);
      database.close();
      const damaged = canonicalFingerprint(path, seeded.swapSession);

      const model = scriptedModel([textReply("unused")]);
      const composed = composeTestHost({ modelClient: model.client, location: path });
      const client = connect(composed.host);
      await client.describe();

      // Each public path refuses the damaged runs, and none of them is served
      // a repaired or partially correct record.
      const got = await client.call("runs.get", { runId: seeded.first });
      expect(got.error?.code).toBe("INTERNAL_ERROR");
      const gotElsewhere = await client.call("runs.get", { runId: seeded.second });
      expect(gotElsewhere.error?.code).toBe("INTERNAL_ERROR");
      const listed = await client.call("runs.list", { sessionId: seeded.swapSession });
      expect(listed.error?.code).toBe("INTERNAL_ERROR");
      const deduped = await client.call("runs.start", {
        sessionId: seeded.swapSession,
        submissionId: "sub-first",
        text: "same input",
      });
      expect(deduped.error?.code).toBe("INTERNAL_ERROR");
      const cancelled = await client.call("runs.cancel", { runId: seeded.first });
      expect(cancelled.error?.code).toBe("INTERNAL_ERROR");

      // The published cut refuses both, blocks their session, and leaves every
      // other session exactly as it was.
      const opened = await client.call("subscriptions.open", {});
      expect(opened.error).toBeUndefined();
      const snapshot = opened.result?.snapshot;
      const runIds = snapshot?.runs.items.map((run) => run.runId) ?? [];
      expect(runIds).not.toContain(seeded.first);
      expect(runIds).not.toContain(seeded.second);
      expect(runIds).toContain(seeded.bystanderRun);
      const damagedSession = snapshot?.sessions.items.find((s) => s.sessionId === seeded.swapSession);
      expect(damagedSession?.status).toBe("blocked");
      expect(composed.repository.getSession(seeded.swapSession)?.status).toBe("blocked");
      expect(composed.repository.getSession(seeded.bystanderSession)?.status).toBe("ready");

      // The bystander session is fully served, and nothing executed anywhere.
      const bystander = await client.call("runs.get", { runId: seeded.bystanderRun });
      expect(bystander.result?.run.status).toBe("completed");
      const bystanderRuns = await client.call("runs.list", { sessionId: seeded.bystanderSession });
      expect(bystanderRuns.error).toBeUndefined();
      const refused = await client.call("runs.start", {
        sessionId: seeded.swapSession,
        submissionId: nextId("sub"),
        text: "again",
      });
      expect(refused.error?.code).toBe("SESSION_UNAVAILABLE");
      expect(model.requests).toHaveLength(0);

      client.detach();
      await composed.host.shutdown();

      // And nothing was rewritten to make the damage go away: the committed
      // record is exactly what the swap left. The session row did change — a
      // corrupt session is durably blocked — and that is the one change the
      // host is supposed to make.
      expect(canonicalFingerprint(path, seeded.swapSession)).toBe(damaged);
    });
  });

  it("refuses a run whose accepted input is not its canonical user fact", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "input.db");
      const seeded = await seed(path);

      // The run's own accepted input is rewritten: the canonical turn still
      // says what was really asked, and the two must be the same text.
      const database = new DatabaseSync(path);
      database.prepare("UPDATE runs SET text = ? WHERE run_id = ?").run("TAMPERED", seeded.first);
      database.close();
      const damaged = canonicalFingerprint(path, seeded.swapSession);

      const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();

      const got = await client.call("runs.get", { runId: seeded.first });
      expect(got.error?.code).toBe("INTERNAL_ERROR");
      const listed = await client.call("runs.list", { sessionId: seeded.swapSession });
      expect(listed.error?.code).toBe("INTERNAL_ERROR");
      expect(composed.repository.getSession(seeded.swapSession)?.status).toBe("blocked");

      client.detach();
      await composed.host.shutdown();

      // The canonical user fact was not rewritten to agree with the tampered
      // input: the store still holds both, disagreeing.
      expect(canonicalFingerprint(path, seeded.swapSession)).toBe(damaged);
    });
  });

  it("refuses the same damage from the canonical side", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "canonical.db");
      const seeded = await seed(path);

      // The other direction: the canonical user fact is rewritten, the run's
      // accepted input is untouched. Same rule, same refusal.
      const database = new DatabaseSync(path);
      const row = database
        .prepare("SELECT seq, data FROM session_events WHERE session_id = ? AND type = 'message/user' ORDER BY seq LIMIT 1")
        .get(seeded.swapSession) as { readonly seq?: number; readonly data?: string };
      const text = (JSON.parse(row.data as string) as { text: string }).text;
      database
        .prepare("UPDATE session_events SET data = ? WHERE session_id = ? AND seq = ?")
        .run(JSON.stringify({ text: `${text} (edited)` }), seeded.swapSession, row.seq as number);
      database.close();
      const damaged = canonicalFingerprint(path, seeded.swapSession);

      const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();

      const got = await client.call("runs.get", { runId: seeded.first });
      expect(got.error?.code).toBe("INTERNAL_ERROR");
      expect(composed.repository.getSession(seeded.swapSession)?.status).toBe("blocked");

      client.detach();
      await composed.host.shutdown();
      expect(canonicalFingerprint(path, seeded.swapSession)).toBe(damaged);
    });
  });

  it("serves a run whose accepted input is verbatim, whitespace and Unicode included", async () => {
    const composed = composeTestHost({
      modelClient: scriptedModel([textReply("ok")], { repeatLast: true }).client,
    });
    const client = connect(composed.host);
    await client.describe();
    const session = await createSessionThrough(client);
    const text = "  padded\nline two 🙂\u0000 end  ";
    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "sub-verbatim",
      text,
    });
    const runId = started.result?.run.runId as string;
    const terminal = await awaitRunTerminal(client, runId);

    // Exact text, not a normalized one: the binding compares the decoded
    // values, and whitespace, newlines and Unicode are part of the value.
    expect(terminal.status).toBe("completed");
    expect(terminal.text).toBe(text);
    const page = await client.call("sessions.history", { sessionId: session.sessionId, limit: 5 });
    const user = page.result?.page.items.find((item) => item.kind === "user");
    expect(user !== undefined && user.kind === "user" ? user.text : undefined).toBe(text);

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses a run whose recorded range disagrees with its binding", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "range.db");
      const seeded = await seed(path);

      const database = new DatabaseSync(path);
      database.prepare("UPDATE runs SET committed_from_seq = committed_from_seq + 1 WHERE run_id = ?").run(seeded.first);
      database.close();

      const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();
      const got = await client.call("runs.get", { runId: seeded.first });
      expect(got.error?.code).toBe("INTERNAL_ERROR");
      expect(composed.repository.getSession(seeded.swapSession)?.status).toBe("blocked");
      client.detach();
      await composed.host.shutdown();
    });
  });

  it("refuses a binding that lives in another session", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "cross.db");
      const seeded = await seed(path);

      // The turn index row moves to the bystander session: the run's own
      // session no longer holds the turn it claims.
      const database = new DatabaseSync(path);
      const turn = runClaim(database, seeded.first).turn_id;
      database
        .prepare("UPDATE turns SET session_id = ? WHERE session_id = ? AND turn_id = ?")
        .run(seeded.bystanderSession, seeded.swapSession, turn);
      database.close();

      const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();
      const got = await client.call("runs.get", { runId: seeded.first });
      expect(got.error?.code).toBe("INTERNAL_ERROR");
      expect(composed.repository.getSession(seeded.swapSession)?.status).toBe("blocked");
      // The bystander's own facts are still served: corruption is contained.
      const bystander = await client.call("runs.get", { runId: seeded.bystanderRun });
      expect(bystander.result?.run.status).toBe("completed");
      client.detach();
      await composed.host.shutdown();
    });
  });

  it("keeps a corrupted session readable, renameable and deletable", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "metadata.db");
      const seeded = await seed(path);

      const database = new DatabaseSync(path);
      database.prepare("UPDATE runs SET text = ? WHERE run_id = ?").run("TAMPERED", seeded.first);
      database.close();

      const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();
      await client.call("runs.get", { runId: seeded.first });

      // Blocked is a safe state, not a dead one: the summary is readable and
      // the metadata operations still work against the revision it reports.
      const summary = await client.call("sessions.get", { sessionId: seeded.swapSession });
      expect(summary.result?.session.status).toBe("blocked");
      const renamed = await client.call("sessions.rename", {
        sessionId: seeded.swapSession,
        expectedRevision: summary.result?.session.metadataRevision as number,
        title: "still mine",
      });
      expect(renamed.error).toBeUndefined();
      const deleted = await client.call("sessions.delete", {
        sessionId: seeded.swapSession,
        expectedRevision: renamed.result?.session.metadataRevision as number,
      });
      expect(deleted.error).toBeUndefined();
      // And a later query answers as a deleted session, not a corrupt one.
      const gone = await client.call("sessions.get", { sessionId: seeded.swapSession });
      expect(gone.error?.code).toBe("SESSION_NOT_FOUND");

      client.detach();
      await composed.host.shutdown();
    });
  });

  it("serves the settled turns that are not `completed` exactly as they were committed", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settled.db");
      const composed = composeTestHost({
        modelClient: scriptedModel([
          // One turn that spends the whole step budget on tool calls — twelve
          // model calls, one per step, and then the limit...
          ...Array.from({ length: 12 }, () => toolReply("c-1", "observer", { n: 1 })),
          // ...and one that is cancelled while its model step is still open.
          abortAwareReply(),
        ]).client,
        plugins: [testPlugin({ id: "tools", tools: [constantTool("observer")] })],
        location: path,
      });
      const client = connect(composed.host);
      await client.describe();
      await client.call("plugins.enable", { pluginId: "tools" });

      const limitedSession = await createSessionThrough(client);
      const limited = await runToTerminal(client, limitedSession.sessionId, "count forever");
      expect(limited.status).toBe("limited");

      const cancelSession = await createSessionThrough(client);
      const started = await client.call("runs.start", {
        sessionId: cancelSession.sessionId,
        submissionId: "sub-cancel",
        text: "slow",
      });
      const cancelRun = started.result?.run.runId as string;
      await flush();
      await client.call("runs.cancel", { runId: cancelRun });
      const cancelled = await awaitRunTerminal(client, cancelRun);
      expect(cancelled.status).toBe("cancelled");

      client.detach();
      await composed.host.shutdown();

      // Both are read back from a fresh host: the binding holds for every
      // settled outcome, not only for `completed`.
      const restarted = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const reader = connect(restarted.host);
      await reader.describe();
      const keptLimited = await reader.call("runs.get", { runId: limited.runId });
      expect(keptLimited.result?.run.status).toBe("limited");
      const keptCancelled = await reader.call("runs.get", { runId: cancelRun });
      expect(keptCancelled.result?.run.status).toBe("cancelled");
      reader.detach();
      await restarted.host.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// The legacy store: no binding exists, and nothing invents one.
// ---------------------------------------------------------------------------

/**
 * A store exactly as the pre-binding build wrote it: schema version 1, whose
 * turn index has no owner column at all.
 *
 * The fixture is the v1 schema pinned by hand — the shape the migration has to
 * accept — with a settled run whose turn cannot be proven to be its own, and a
 * session carrying a canonical turn with no run at all.
 */
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
  for (const session of ["s-legacy", "s-window"]) {
    database
      .prepare(
        `INSERT INTO sessions (session_id, generation, title, created_at, updated_at, metadata_revision,
           history_revision, committed_seq, status, blocked_reason, active_run_id)
         VALUES (?, 1, ?, 1, 1, 0, ?, 4, 'ready', NULL, NULL)`,
      )
      .run(session, `legacy ${session}`, session === "s-legacy" ? 1 : 0);
    for (const event of events) {
      database
        .prepare("INSERT INTO session_events (session_id, seq, turn_id, type, time, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run(session, event.seq, event.turnId, event.type, 1 + event.seq, JSON.stringify(event.data));
    }
    database
      .prepare("INSERT INTO turns (session_id, turn_id, start_seq, end_seq, reason) VALUES (?, 't-legacy', 0, 4, 'completed')")
      .run(session);
  }
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

describe("E2 legacy stores", () => {
  it("migrates without inventing ownership, refuses the unprovable facts, and keeps the store", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "legacy.db");
      writeV1Store(path);
      const before = canonicalFingerprint(path, "s-legacy");

      const model = scriptedModel([textReply("unused")]);
      const composed = composeTestHost({ modelClient: model.client, location: path });
      expect(composed.repository.schemaVersion).toBe(SCHEMA_VERSION);
      const client = connect(composed.host);
      await client.describe();

      // The legacy terminal cannot be proven to be this run's own commit, so
      // it is refused rather than served as a trusted completed run — and the
      // refusal is the existing corruption semantics: a blocked session, a
      // safe error, no payload.
      const got = await client.call("runs.get", { runId: "r-legacy" });
      expect(got.error?.code).toBe("INTERNAL_ERROR");
      expect(composed.repository.getSession("s-legacy")?.status).toBe("blocked");

      // The session that only carries a canonical turn — no run at all — is
      // not blocked by a read (there is no run to read): its unprovable turn
      // is refused where it would matter, when a new run would be handed it
      // as history.
      const windowed = await client.call("runs.start", {
        sessionId: "s-window",
        submissionId: nextId("sub"),
        text: "continue",
      });
      expect(windowed.error).toBeUndefined();
      const terminal = await awaitRunTerminal(client, windowed.result?.run.runId as string);
      expect(terminal.status).toBe("failed");
      expect(terminal.endReason).toBe("host_error");
      expect(model.requests).toHaveLength(0);
      expect(composed.repository.getSession("s-window")?.status).toBe("blocked");

      client.detach();
      await composed.host.shutdown();

      // What the migration did, checked from the file: the schema advanced,
      // the legacy turn still has no owner (nothing was backfilled from the
      // run's current pointer), and every legacy row is exactly as it was.
      const database = new DatabaseSync(path);
      const version = database.prepare("PRAGMA user_version").get() as { readonly user_version?: number };
      expect(version.user_version).toBe(SCHEMA_VERSION);
      const owners = database.prepare("SELECT session_id, run_id FROM turns ORDER BY session_id").all() as {
        readonly run_id?: string | null;
      }[];
      expect(owners.map((row) => row.run_id ?? null)).toEqual([null, null]);
      database.close();
      expect(canonicalFingerprint(path, "s-legacy")).toBe(before);
    });
  });
});
