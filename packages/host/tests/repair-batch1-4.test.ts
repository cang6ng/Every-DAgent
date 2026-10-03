/**
 * Repair Batch 1.4 — R02 residuals: the fault boundary has no side doors.
 *
 * E1 ends this host's ability to vouch for anything current. Two paths still
 * walked past that boundary after the fault: a *repeated* submission was
 * answered from the dedup read with its original live run, and a plugin
 * lifecycle mutation ran to completion, growing the executable tool set.
 *
 * The regressions here hold a faulted host to the boundary on both paths: the
 * same submission id, a new one, and a repeated repeat all answer
 * STORAGE_UNAVAILABLE; an enable is refused before the plugin's `activate` is
 * ever called; and the unfinished durable fact stays exactly as it was, with
 * nothing re-executed and no terminal invented.
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
} from "./helpers/harness.js";

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-repair-14-"));
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
      // The commit never runs and its transaction stays open; the rollback
      // below never runs either, so nothing about the batch can be judged.
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

/**
 * One host with a committed first turn and a second run whose terminal can
 * never be confirmed: the state every residual below starts from.
 */
async function faultedHost(path: string): Promise<{
  readonly composed: Awaited<ReturnType<typeof composeTestHost>>;
  readonly model: ReturnType<typeof scriptedModel>;
  readonly sessionId: string;
  readonly committed: string;
  readonly runId: string;
  readonly modelRequests: number;
  readonly client: ReturnType<typeof connect>;
}> {
  const model = scriptedModel([textReply("first answer"), textReply("second answer")]);
  const composed = await composeTestHost({ modelClient: model.client, location: path });
  const client = connect(composed.host);
  await client.describe();
  await client.call("subscriptions.open", {});
  const session = await createSessionThrough(client);

  const first = await client.call("runs.start", {
    sessionId: session.sessionId,
    submissionId: "sub-1",
    text: "one",
  });
  const committed = first.result?.run.runId as string;
  expect((await awaitRunTerminal(client, committed)).status).toBe("completed");

  const second = await client.call("runs.start", {
    sessionId: session.sessionId,
    submissionId: "sub-2",
    text: "two",
  });
  const runId = second.result?.run.runId as string;

  const interference = interfereWithEndingTheTransaction();
  await flush();
  await flush();
  expect(interference.injected()).toBe(1);
  interference.restore();

  // The fault is a boundary: the connected client is invalidated and nothing
  // was published for the run nobody can vouch for.
  expect(client.isClosed).toBe(true);
  expect(
    client.events.filter((event) => event.type === "run.ended" && event.payload.run.runId === runId),
  ).toHaveLength(0);

  return {
    composed,
    model,
    sessionId: session.sessionId,
    committed,
    runId,
    modelRequests: model.requests.length,
    client,
  };
}

describe("R02 dedup cannot bypass the fault boundary", () => {
  it("refuses the repeated submission instead of serving its original run as current", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "dedup.db");
      const faulted = await faultedHost(path);

      const fresh = connect(faulted.composed.host);
      await fresh.describe();

      // The residual: this exact submission is already in the store, so the
      // dedup read knows its run — and that answer, `running`, is a claim
      // about current state. It is refused like every other one.
      const repeated = await fresh.call("runs.start", {
        sessionId: faulted.sessionId,
        submissionId: "sub-2",
        text: "two",
      });
      expect(repeated.error?.code).toBe("STORAGE_UNAVAILABLE");
      expect(repeated.result).toBeUndefined();

      // A new submission, and any number of repeats: the boundary does not
      // wear down, and each answer stays the same refusal.
      const attempts: readonly (readonly [string, string])[] = [
        ["sub-3", "three"],
        ["sub-2", "two"],
        ["sub-2", "two"],
        ["sub-4", "four"],
      ];
      for (const [submissionId, text] of attempts) {
        const refused = await fresh.call("runs.start", { sessionId: faulted.sessionId, submissionId, text });
        expect(refused.error?.code).toBe("STORAGE_UNAVAILABLE");
        expect(refused.result).toBeUndefined();
      }

      // D/E/F: the durable fact is still the unfinished run, no terminal was
      // published, and nothing executed for any of the refused submissions.
      expect(faulted.composed.repository.getRun(faulted.runId)?.status).toBe("running");
      expect(faulted.composed.repository.getRun(faulted.runId)?.turnId).toBeNull();
      expect(faulted.model.requests.length).toBe(faulted.modelRequests);
      expect(
        faulted.client.events.filter((event) => event.type === "run.ended" && event.payload.run.runId === faulted.runId),
      ).toHaveLength(0);

      fresh.detach();
      faulted.client.detach();
      await faulted.composed.host.shutdown();

      // The file itself: unfinished, no committed range, no fabricated row.
      const database = new DatabaseSync(path);
      const stored = database
        .prepare("SELECT status, committed_from_seq, committed_to_seq FROM runs WHERE run_id = ?")
        .get(faulted.runId) as {
        readonly status?: string;
        readonly committed_from_seq?: number | null;
        readonly committed_to_seq?: number | null;
      };
      database.close();
      expect(stored.status).toBe("running");
      expect(stored.committed_from_seq ?? null).toBeNull();
      expect(stored.committed_to_seq ?? null).toBeNull();

      // Restart is the only reconciliation: interrupted/unknown, blocked —
      // and still no re-execution.
      const readerModel = scriptedModel([textReply("unused")]);
      const restarted = await composeTestHost({ modelClient: readerModel.client, location: path });
      const reader = connect(restarted.host);
      await reader.describe();
      const after = await reader.call("runs.get", { runId: faulted.runId });
      expect(after.result?.run.status).toBe("interrupted");
      expect(after.result?.run.executionKnowledge).toBe("unknown");
      expect(restarted.repository.getSession(faulted.sessionId)?.status).toBe("blocked");
      const kept = await reader.call("runs.get", { runId: faulted.committed });
      expect(kept.result?.run.status).toBe("completed");
      expect(readerModel.requests).toHaveLength(0);

      reader.detach();
      await restarted.host.shutdown();
    });
  });
});

describe("R02 plugin lifecycle respects the fault boundary", () => {
  it("refuses enable and disable after the fault, and never calls activate", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "plugins.db");
      const activations: string[] = [];
      const model = scriptedModel([textReply("first answer"), textReply("second answer")]);
      const composed = await composeTestHost({
        modelClient: model.client,
        plugins: [
          testPlugin({
            id: "tools",
            tools: [constantTool("observer")],
            activate: () => {
              activations.push("tools");
            },
          }),
          testPlugin({
            id: "extra",
            tools: [constantTool("extra-tool")],
            activate: () => {
              activations.push("extra");
            },
          }),
        ],
        location: path,
      });
      const client = connect(composed.host);
      await client.describe();
      await client.call("subscriptions.open", {});
      const session = await createSessionThrough(client);

      // The healthy-host positive control: a lifecycle mutation works, and its
      // activation is the thing this boundary protects.
      const enabled = await client.call("plugins.enable", { pluginId: "tools" });
      expect(enabled.error).toBeUndefined();
      expect(enabled.result?.plugin.status).toBe("enabled");
      expect(activations).toEqual(["tools"]);

      // Fault the host: one committed turn, then a run whose terminal cannot
      // be confirmed.
      const first = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: "sub-1",
        text: "one",
      });
      expect((await awaitRunTerminal(client, first.result?.run.runId as string)).status).toBe("completed");
      const second = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: "sub-2",
        text: "two",
      });
      const runId = second.result?.run.runId as string;
      const interference = interfereWithEndingTheTransaction();
      await flush();
      await flush();
      expect(interference.injected()).toBe(1);
      interference.restore();
      expect(client.isClosed).toBe(true);

      const fresh = connect(composed.host);
      await fresh.describe();

      // The residual: an enable used to run to completion on a faulted host,
      // growing the executable tool set. It is refused before the manager is
      // ever asked, so `activate` is not called and no tool is registered.
      const late = await fresh.call("plugins.enable", { pluginId: "extra" });
      expect(late.error?.code).toBe("STORAGE_UNAVAILABLE");
      expect(late.result).toBeUndefined();
      expect(activations).toEqual(["tools"]);

      // The same class of write request: a disable is refused too — its one
      // durable effect, the catalogue revision, must not land after the fault
      // either — and nothing was disabled.
      const closed = await fresh.call("plugins.disable", { pluginId: "tools" });
      expect(closed.error?.code).toBe("STORAGE_UNAVAILABLE");
      expect(activations).toEqual(["tools"]);

      // The catalogue itself is a read, and stays readable: `extra` is still
      // exactly as it was — disabled.
      const listed = await fresh.call("plugins.list", {});
      expect(listed.error).toBeUndefined();
      expect(listed.result?.plugins.map((plugin) => [plugin.id, plugin.status])).toEqual([
        ["tools", "enabled"],
        ["extra", "disabled"],
      ]);

      // And the host is still faulted: no enable opened a way back in.
      const started = await fresh.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: "sub-3",
        text: "three",
      });
      expect(started.error?.code).toBe("STORAGE_UNAVAILABLE");
      const listedSessions = await fresh.call("sessions.list", {});
      expect(listedSessions.error?.code).toBe("STORAGE_UNAVAILABLE");
      expect(model.requests.length).toBe(2);
      expect(composed.repository.getRun(runId)?.status).toBe("running");

      fresh.detach();
      client.detach();
      await composed.host.shutdown();
    });
  });
});
