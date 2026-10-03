/**
 * Repair Batch 1.5 at the platform boundary: the two R05 residuals as a real
 * client can walk into them.
 *
 * R05-A: a canonical record whose own seq lies outside the turn its id names
 * used to be published by `sessions.history` — the turn was provable, the
 * position was never checked. Here the smallest page a traversal can ask for
 * is refused over the wire, the session blocks, and the older run stays whole.
 *
 * R05-B: a lost terminal COMMIT receipt used to be confirmed — and the
 * terminal published — even after a record inside the landed range had been
 * rewritten. Here the receipt is lost for real, a record is rewritten inside
 * its own range, and the client never sees a terminal: the host stops
 * answering, and a restart refuses the damaged fact wherever it is read.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createClientOn, createHostPlatform, runSettled, waitFor } from "../helpers/platform.js";
import { demoPlugin, scriptedModel, textReply, toolReply } from "../helpers/demo-fixtures.js";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-integration-15-"));
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

/**
 * Interferes with the terminal COMMIT so the batch lands for real and the
 * caller still sees an error — the lost receipt the store's own evidence has
 * to reconcile. `damage` runs after the commit and before the error.
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

describe("R05 history refuses a record outside its own turn's committed range", () => {
  it("rejects the smallest page over the wire and keeps the older run whole", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "range.db");
      const tools = demoPlugin("tools", "observer", "observed");
      const model = scriptedModel([
        toolReply("c-1", "observer", { n: 1 }),
        textReply("one"),
        toolReply("c-2", "observer", { n: 2 }),
        textReply("two"),
      ]);

      // Two settled tool-carrying turns in one session: the ranges the damage
      // reaches across.
      const seedPlatform = await createHostPlatform({
        modelClient: model.client,
        plugins: [tools.plugin],
        persistence: { kind: "sqlite", location: path },
      });
      open.push({ close: () => seedPlatform.shutdown() });
      const seeder = createClientOn(seedPlatform);
      open.push({ close: async () => undefined });
      await seeder.connect();
      await seeder.plugins.enable({ pluginId: "tools" });
      const { session } = await seeder.sessions.create();
      const one = await seeder.runs.start({ sessionId: session.sessionId, submissionId: "sub-1", text: "same input" });
      await waitFor(() => runSettled(seeder.getSnapshot(), one.run.runId), { what: "the first run to settle" });
      const two = await seeder.runs.start({ sessionId: session.sessionId, submissionId: "sub-2", text: "same input" });
      await waitFor(() => runSettled(seeder.getSnapshot(), two.run.runId), { what: "the second run to settle" });
      seeder.disconnect();
      await seedPlatform.shutdown();

      // The damage: the second turn's closing assistant record claims the
      // first turn — a turn the store can prove, at a position it never
      // committed. Everything else about the record stays as committed.
      const database = new DatabaseSync(path);
      const older = database
        .prepare("SELECT turn_id FROM turns WHERE session_id = ? ORDER BY start_seq LIMIT 1")
        .get(session.sessionId) as { readonly turn_id?: string };
      const seq = database
        .prepare("SELECT seq FROM session_events WHERE session_id = ? AND type = 'message/assistant' ORDER BY seq DESC LIMIT 1")
        .get(session.sessionId) as { readonly seq?: number };
      database
        .prepare("UPDATE session_events SET turn_id = ? WHERE session_id = ? AND seq = ?")
        .run(older.turn_id as string, session.sessionId, seq.seq as number);
      database.close();

      const platform = await createHostPlatform({
        modelClient: scriptedModel([textReply("unused")]).client,
        plugins: [],
        persistence: { kind: "sqlite", location: path },
      });
      open.push({ close: () => platform.shutdown() });
      const client = createClientOn(platform);
      open.push({ close: async () => undefined });
      await client.connect();

      // The smallest page is the one that carries the rewritten record; it is
      // refused over the wire — never a page in the replica.
      let refused: string | undefined;
      try {
        await client.sessions.history({ sessionId: session.sessionId, limit: 1 });
      } catch (error) {
        refused = (error as { code?: string }).code;
      }
      expect(refused).toBe("INTERNAL_ERROR");
      expect(client.getSnapshot().history[session.sessionId]).toBeUndefined();
      expect(client.getSnapshot().status).toBe("ready");

      // The refusal is precise: the session blocks, the newer run is
      // corruption now, and the older run and its history are still served.
      const blocked = await client.sessions.get({ sessionId: session.sessionId });
      expect(blocked.session.status).toBe("blocked");
      let newerRefused: string | undefined;
      try {
        await client.runs.get({ runId: two.run.runId });
      } catch (error) {
        newerRefused = (error as { code?: string }).code;
      }
      expect(newerRefused).toBe("INTERNAL_ERROR");
      const olderRun = await client.runs.get({ runId: one.run.runId });
      expect(olderRun.run.status).toBe("completed");

      client.disconnect();
      await platform.shutdown();
    });
  });
});

describe("R05 a lost commit receipt never publishes a terminal for a rewritten range", () => {
  it("stops answering without a terminal, and a restart refuses the damaged fact", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "rewritten.db");
      const model = scriptedModel([textReply("answer")]);
      const platform = await createHostPlatform({
        modelClient: model.client,
        plugins: [],
        persistence: { kind: "sqlite", location: path },
      });
      open.push({ close: () => platform.shutdown() });
      const client = createClientOn(platform);
      open.push({ close: async () => undefined });
      await client.connect();
      const { session } = await client.sessions.create();

      // The receipt is lost for real: the terminal transaction commits, one
      // record inside its range is rewritten to a turn nothing agrees with,
      // and only then does the caller see the error.
      const interference = interfereWithTerminalCommitThen((database) => {
        const seq = database
          .prepare("SELECT seq FROM session_events WHERE session_id = ? AND type = 'message/assistant' ORDER BY seq LIMIT 1")
          .get(session.sessionId) as { readonly seq?: number };
        database
          .prepare("UPDATE session_events SET turn_id = 'foreign-turn' WHERE session_id = ? AND seq = ?")
          .run(session.sessionId, seq.seq as number);
      });
      const started = await client.runs.start({ sessionId: session.sessionId, submissionId: "sub-ack", text: "hello" });
      try {
        await waitFor(() => client.getSnapshot().status !== "ready", { what: "the host to stop answering" });
      } finally {
        interference.restore();
      }
      expect(interference.injected()).toBe(1);

      // No terminal ever reached the client, and the model was not asked
      // again: the revision was never re-run to explain the damage away.
      expect(runSettled(client.getSnapshot(), started.run.runId)).toBe(false);
      expect(model.requests).toHaveLength(1);
      client.disconnect();
      await platform.shutdown();

      // The landed batch is what the store holds — with the rewritten record
      // still in it — and a restart refuses it wherever it is read.
      const database = new DatabaseSync(path);
      const durable = database
        .prepare("SELECT status FROM runs WHERE run_id = ?")
        .get(started.run.runId) as { readonly status?: string };
      const rewritten = database
        .prepare("SELECT COUNT(*) AS count FROM session_events WHERE turn_id = 'foreign-turn'")
        .get() as { readonly count?: number };
      database.close();
      expect(durable.status).toBe("completed");
      expect(rewritten.count).toBe(1);

      const restarted = await createHostPlatform({
        modelClient: scriptedModel([textReply("unused")]).client,
        plugins: [],
        persistence: { kind: "sqlite", location: path },
      });
      open.push({ close: () => restarted.shutdown() });
      const reader = createClientOn(restarted);
      open.push({ close: async () => undefined });
      await reader.connect();

      let runRefused: string | undefined;
      try {
        await reader.runs.get({ runId: started.run.runId });
      } catch (error) {
        runRefused = (error as { code?: string }).code;
      }
      expect(runRefused).toBe("INTERNAL_ERROR");
      let historyRefused: string | undefined;
      try {
        await reader.sessions.history({ sessionId: session.sessionId, limit: 5 });
      } catch (error) {
        historyRefused = (error as { code?: string }).code;
      }
      expect(historyRefused).toBe("INTERNAL_ERROR");
      const blocked = await reader.sessions.get({ sessionId: session.sessionId });
      expect(blocked.session.status).toBe("blocked");

      reader.disconnect();
      await restarted.shutdown();
    });
  });
});
