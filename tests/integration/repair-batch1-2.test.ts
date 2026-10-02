/**
 * Repair Batch 1.2, R02 at the Client boundary: when a terminal commit cannot
 * be judged, the presentation a connected client holds stops being claimed as
 * current — immediately, and without a fabricated terminal.
 *
 * The host's own reconciliation is covered by the host tests; what is checked
 * here is what a *reader* is shown. A host that cannot confirm what storage
 * holds must not keep streaming a live presentation as if it could, and it must
 * not invent an outcome to replace the one it cannot prove. The one signal the
 * contract has for that is the connection itself ending: the client keeps the
 * presentation it had, marked stale, drops the drafts it was watching, and every
 * new execution is refused with STORAGE_UNAVAILABLE until a restart reconciles
 * the durable facts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createClientOn, createHostPlatform, waitFor } from "../helpers/platform.js";
import { demoPlugin, scriptedModel, textReply, toolReply } from "../helpers/demo-fixtures.js";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-integration-12-"));
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

/** The text one run's retained live draft currently shows. */
function liveText(client: ReturnType<typeof createClientOn>, runId: string): string {
  const items = client.getSnapshot().live[runId]?.live ?? [];
  return items
    .map((item) => (item.kind === "text" ? item.text : ""))
    .join("");
}

interface InstalledInterference {
  /** How many receipts were interfered with (0 or 1). */
  injected(): number;
  restore(): void;
}

/**
 * Interferes with the terminal COMMIT, in one of the two ways this batch cares
 * about: a commit that landed whose receipt was lost (which the host must still
 * prove and publish), and one whose outcome cannot be judged at all because the
 * transaction could not be ended.
 */
function interfereWithTerminalCommit(mode: "landed" | "stuck"): InstalledInterference {
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
      if (mode === "stuck") {
        // The commit never runs and its transaction stays open; the rollback
        // below never runs either, so nothing about the batch can be judged.
        stuck = true;
        throw new Error("injected: the commit never ran");
      }
      // The commit lands and only its receipt is lost, which the host is
      // allowed to prove by reading the batch back.
      originalExec.call(this, sql);
      throw new Error("injected: the commit receipt was lost");
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

describe("R02 presentation invalidation", () => {
  it("stops claiming the presentation is current when the terminal cannot be judged, and invents nothing", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "fault.db");
      const tools = demoPlugin("tools", "observer", "observed");
      let releaseRun!: () => void;
      const running = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      const model = scriptedModel([
        // A run that has shown a live prefix and is still executing when the
        // outcome becomes unprovable.
        async function* () {
          yield { type: "text-delta", text: "seen-live" } as const;
          await running;
          yield { type: "tool-call", call: { callId: "call-1", name: "observer", input: { n: 1 } } } as const;
          yield { type: "done" } as const;
        },
        textReply("finished"),
      ]);
      const platform = createHostPlatform({
        modelClient: model.client,
        plugins: [tools.plugin],
        persistence: { kind: "sqlite", location: path },
      });
      open.push({ close: () => platform.shutdown() });

      const client = createClientOn(platform);
      open.push({ close: async () => undefined });
      await client.connect();
      await client.plugins.enable({ pluginId: "tools" });
      const { session } = await client.sessions.create();
      const started = await client.runs.start({
        sessionId: session.sessionId,
        submissionId: "sub-fault",
        text: "use the tool",
      });
      const runId = started.run.runId;
      await waitFor(() => liveText(client, runId) === "seen-live", { what: "the live prefix" });

      const interference = interfereWithTerminalCommit("stuck");
      try {
        releaseRun();
        // The execution settles, but its outcome can never be confirmed: the
        // connection that was streaming it ends, because the host can no longer
        // vouch for what a reader sees.
        await waitFor(() => client.getSnapshot().status !== "ready", { what: "the invalidation" });
      } finally {
        interference.restore();
      }
      expect(interference.injected()).toBe(1);

      // Not ready, not current: the connection is over, and the presentation it
      // explained is retained and marked stale rather than updated with a claim
      // nobody can back.
      const state = client.getSnapshot();
      expect(state.status).toBe("lost");
      expect(state.stale).toBe(true);
      const presented = state.presentation?.runs.items.find((run) => run.runId === runId);
      expect(presented?.status).toBe("running");
      // What the client was watching is kept as the display state it is — never
      // replaced by a completed or failed run the host never proved.
      expect(liveText(client, runId)).toContain("seen-live");
      expect(state.live[runId]?.status).toBe("running");

      // The execution really ran — once — and the tool really executed once.
      await waitFor(() => tools.executions.length === 1, { what: "the tool to run" });
      expect(model.requests).toHaveLength(2);

      // A new attempt cannot become a current-state connection: the cut a
      // bootstrap needs is refused, so the client stays un-synchronized with
      // its retained presentation marked stale — the existing sync-failure
      // path, not a new client state. No read of this host becomes "current"
      // again before a restart.
      let refusedSync: string | undefined;
      try {
        await client.reconnect();
      } catch (error) {
        refusedSync = (error as { code?: string }).code;
      }
      expect(refusedSync).toBe("STORAGE_UNAVAILABLE");
      const afterRefusal = client.getSnapshot();
      expect(afterRefusal.status).not.toBe("ready");
      expect(afterRefusal.stale).toBe(true);

      // And nothing new may execute on the connection that still works: the
      // store cannot be trusted to record it.
      let refusedCode: string | undefined;
      try {
        await client.runs.start({
          sessionId: session.sessionId,
          submissionId: "sub-again",
          text: "again",
        });
      } catch (error) {
        refusedCode = (error as { code?: string }).code;
      }
      expect(refusedCode).toBe("STORAGE_UNAVAILABLE");
      expect(model.requests).toHaveLength(2);

      client.disconnect();
      await platform.shutdown();

      // The durable truth: nothing was written that pretends the run ended, and
      // a restart reconciles it honestly — interrupted, unknown, blocked.
      const restarted = createHostPlatform({
        modelClient: scriptedModel([textReply("unused")]).client,
        plugins: [],
        persistence: { kind: "sqlite", location: path },
      });
      open.push({ close: () => restarted.shutdown() });
      const reader = createClientOn(restarted);
      await reader.connect();
      const after = await reader.runs.get({ runId });
      expect(after.run.status).toBe("interrupted");
      expect(after.run.executionKnowledge).toBe("unknown");
      const blocked = await reader.sessions.get({ sessionId: session.sessionId });
      expect(blocked.session.status).toBe("blocked");
      // And the model was never called again: the restart executed nothing.
      expect(model.requests).toHaveLength(2);
      reader.disconnect();
    });
  });

  it("keeps a commit that really landed current, and publishes its real terminal", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "landed.db");
      const model = scriptedModel([textReply("answer")]);
      const platform = createHostPlatform({
        modelClient: model.client,
        plugins: [],
        persistence: { kind: "sqlite", location: path },
      });
      open.push({ close: () => platform.shutdown() });

      const client = createClientOn(platform);
      await client.connect();
      const { session } = await client.sessions.create();
      const started = await client.runs.start({
        sessionId: session.sessionId,
        submissionId: "sub-landed",
        text: "hello",
      });

      const interference = interfereWithTerminalCommit("landed");
      try {
        await waitFor(
          () =>
            client
              .getSnapshot()
              .presentation?.runs.items.find((run) => run.runId === started.run.runId)?.status === "completed",
          { what: "the real terminal" },
        );
      } finally {
        interference.restore();
      }
      expect(interference.injected()).toBe(1);

      // The landed commit was proven, published and kept current: no
      // invalidation happened, and the run settled for real.
      const state = client.getSnapshot();
      expect(state.status).toBe("ready");
      expect(state.stale).toBe(false);
      expect(state.live[started.run.runId]).toBeUndefined();
      expect(model.requests).toHaveLength(1);

      // A later read agrees, and a new execution is still accepted.
      const again = await client.runs.start({
        sessionId: session.sessionId,
        submissionId: "sub-next",
        text: "once more",
      });
      expect(again.run.runId).not.toBe(started.run.runId);

      client.disconnect();
    });
  });
});
