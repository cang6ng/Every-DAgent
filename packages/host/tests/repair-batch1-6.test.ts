/**
 * Repair Batch 1.6 — N1, found by the independent review of Batch 1.5.
 *
 * The page's proof of a turn stopped at the turn index: the turn-side binding
 * (the turn's row against its owner run's row) is satisfied by a forged
 * *pair* — both rows moved together — while `verifyRunHistory` refuses the
 * same run on `runs.get`, on the execution window and on the commit
 * confirmation. A page could therefore publish a fragment of a turn whose
 * owner run the host refuses everywhere else. A page now asks for the range
 * under the run read's own authority (`publishableTurnRange`), so it can never
 * be the one reader such a pair still satisfies — while a fragment of a
 * *proven* turn stays exactly as publishable as before.
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
  createSessionThrough,
  scriptedModel,
  textReply,
} from "./helpers/harness.js";

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-repair-16-"));
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

/** Every durable canonical row the proofs are made of, for "nothing was rewritten". */
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

interface Seeded {
  readonly session: string;
  readonly first: string;
  readonly second: string;
  readonly firstTurn: string;
}

/** One session holding two plain committed turns: [0,4) and [4,8). */
async function seed(path: string): Promise<Seeded> {
  const composed = composeTestHost({
    modelClient: scriptedModel([textReply("A answer"), textReply("B answer")]).client,
    location: path,
  });
  const client = connect(composed.host);
  await client.describe();
  const session = await createSessionThrough(client);
  const first = await client.call("runs.start", { sessionId: session.sessionId, submissionId: "sub-a", text: "A question" });
  await awaitRunTerminal(client, first.result?.run.runId as string);
  const second = await client.call("runs.start", { sessionId: session.sessionId, submissionId: "sub-b", text: "B question" });
  await awaitRunTerminal(client, second.result?.run.runId as string);
  client.detach();
  await composed.host.shutdown();

  const database = new DatabaseSync(path);
  const firstTurn = (
    database
      .prepare("SELECT turn_id FROM turns WHERE session_id = ? ORDER BY start_seq LIMIT 1")
      .get(session.sessionId) as { readonly turn_id?: string }
  ).turn_id as string;
  database.close();
  return {
    session: session.sessionId,
    first: first.result?.run.runId as string,
    second: second.result?.run.runId as string,
    firstTurn,
  };
}

describe("N1 a page is proven by the run read, not by a turn-side pair", () => {
  it("refuses a page whose turn and run rows were moved together", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "pair.db");
      const seeded = await seed(path);

      // The honest shape first: the smallest page of this traversal is the
      // second turn's closing assistant record — mid-turn, no boundary.
      const intactHost = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const intact = connect(intactHost.host);
      await intact.describe();
      const before = await intact.call("sessions.history", { sessionId: seeded.session, limit: 1 });
      expect(before.error).toBeUndefined();
      expect(before.result?.page.items.map((item) => item.seq)).toEqual([6]);
      expect(before.result?.page.coverage).toEqual({ fromSeq: 6, toSeq: 8 });
      intact.detach();
      await intactHost.host.shutdown();

      // The pair: one record claims the older turn, and the older turn's row
      // *and* its owner run's row move together to cover the record. The
      // turn-side binding is satisfied by construction — and deliberately
      // still reads as satisfied below — while the run read refuses.
      const pair = new DatabaseSync(path);
      pair
        .prepare("UPDATE session_events SET turn_id = ? WHERE session_id = ? AND seq = 6")
        .run(seeded.firstTurn, seeded.session);
      pair.prepare("UPDATE turns SET end_seq = 8 WHERE session_id = ? AND turn_id = ?").run(seeded.session, seeded.firstTurn);
      pair.prepare("UPDATE runs SET committed_to_seq = 8 WHERE run_id = ?").run(seeded.first);
      pair.close();
      const damaged = canonicalFingerprint(path, seeded.session);

      const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();

      // The two proofs, side by side: the turn-side binding accepts the pair
      // ({0,8} — it cannot tell the rows were moved together), and the run
      // read refuses the very run the page would be publishing for.
      const runRecord = composed.repository.getRun(seeded.first);
      expect(composed.repository.ownedTurnRange(seeded.session, seeded.firstTurn)).toEqual({ startSeq: 0, endSeq: 8 });
      expect(runRecord !== undefined && composed.repository.verifyRunHistory(runRecord)).toBe(false);

      // The page is refused, never served — a fragment of a turn the host
      // refuses everywhere else is not a fragment this store may publish.
      const page = await client.call("sessions.history", { sessionId: seeded.session, limit: 1 });
      expect(page.error?.code).toBe("INTERNAL_ERROR");
      expect(page.result).toBeUndefined();
      expect(composed.repository.getSession(seeded.session)?.status).toBe("blocked");

      // The same authority decides the run read: one proof, no cross-authority gap.
      const runRead = await client.call("runs.get", { runId: seeded.first });
      expect(runRead.error?.code).toBe("INTERNAL_ERROR");

      client.detach();
      await composed.host.shutdown();
      // Nothing was repaired, backfilled or rewritten.
      expect(canonicalFingerprint(path, seeded.session)).toBe(damaged);

      // A restart reconciles nothing: the forged pair is durable and refused.
      const restarted = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const reader = connect(restarted.host);
      await reader.describe();
      const again = await reader.call("sessions.history", { sessionId: seeded.session, limit: 1 });
      expect(again.error?.code).toBe("INTERNAL_ERROR");
      expect(again.result).toBeUndefined();
      reader.detach();
      await restarted.host.shutdown();
    });
  });

  it("refuses a page whose records were relabelled to a turn they were never committed at", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "relabelled.db");
      const seeded = await seed(path);

      // The second turn's records all claim the first turn — so a page of
      // them asks only about the older turn, and the older turn's own row,
      // run and range are intact and verify. Nothing run-level is left to
      // catch this one: the only proof that refuses it is the position
      // binding — every record's seq against the range of the turn it names.
      const relabel = new DatabaseSync(path);
      relabel
        .prepare("UPDATE session_events SET turn_id = ? WHERE session_id = ? AND seq >= 4")
        .run(seeded.firstTurn, seeded.session);
      relabel.close();
      const damaged = canonicalFingerprint(path, seeded.session);

      const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();

      // The forged turn is provable in full — its proof passes on both levels
      // — and cannot contain the page's positions.
      const runRecord = composed.repository.getRun(seeded.first);
      expect(composed.repository.publishableTurnRange(seeded.session, seeded.firstTurn)).toEqual({ startSeq: 0, endSeq: 4 });
      expect(runRecord !== undefined && composed.repository.verifyRunHistory(runRecord)).toBe(true);

      const page = await client.call("sessions.history", { sessionId: seeded.session, limit: 1 });
      expect(page.error?.code).toBe("INTERNAL_ERROR");
      expect(page.result).toBeUndefined();
      expect(composed.repository.getSession(seeded.session)?.status).toBe("blocked");

      client.detach();
      await composed.host.shutdown();
      expect(canonicalFingerprint(path, seeded.session)).toBe(damaged);
    });
  });

  it("refuses a page whose turn names an owner run that never committed a range", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "vacuous.db");
      const seeded = await seed(path);

      // The records and the turn row move to cover the second half, and the
      // owner run's committed range is erased while its status reads as
      // unfinished. The run read's answer for such a run is the vacuous `true`
      // — there is nothing on it to disagree with — so the turn-side binding
      // is what has to hold the page here: a page that took the vacuous branch
      // would publish a fragment of a turn no run ever committed.
      const erase = new DatabaseSync(path);
      erase
        .prepare("UPDATE session_events SET turn_id = ? WHERE session_id = ? AND seq >= 6")
        .run(seeded.firstTurn, seeded.session);
      erase.prepare("UPDATE turns SET end_seq = 8 WHERE session_id = ? AND turn_id = ?").run(seeded.session, seeded.firstTurn);
      erase
        .prepare(
          `UPDATE runs SET committed_from_seq = NULL, committed_to_seq = NULL, status = 'running',
             end_reason = NULL, ended_at = NULL WHERE run_id = ?`,
        )
        .run(seeded.first);
      erase.close();

      const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();

      // The vacuous branch, observed side by side: the run read accepts the
      // unfinished run, the turn-side binding does not hold, and the page is
      // refused — neither proof alone would have been enough.
      const runRecord = composed.repository.getRun(seeded.first);
      expect(runRecord !== undefined && composed.repository.verifyRunHistory(runRecord)).toBe(true);
      expect(composed.repository.ownedTurnRange(seeded.session, seeded.firstTurn)).toBeUndefined();
      expect(composed.repository.publishableTurnRange(seeded.session, seeded.firstTurn)).toBeUndefined();

      const page = await client.call("sessions.history", { sessionId: seeded.session, limit: 1 });
      expect(page.error?.code).toBe("INTERNAL_ERROR");
      expect(page.result).toBeUndefined();

      client.detach();
      await composed.host.shutdown();
    });
  });

  it("still serves every legal fragment of a proven turn", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "valid.db");
      const seeded = await seed(path);

      const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();

      // One item per page across the whole session: the traversal splits at
      // turn boundaries and inside turns, and every page is served — the
      // run-level proof does not turn a fragment into a refusal.
      const items: { readonly kind: string; readonly seq: number }[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const answer = await client.call("sessions.history", {
          sessionId: seeded.session,
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(answer.error).toBeUndefined();
        const page = answer.result?.page;
        if (page === undefined) throw new Error("the page was not served");
        items.unshift(...page.items.map((item) => ({ kind: item.kind, seq: item.seq })));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
        if ((pages += 1) > 30) throw new Error("the traversal did not end");
      }
      expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(composed.repository.getSession(seeded.session)?.status).toBe("ready");

      client.detach();
      await composed.host.shutdown();
    });
  });
});
