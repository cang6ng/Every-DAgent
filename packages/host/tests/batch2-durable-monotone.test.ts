/**
 * Batch 2 — C1 (durable monotone time) and R08 (startup readiness evidence).
 *
 * C1: externally visible durable metadata never moves backwards because the
 * local clock did. The clamp lives in the repository's own writes, so it is the
 * durable authority that decides, not the caller's `Date.now()`.
 *
 * R08: readiness is not a defect to fix in M1 — the composition performs the
 * whole ordered startup before a host exists — but it is a property that has to
 * be pinned: reconciliation completes before the first frame is served, a store
 * that cannot be opened produces no host, and a second host cannot take a store
 * another one holds.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "@every-dagent/agent-core";
import { encodeFrame } from "@every-dagent/protocol";

import { encodeStoredData, openRepository, type StoredRecord } from "../src/repository.js";
import { runSnapshotOfRecord } from "../src/state.js";

import { composeTestHost, connect, createSessionThrough, scriptedModel, textReply } from "./helpers/harness.js";

const LIMITS = { maxRecordBytes: 64 * 1024 };
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
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-batch2-mono-"));
  dirs.push(dir);
  return dir;
}

/** One legal committed turn: opening, the accepted input, a finished answer, the close. */
function turnBatch(turnId: string, text: string, baseSeq: number): readonly StoredRecord[] {
  const events: readonly SessionEvent[] = [
    { type: "turn/start", turnId, seq: baseSeq, time: 0, data: {} },
    { type: "message/user", turnId, seq: baseSeq + 1, time: 0, data: { text } },
    { type: "message/assistant", turnId, seq: baseSeq + 2, time: 0, data: { text: "answer", toolCalls: [] } },
    { type: "turn/end", turnId, seq: baseSeq + 3, time: 0, data: { reason: "completed" } },
  ];
  return Object.freeze(
    events.map((event) =>
      Object.freeze({
        seq: event.seq,
        turnId: event.turnId,
        type: event.type,
        time: event.time,
        data: encodeStoredData(event),
      }),
    ),
  );
}

describe("C1 durable monotone time", () => {
  it("a rolled-back clock cannot move a session's updatedAt backwards", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    try {
      const created = repository.createSession({ sessionId: "s-1", title: "first", createdAt: 5_000 });
      expect(created.updatedAt).toBe(5_000);

      const renamed = repository.renameSession({
        sessionId: "s-1",
        expectedRevision: created.metadataRevision,
        title: "second",
        at: 1_000,
      });
      expect(renamed.kind).toBe("renamed");
      if (renamed.kind !== "renamed") return;
      // The durable authority keeps the newer value: the title changed, the
      // clock did not move the summary backwards.
      expect(renamed.session.title).toBe("second");
      expect(renamed.session.updatedAt).toBe(5_000);
      expect(renamed.session.createdAt).toBe(5_000);

      const blocked = repository.blockCorruptSession("s-1", 10);
      expect(blocked?.updatedAt).toBe(5_000);
    } finally {
      repository.close();
    }
  });

  it("keeps acceptance, start and end in one possible order under the same clock", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    try {
      repository.createSession({ sessionId: "s-1", title: "t", createdAt: 5_000 });
      const admitted = repository.admitRun({
        runId: "r-1",
        submissionId: "sub-1",
        sessionId: "s-1",
        text: "go",
        inputHash: "hash",
        hostInstanceId: "host-1",
        acceptedAt: 5_000,
      });
      expect(admitted.kind).toBe("admitted");
      expect(repository.getSession("s-1")?.updatedAt).toBe(5_000);

      const started = repository.markRunStarted("r-1", "host-1", 1_000);
      expect(started.acceptedAt).toBe(5_000);
      expect(started.startedAt).toBe(5_000);

      const committed = repository.commitTurn({
        runId: "r-1",
        sessionId: "s-1",
        turnId: "turn-1",
        reason: "completed",
        turnStartSeq: 0,
        records: turnBatch("turn-1", "go", 0),
        endedAt: 1_000,
      });
      expect(committed.run.startedAt).toBe(5_000);
      expect(committed.run.endedAt).toBe(5_000);
      expect(committed.session.updatedAt).toBe(5_000);

      // The protocol's own clock rule holds on the projected DTO, so the run is
      // served rather than refused for a sequence the host could not have meant.
      const encoded = encodeFrame(
        { kind: "host-response", method: "runs.get" },
        {
          kind: "host-response",
          protocolVersion: "2",
          hostInstanceId: "host-1",
          requestId: "req-1",
          result: { run: runSnapshotOfRecord(committed.run, null) },
        },
      );
      expect(encoded.success).toBe(true);
    } finally {
      repository.close();
    }
  });

  it("clamps a host failure and a reconciliation against the stored clock", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    try {
      repository.createSession({ sessionId: "s-1", title: "t", createdAt: 9_000 });
      repository.admitRun({
        runId: "r-1",
        submissionId: "sub-1",
        sessionId: "s-1",
        text: "go",
        inputHash: "hash",
        hostInstanceId: "host-1",
        acceptedAt: 9_000,
      });
      const failed = repository.failRun({
        runId: "r-1",
        sessionId: "s-1",
        blockedReason: "host-fault",
        errorCode: "INTERNAL_ERROR",
        endedAt: 100,
        turnId: null,
      });
      expect(failed.run.endedAt).toBe(9_000);
      expect(failed.session.updatedAt).toBe(9_000);
      expect(failed.session.status).toBe("blocked");

      // A second session's unfinished run, reconciled by a later host under the
      // same rolled-back clock: the interrupted terminal and the session keep
      // the order the store already held.
      repository.createSession({ sessionId: "s-2", title: "t2", createdAt: 8_000 });
      repository.admitRun({
        runId: "r-2",
        submissionId: "sub-2",
        sessionId: "s-2",
        text: "go",
        inputHash: "hash",
        hostInstanceId: "host-1",
        acceptedAt: 8_000,
      });
      const reconciled = repository.reconcileInterrupted("host-2", 200);
      expect(reconciled.interrupted).toBe(1);
      const session = repository.getSession("s-2");
      expect(session?.updatedAt).toBe(8_000);
      expect(session?.activeRunId).toBeNull();
      expect(repository.getRun("r-2")?.status).toBe("interrupted");
      expect(repository.getRun("r-2")?.executionKnowledge).toBe("not-started");
    } finally {
      repository.close();
    }
  });
});

describe("R08 startup readiness", () => {
  it("reconciles a previous host's unfinished run before the first frame is served", async () => {
    const path = join(tempDir(), "ready.db");

    // The store a previous process left behind: an accepted run with no start
    // marker, so nothing was dispatched and `not-started` is provable.
    const seeded = openRepository({ location: path, limits: LIMITS });
    seeded.createSession({ sessionId: "s-1", title: "left behind", createdAt: 1_000 });
    seeded.admitRun({
      runId: "r-1",
      submissionId: "sub-1",
      sessionId: "s-1",
      text: "go",
      inputHash: "hash",
      hostInstanceId: "previous",
      acceptedAt: 2_000,
    });
    seeded.close();

    const composed = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
    const client = connect(composed.host);
    try {
      await client.describe();
      // The very first read the host serves already reflects the reconciliation:
      // no frame can see the previous host's unfinished run as current.
      const opened = await client.call("subscriptions.open", {});
      expect(opened.error).toBeUndefined();
      const run = opened.result?.snapshot.runs.items.find((item) => item.runId === "r-1");
      expect(run?.status).toBe("interrupted");
      expect(run?.endReason).toBe("interrupted");
      expect(run?.executionKnowledge).toBe("not-started");
      const session = opened.result?.snapshot.sessions.items.find((item) => item.sessionId === "s-1");
      expect(session?.activeRunId).toBeNull();
      expect(session?.status).toBe("ready");
    } finally {
      client.detach();
      await composed.host.shutdown();
    }
  });

  it("does not produce a host when the durable store cannot be opened", () => {
    const path = join(tempDir(), "newer.db");
    const database = new DatabaseSync(path);
    database.exec("PRAGMA user_version = 99");
    database.close();

    expect(() =>
      composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path }),
    ).toThrow();
  });

  it("refuses a second host while another one holds the store", async () => {
    const path = join(tempDir(), "held.db");
    const first = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
    const client = connect(first.host);
    await client.describe();
    await createSessionThrough(client);

    expect(() =>
      composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path }),
    ).toThrow();

    client.detach();
    await first.host.shutdown();
  });
});
