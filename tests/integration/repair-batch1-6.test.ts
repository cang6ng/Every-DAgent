/**
 * Repair Batch 1.6 at the platform boundary: N1 — a turn row and its owner
 * run's row moved together must not let a real client read a fragment of a
 * turn the host refuses everywhere else.
 *
 * The store is seeded, then the pair is forged directly (one record claims the
 * older turn; the older turn's row and its run's committed range move with
 * it). A restarted platform must refuse the history read over the wire, with
 * nothing in the replica, and the same run must be refused on `runs.get` —
 * one authority, no cross-authority gap.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createClientOn, createHostPlatform, runSettled, waitFor } from "../helpers/platform.js";
import { scriptedModel, textReply } from "../helpers/demo-fixtures.js";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-integration-16-"));
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

describe("N1 the page is proven by the run read on the real platform", () => {
  it("refuses history whose turn and run rows were moved as a pair", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "pair.db");
      const model = scriptedModel([textReply("A answer"), textReply("B answer")]);
      const seedPlatform = createHostPlatform({
        modelClient: model.client,
        plugins: [],
        persistence: { kind: "sqlite", location: path },
      });
      open.push({ close: () => seedPlatform.shutdown() });
      const seeder = createClientOn(seedPlatform);
      open.push({ close: async () => undefined });
      await seeder.connect();
      const { session } = await seeder.sessions.create();
      const one = await seeder.runs.start({ sessionId: session.sessionId, submissionId: "sub-a", text: "A question" });
      await waitFor(() => runSettled(seeder.getSnapshot(), one.run.runId), { what: "the first run to settle" });
      const two = await seeder.runs.start({ sessionId: session.sessionId, submissionId: "sub-b", text: "B question" });
      await waitFor(() => runSettled(seeder.getSnapshot(), two.run.runId), { what: "the second run to settle" });
      seeder.disconnect();
      await seedPlatform.shutdown();

      // The forged pair: one record claims the older turn; the older turn's
      // row and its owner run's committed range move together to cover it.
      const database = new DatabaseSync(path);
      const older = database
        .prepare("SELECT turn_id FROM turns WHERE session_id = ? ORDER BY start_seq LIMIT 1")
        .get(session.sessionId) as { readonly turn_id?: string };
      database
        .prepare("UPDATE session_events SET turn_id = ? WHERE session_id = ? AND seq = 6")
        .run(older.turn_id as string, session.sessionId);
      database
        .prepare("UPDATE turns SET end_seq = 8 WHERE session_id = ? AND turn_id = ?")
        .run(session.sessionId, older.turn_id as string);
      database.prepare("UPDATE runs SET committed_to_seq = 8 WHERE run_id = ?").run(one.run.runId);
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

      // The smallest page used to be where the pair leaked; it is refused over
      // the wire now, and nothing enters the replica.
      let refused: string | undefined;
      try {
        await client.sessions.history({ sessionId: session.sessionId, limit: 1 });
      } catch (error) {
        refused = (error as { code?: string }).code;
      }
      expect(refused).toBe("INTERNAL_ERROR");
      expect(client.getSnapshot().history[session.sessionId]).toBeUndefined();

      // The same authority decides the run read, and the session is blocked:
      // no path serves a fragment of a turn the host cannot prove.
      let runRefused: string | undefined;
      try {
        await client.runs.get({ runId: one.run.runId });
      } catch (error) {
        runRefused = (error as { code?: string }).code;
      }
      expect(runRefused).toBe("INTERNAL_ERROR");
      const blocked = await client.sessions.get({ sessionId: session.sessionId });
      expect(blocked.session.status).toBe("blocked");

      client.disconnect();
      await platform.shutdown();
    });
  });
});

describe("N2 an unfinished owner run is not proof on the real platform", () => {
  it("refuses history whose turn names a run that never committed a range", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "vacuous.db");
      const model = scriptedModel([textReply("A answer"), textReply("B answer")]);
      const seedPlatform = createHostPlatform({
        modelClient: model.client,
        plugins: [],
        persistence: { kind: "sqlite", location: path },
      });
      open.push({ close: () => seedPlatform.shutdown() });
      const seeder = createClientOn(seedPlatform);
      open.push({ close: async () => undefined });
      await seeder.connect();
      const { session } = await seeder.sessions.create();
      const one = await seeder.runs.start({ sessionId: session.sessionId, submissionId: "sub-a", text: "A question" });
      await waitFor(() => runSettled(seeder.getSnapshot(), one.run.runId), { what: "the first run to settle" });
      const two = await seeder.runs.start({ sessionId: session.sessionId, submissionId: "sub-b", text: "B question" });
      await waitFor(() => runSettled(seeder.getSnapshot(), two.run.runId), { what: "the second run to settle" });
      seeder.disconnect();
      await seedPlatform.shutdown();

      // The records and the turn row move to cover the second half, and the
      // owner run's committed range is erased while its status reads as
      // unfinished — the vacuous branch of the run read.
      const database = new DatabaseSync(path);
      const older = database
        .prepare("SELECT turn_id FROM turns WHERE session_id = ? ORDER BY start_seq LIMIT 1")
        .get(session.sessionId) as { readonly turn_id?: string };
      database
        .prepare("UPDATE session_events SET turn_id = ? WHERE session_id = ? AND seq >= 6")
        .run(older.turn_id as string, session.sessionId);
      database
        .prepare("UPDATE turns SET end_seq = 8 WHERE session_id = ? AND turn_id = ?")
        .run(session.sessionId, older.turn_id as string);
      database
        .prepare(
          `UPDATE runs SET committed_from_seq = NULL, committed_to_seq = NULL, status = 'running',
             end_reason = NULL, ended_at = NULL WHERE run_id = ?`,
        )
        .run(one.run.runId);
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

      let refused: string | undefined;
      try {
        await client.sessions.history({ sessionId: session.sessionId, limit: 1 });
      } catch (error) {
        refused = (error as { code?: string }).code;
      }
      expect(refused).toBe("INTERNAL_ERROR");
      expect(client.getSnapshot().history[session.sessionId]).toBeUndefined();

      client.disconnect();
      await platform.shutdown();
    });
  });
});
