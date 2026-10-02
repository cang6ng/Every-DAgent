/**
 * Repair Batch 1.4 at the platform boundary: the two residuals a real client
 * could still walk into.
 *
 * R02: after a storage fault, repeating the *same* submission used to be
 * answered out of the dedup read with its original `running` run — a trusted
 * current-state presentation from a host that cannot confirm outcomes. Here
 * the same submission is repeated through a brand-new client and answered
 * STORAGE_UNAVAILABLE, with nothing re-executed and nothing durable changed.
 *
 * R05: `sessions.history` used to publish canonical facts without proving the
 * turn they belong to was committed by the run that owns it. Here a rewritten
 * canonical user fact makes the history read refuse over the wire — the
 * session is blocked, no page is served, and the other session is untouched.
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
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-integration-14-"));
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

/** Interferes with the terminal COMMIT so neither it nor its rollback can be judged. */
function interfereWithEndingTheTransaction(): { injected(): number; restore(): void } {
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  let armed = false;
  let stuck = false;
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
      stuck = true;
      throw new Error("injected: the commit never ran");
    }
    if (stuck && sql === "ROLLBACK") {
      stuck = false;
      throw new Error("injected: the rollback never ran");
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

describe("R02 a repeated submission is refused on a faulted platform", () => {
  it("answers the dedup hit with STORAGE_UNAVAILABLE, re-runs nothing, and keeps the durable fact", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "fault.db");
      const tools = demoPlugin("tools", "observer", "observed");
      const model = scriptedModel([toolReply("call-1", "observer", { n: 1 }), textReply("finished")]);
      const platform = createHostPlatform({
        modelClient: model.client,
        plugins: [tools.plugin],
        persistence: { kind: "sqlite", location: path },
      });
      open.push({ close: () => platform.shutdown() });

      const watcher = createClientOn(platform);
      open.push({ close: async () => undefined });
      await watcher.connect();
      await watcher.plugins.enable({ pluginId: "tools" });
      const { session } = await watcher.sessions.create();
      const started = await watcher.runs.start({
        sessionId: session.sessionId,
        submissionId: "sub-fault",
        text: "use the tool",
      });
      const runId = started.run.runId;

      const interference = interfereWithEndingTheTransaction();
      try {
        await waitFor(() => watcher.getSnapshot().status !== "ready", { what: "the invalidation" });
      } finally {
        interference.restore();
      }
      expect(interference.injected()).toBe(1);

      // A brand-new client cannot bootstrap, and the *same* submission id —
      // the one the store already knows — is refused like everything else on
      // this host. It is not answered from the dedup read with `running`.
      const fresh = createClientOn(platform);
      open.push({ close: async () => undefined });
      try {
        await fresh.connect();
      } catch {
        // The refused bootstrap is the expected path; the request below still
        // reaches the host and is what this regression is about.
      }
      let refused: string | undefined;
      let payload: unknown;
      try {
        payload = await fresh.runs.start({
          sessionId: session.sessionId,
          submissionId: "sub-fault",
          text: "use the tool",
        });
      } catch (error) {
        refused = (error as { code?: string }).code;
      }
      expect(payload).toBeUndefined();
      expect(refused).toBe("STORAGE_UNAVAILABLE");

      watcher.disconnect();
      await platform.shutdown();

      // The durable truth and the execution count are unchanged: one model
      // call sequence and one tool execution, an unfinished run, no terminal.
      const database = new DatabaseSync(path);
      const durable = database.prepare("SELECT status, turn_id, committed_from_seq FROM runs WHERE run_id = ?").get(runId) as {
        readonly status?: string;
        readonly turn_id?: string | null;
        readonly committed_from_seq?: number | null;
      };
      const events = database.prepare("SELECT COUNT(*) AS count FROM session_events").get() as { readonly count?: number };
      database.close();
      expect(durable.status).toBe("running");
      expect(durable.turn_id ?? null).toBeNull();
      expect(durable.committed_from_seq ?? null).toBeNull();
      expect(events.count).toBe(0);
      expect(model.requests).toHaveLength(2);
      expect(tools.executions.length).toBe(1);
    });
  });
});

describe("R05 history is refused when its turn ownership cannot be proven", () => {
  it("rejects the history read, blocks the session, and leaves the other one intact", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "history.db");

      // Two settled conversations: the one that will be tampered with, and the
      // bystander whose facts must be served exactly as committed.
      const seedPlatform = createHostPlatform({
        modelClient: scriptedModel([textReply("an answer"), textReply("bystander answer")]).client,
        plugins: [],
        persistence: { kind: "sqlite", location: path },
      });
      open.push({ close: () => seedPlatform.shutdown() });
      const seeder = createClientOn(seedPlatform);
      open.push({ close: async () => undefined });
      await seeder.connect();
      const damaged = await seeder.sessions.create();
      const one = await seeder.runs.start({
        sessionId: damaged.session.sessionId,
        submissionId: "sub-damaged",
        text: "the original question",
      });
      await waitFor(() => runSettled(seeder.getSnapshot(), one.run.runId), { what: "the first run to settle" });
      const bystander = await seeder.sessions.create();
      const other = await seeder.runs.start({
        sessionId: bystander.session.sessionId,
        submissionId: "sub-bystander",
        text: "keep me",
      });
      await waitFor(() => runSettled(seeder.getSnapshot(), other.run.runId), { what: "the bystander to settle" });
      seeder.disconnect();
      await seedPlatform.shutdown();

      // The damage: the canonical first user fact is rewritten while the run
      // keeps the input it accepted. Only the input binding can tell.
      const database = new DatabaseSync(path);
      database
        .prepare("UPDATE session_events SET data = ? WHERE session_id = ? AND type = 'message/user'")
        .run(JSON.stringify({ text: "TAMPERED" }), damaged.session.sessionId);
      database.close();

      const platform = createHostPlatform({
        modelClient: scriptedModel([textReply("unused")]).client,
        plugins: [],
        persistence: { kind: "sqlite", location: path },
      });
      open.push({ close: () => platform.shutdown() });
      const client = createClientOn(platform);
      open.push({ close: async () => undefined });
      await client.connect();

      // The history read is the first thing to touch the damaged session, and
      // it is refused over the wire — never served as a page.
      let refused: string | undefined;
      try {
        await client.sessions.history({ sessionId: damaged.session.sessionId, limit: 5 });
      } catch (error) {
        refused = (error as { code?: string }).code;
      }
      expect(refused).toBe("INTERNAL_ERROR");
      expect(client.getSnapshot().history[damaged.session.sessionId]).toBeUndefined();
      expect(client.getSnapshot().status).toBe("ready");

      // The block is the safe state, and the damage is contained: the other
      // session reads end to end, and the health of the host is untouched.
      const blocked = await client.sessions.get({ sessionId: damaged.session.sessionId });
      expect(blocked.session.status).toBe("blocked");
      const kept = await client.sessions.history({ sessionId: bystander.session.sessionId, limit: 5 });
      expect(kept.page.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
      const readable = await client.runs.get({ runId: other.run.runId });
      expect(readable.run.status).toBe("completed");

      client.disconnect();
      await platform.shutdown();
    });
  });
});
