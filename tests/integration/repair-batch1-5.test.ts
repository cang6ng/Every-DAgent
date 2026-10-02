/**
 * Repair Batch 1.5 at the platform boundary: the R05 residual as a real
 * client can walk into it.
 *
 * R05-A: a canonical record whose own seq lies outside the turn its id names
 * used to be published by `sessions.history` — the turn was provable, the
 * position was never checked. Here the smallest page a traversal can ask for
 * is refused over the wire, the session blocks, and the older run stays whole.
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
      const seedPlatform = createHostPlatform({
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

      const platform = createHostPlatform({
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
