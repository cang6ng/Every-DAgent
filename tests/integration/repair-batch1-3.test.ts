/**
 * Repair Batch 1.3 at the Client boundary.
 *
 * E1: a storage fault is a boundary a *new* client cannot bootstrap past. The
 * residual this batch closes is the one a fresh connection could still walk
 * through — describe, subscribe, and read a "current" presentation out of a
 * host whose outcome it cannot confirm. Here a brand-new client is refused,
 * nothing is re-executed, and the durable record is untouched until a restart
 * reconciles it.
 *
 * E3: a `limit=1` traversal of a real tool turn is legal end to end. The
 * client must accept call-only and result-only pages, keep its coverage
 * honest, and never call the fragment a protocol failure.
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
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-integration-13-"));
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
 * Interferes with the terminal COMMIT so that neither the commit nor its
 * rollback can be judged: the batch's outcome is unknowable from this host.
 */
function interfereWithTerminalCommit(): { injected(): number; restore(): void } {
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

describe("E1 a faulted host has nothing current to bootstrap into", () => {
  it("refuses a brand-new client, re-runs nothing, and reconciles only at restart", async () => {
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
      expect(tools.executions.length).toBe(0);

      const interference = interfereWithTerminalCommit();
      try {
        await waitFor(() => watcher.getSnapshot().status !== "ready", { what: "the invalidation" });
      } finally {
        interference.restore();
      }
      expect(interference.injected()).toBe(1);
      expect(tools.executions.length).toBe(1);

      // A brand-new client — not a reconnect of the one that was invalidated —
      // cannot become a current-state connection on this host. The identity is
      // still describable; the cut is not, so `connect()` never reaches ready.
      const fresh = createClientOn(platform);
      open.push({ close: async () => undefined });
      let refused: string | undefined;
      try {
        await fresh.connect();
      } catch (error) {
        refused = (error as { code?: string }).code;
      }
      expect(refused).toBe("STORAGE_UNAVAILABLE");
      expect(fresh.getSnapshot().status).not.toBe("ready");

      // And even the connection that still works cannot start anything.
      let startRefused: string | undefined;
      try {
        await fresh.runs.start({
          sessionId: session.sessionId,
          submissionId: "sub-again",
          text: "again",
        });
      } catch (error) {
        startRefused = (error as { code?: string }).code;
      }
      expect(startRefused).toBe("STORAGE_UNAVAILABLE");

      watcher.disconnect();
      await platform.shutdown();

      // The durable truth: the execution ran once, the terminal batch never
      // landed, and the unfinished marker is exactly what a restart finds.
      const database = new DatabaseSync(path);
      const durable = database.prepare("SELECT status, committed_from_seq FROM runs WHERE run_id = ?").get(runId) as {
        readonly status?: string;
        readonly committed_from_seq?: number | null;
      };
      const events = database.prepare("SELECT COUNT(*) AS count FROM session_events").get() as { readonly count?: number };
      database.close();
      expect(durable.status).toBe("running");
      expect(durable.committed_from_seq ?? null).toBeNull();
      expect(events.count).toBe(0);
      expect(model.requests).toHaveLength(2);
      expect(tools.executions.length).toBe(1);

      // The restart is the reconciliation: interrupted, unknown, blocked — and
      // still no re-execution.
      const restarted = createHostPlatform({
        modelClient: scriptedModel([textReply("unused")]).client,
        plugins: [],
        persistence: { kind: "sqlite", location: path },
      });
      open.push({ close: () => restarted.shutdown() });
      const reader = createClientOn(restarted);
      open.push({ close: async () => undefined });
      await reader.connect();
      const after = await reader.runs.get({ runId });
      expect(after.run.status).toBe("interrupted");
      expect(after.run.executionKnowledge).toBe("unknown");
      const blocked = await reader.sessions.get({ sessionId: session.sessionId });
      expect(blocked.session.status).toBe("blocked");
      expect(model.requests).toHaveLength(2);
      expect(tools.executions.length).toBe(1);
      reader.disconnect();
    });
  });
});

describe("E3 a limit=1 traversal is legal end to end", () => {
  it("reads a real tool turn one item at a time without a protocol failure", async () => {
    const tools = demoPlugin("tools", "observer", "observed");
    const model = scriptedModel([toolReply("call-1", "observer", { n: 1 }), textReply("finished")]);
    const platform = createHostPlatform({ modelClient: model.client, plugins: [tools.plugin] });
    open.push({ close: () => platform.shutdown() });

    const client = createClientOn(platform);
    open.push({ close: async () => undefined });
    await client.connect();
    await client.plugins.enable({ pluginId: "tools" });
    const { session } = await client.sessions.create();
    const started = await client.runs.start({
      sessionId: session.sessionId,
      submissionId: "sub-history",
      text: "use the tool",
    });
    await waitFor(() => runSettled(client.getSnapshot(), started.run.runId), { what: "the run to complete" });

    // One item per page, through the real client: each page a fragment, none
    // of them called a protocol failure, and the coverage they build is
    // contiguous and complete.
    const current = await client.sessions.get({ sessionId: session.sessionId });
    expect(current.session.committedSeq).toBeGreaterThan(0);
    const pages: { readonly kinds: string[]; readonly from: number; readonly to: number }[] = [];
    let cursor: string | undefined;
    let previousFrom: number | undefined;
    for (;;) {
      const answer = await client.sessions.history({
        sessionId: session.sessionId,
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const page = answer.page;
      expect(page.items.length).toBeLessThanOrEqual(1);
      if (previousFrom !== undefined) expect(page.coverage.toSeq).toBe(previousFrom);
      previousFrom = page.coverage.fromSeq;
      pages.push({ kinds: page.items.map((item) => item.kind), from: page.coverage.fromSeq, to: page.coverage.toSeq });
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      if (pages.length > 40) throw new Error("the traversal did not end");
    }

    // The halves of the tool occurrence really were split across pages.
    expect(pages.some((page) => page.kinds.length === 1 && page.kinds[0] === "tool-call")).toBe(true);
    expect(pages.some((page) => page.kinds.length === 1 && page.kinds[0] === "tool-result")).toBe(true);

    // The client never treated any of it as corruption, and its coverage says
    // the whole committed history was read: from the start to the fence.
    expect(client.getSnapshot().status).toBe("ready");
    const coverage = client.getSnapshot().history[session.sessionId];
    expect(coverage).toBeDefined();
    expect(coverage?.atStart).toBe(true);
    expect(coverage?.atFence).toBe(true);
    expect(coverage?.fromSeq).toBe(0);
    expect(coverage?.toSeq).toBe(current.session.committedSeq);
    expect(coverage?.items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool-call",
      "tool-result",
      "assistant",
    ]);

    // And the conversation is still usable: a second run settles normally.
    const again = await client.runs.start({
      sessionId: session.sessionId,
      submissionId: "sub-again",
      text: "once more",
    });
    await waitFor(() => runSettled(client.getSnapshot(), again.run.runId), { what: "the second run to complete" });
    client.disconnect();
  });
});
