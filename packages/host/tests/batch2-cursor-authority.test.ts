/**
 * Batch 2 — C2: a history cursor is a claim about durable truth, and the host
 * verifies it before it serves a page.
 *
 * The two fields that make a traversal recognizable — the fence it was cut at
 * and the revision that fence carried — are produced by the host and checked
 * against the committed turn index. A client-authored pair is refused like any
 * other cursor this store could not have issued; a legal cursor keeps working,
 * across a restart included.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  composeTestHost,
  connect,
  createSessionThrough,
  errorCode,
  runToTerminal,
  scriptedModel,
  textReply,
  type TestClient,
} from "./helpers/harness.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A store a failed test still holds is not the failure.
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-batch2-cursor-"));
  dirs.push(dir);
  return dir;
}

/** Rewrites the opaque cursor's own JSON, the way a hostile client would. */
function forge(cursor: string, changes: Record<string, number>): string {
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  return Buffer.from(JSON.stringify({ ...decoded, ...changes }), "utf8").toString("base64url");
}

/** Two committed turns: committedSeq 8, historyRevision 2, boundaries at 4 and 8. */
async function twoTurns(client: TestClient, submissionPrefix: string): Promise<string> {
  const session = await createSessionThrough(client);
  for (const [index, text] of ["one", "two"].entries()) {
    const terminal = await runToTerminal(client, session.sessionId, text, `${submissionPrefix}-${index}`);
    expect(terminal.status).toBe("completed");
  }
  return session.sessionId;
}

describe("C2 cursor authority", () => {
  it("refuses a revision the fence never carried", async () => {
    const host = composeTestHost({
      modelClient: scriptedModel([textReply("one"), textReply("two")]).client,
    });
    const client = connect(host.host);
    try {
      await client.describe();
      const sessionId = await twoTurns(client, "sub");

      const first = await client.call("sessions.history", { sessionId, limit: 1 });
      const cursor = first.result?.page.nextCursor;
      expect(cursor).not.toBeNull();
      expect(first.result?.page.historyRevision).toBe(2);
      expect(first.result?.page.fenceSeq).toBe(8);

      const inflated = await client.call("sessions.history", {
        sessionId,
        limit: 1,
        cursor: forge(cursor as string, { historyRevision: 999 }),
      });
      expect(errorCode(inflated)).toBe("INVALID_REQUEST");

      const shrunk = await client.call("sessions.history", {
        sessionId,
        limit: 1,
        cursor: forge(cursor as string, { historyRevision: 0 }),
      });
      expect(errorCode(shrunk)).toBe("INVALID_REQUEST");
    } finally {
      client.detach();
      await host.host.shutdown();
    }
  });

  it("refuses a fence inside a turn", async () => {
    const host = composeTestHost({
      modelClient: scriptedModel([textReply("one"), textReply("two")]).client,
    });
    const client = connect(host.host);
    try {
      await client.describe();
      const sessionId = await twoTurns(client, "sub");

      const first = await client.call("sessions.history", { sessionId, limit: 1 });
      const cursor = first.result?.page.nextCursor as string;

      // Seq 2 is inside the first turn: the committed high-water never stood
      // there, so no host ever issued a fence at it.
      const midTurn = await client.call("sessions.history", {
        sessionId,
        limit: 1,
        cursor: forge(cursor, { fenceSeq: 2, historyRevision: 1, beforeSeq: 2 }),
      });
      expect(errorCode(midTurn)).toBe("INVALID_REQUEST");
    } finally {
      client.detach();
      await host.host.shutdown();
    }
  });

  it("serves a legal cursor — including one for an older boundary — and derives the identity itself", async () => {
    const host = composeTestHost({
      modelClient: scriptedModel([textReply("one"), textReply("two")]).client,
    });
    const client = connect(host.host);
    try {
      await client.describe();
      const sessionId = await twoTurns(client, "sub");

      const first = await client.call("sessions.history", { sessionId, limit: 1 });
      const cursor = first.result?.page.nextCursor as string;

      const next = await client.call("sessions.history", { sessionId, limit: 1, cursor });
      expect(next.error).toBeUndefined();
      expect(next.result?.page.fenceSeq).toBe(first.result?.page.fenceSeq);
      expect(next.result?.page.historyRevision).toBe(first.result?.page.historyRevision);

      // The boundary at seq 4 is a legal fence — the first turn's exact end —
      // and the revision that boundary carried is 1. The page is served, and
      // reports the derived pair rather than anything the caller sent.
      const older = await client.call("sessions.history", {
        sessionId,
        limit: 50,
        cursor: forge(cursor, { fenceSeq: 4, historyRevision: 1, beforeSeq: 4 }),
      });
      expect(older.error).toBeUndefined();
      expect(older.result?.page.fenceSeq).toBe(4);
      expect(older.result?.page.historyRevision).toBe(1);
      expect(older.result?.page.coverage.toSeq).toBe(4);
    } finally {
      client.detach();
      await host.host.shutdown();
    }
  });

  it("keeps a legal cursor valid across a restart", async () => {
    const path = join(tempDir(), "cursor.db");
    const first = composeTestHost({
      modelClient: scriptedModel([textReply("one"), textReply("two")]).client,
      location: path,
    });
    const client = connect(first.host);
    await client.describe();
    const sessionId = await twoTurns(client, "sub");
    const page = await client.call("sessions.history", { sessionId, limit: 1 });
    const cursor = page.result?.page.nextCursor as string;
    client.detach();
    await first.host.shutdown();

    const second = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
    const reader = connect(second.host);
    try {
      await reader.describe();
      const next = await reader.call("sessions.history", { sessionId, cursor });
      expect(next.error).toBeUndefined();
      expect(next.result?.page.fenceSeq).toBe(8);
      expect(next.result?.page.historyRevision).toBe(2);
      expect((next.result?.page.items.length ?? 0) > 0).toBe(true);
    } finally {
      reader.detach();
      await second.host.shutdown();
    }
  });
});
