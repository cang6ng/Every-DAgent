/**
 * Repair Batch 1.1: the formal regressions for what the targeted re-review left
 * open — R02, R03, R04, R05, R10 and R28.
 *
 * Like the first batch, everything here runs against the real host, the real
 * SQLite store and the real protocol encoder: the facts being checked are the
 * ones storage ends up holding and the frames a client is sent, and a double
 * that never writes cannot be asked about either. Fault injections sit at the
 * API the failure really happens at and disarm themselves, so a test that
 * asserts afterwards is asserting about a healthy store.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { ModelEvent } from "@every-dagent/agent-core";
import type { Plugin } from "@every-dagent/plugin-system";
import { MAX_FRAME_BYTES } from "@every-dagent/protocol";

import { composeHost } from "../src/host.js";
import type { ComposedHost } from "../src/host.js";
import {
  encodedBytes,
  encodeStoredData,
  heaviestAcceptedText,
  stepRecordPayloads,
  toSessionEvent,
} from "../src/repository.js";
import type { Repository, StoredRecord } from "../src/repository.js";
import type { HostState } from "../src/state.js";
import {
  awaitRunTerminal,
  composeTestHost,
  connect,
  constantTool,
  createSessionThrough,
  flush,
  nextId,
  recordingTool,
  scriptedModel,
  testPlugin,
  textReply,
  toolReply,
} from "./helpers/harness.js";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-repair-11-"));
  try {
    return await act(dir);
  } catch (error) {
    throw error;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A store still held by a host that failed the test is not the failure.
    }
  }
}

const MODEL = (): ReturnType<typeof scriptedModel> => scriptedModel([textReply("answer")], { repeatLast: true });

/** One synthetic settled turn, written the way a terminal commit writes one. */
function turnRecords(sessionId: string, turnId: string, startSeq: number, text: string, answer: string): StoredRecord[] {
  void sessionId;
  const events = [
    { type: "turn/start" as const, data: {} },
    { type: "message/user" as const, data: { text } },
    { type: "message/assistant" as const, data: { text: answer, toolCalls: [] } },
    { type: "turn/end" as const, data: { reason: "completed" as const } },
  ];
  return events.map((event, offset) =>
    Object.freeze({
      seq: startSeq + offset,
      turnId,
      type: event.type,
      time: 1_700_000_000_000 + startSeq + offset,
      data: encodeStoredData({ type: event.type, turnId, seq: startSeq + offset, time: 0, data: event.data } as never),
    }),
  );
}

/** Writes one finished turn straight into storage, the way a host would. */
function writeTurn(
  repository: Repository,
  sessionId: string,
  index: number,
  text = `question ${index}`,
  answer = `answer ${index}`,
): string {
  const runId = `seed-run-${index}`;
  const accepted = repository.admitRun({
    runId,
    submissionId: `seed-sub-${index}`,
    sessionId,
    text,
    inputHash: `seed-hash-${index}`,
    hostInstanceId: "seed-host",
    acceptedAt: 1_700_000_000_000 + index * 10,
  });
  if (accepted.kind !== "admitted") throw new Error(`seed admission refused: ${accepted.kind}`);
  repository.markRunStarted(runId, "seed-host", 1_700_000_000_001 + index * 10);
  const startSeq = repository.getSession(sessionId)?.committedSeq ?? 0;
  repository.commitTurn({
    runId,
    sessionId,
    turnId: `turn-${index}`,
    reason: "completed",
    turnStartSeq: startSeq,
    records: turnRecords(sessionId, `turn-${index}`, startSeq, text, answer),
    endedAt: 1_700_000_000_002 + index * 10,
  });
  return runId;
}

/**
 * One finished turn that really called a tool: user, a declared call, the call,
 * its result, and the closing assistant record.
 *
 * It is the shape a window has to carry whole — an occurrence is a call *and*
 * its result — so it is also the shape a byte boundary has to be tested with.
 */
function writeToolTurn(repository: Repository, sessionId: string, index: number): string {
  const runId = `seed-run-${index}`;
  const accepted = repository.admitRun({
    runId,
    submissionId: `seed-sub-${index}`,
    sessionId,
    text: `q${index}`,
    inputHash: `seed-hash-${index}`,
    hostInstanceId: "seed-host",
    acceptedAt: 1_700_000_000_000 + index * 10,
  });
  if (accepted.kind !== "admitted") throw new Error(`seed admission refused: ${accepted.kind}`);
  repository.markRunStarted(runId, "seed-host", 1_700_000_000_001 + index * 10);
  const startSeq = repository.getSession(sessionId)?.committedSeq ?? 0;
  const events = [
    { type: "turn/start" as const, data: {} },
    { type: "message/user" as const, data: { text: `q${index}` } },
    { type: "message/assistant" as const, data: { text: "", toolCalls: [{ callId: "c1", name: "t", input: { n: 1 } }] } },
    { type: "tool/call" as const, data: { callId: "c1", name: "t", input: { n: 1 } } },
    { type: "tool/result" as const, data: { callId: "c1", name: "t", ok: true, content: "ok" } },
    { type: "message/assistant" as const, data: { text: "a", toolCalls: [] } },
    { type: "turn/end" as const, data: { reason: "completed" as const } },
  ];
  repository.commitTurn({
    runId,
    sessionId,
    turnId: `turn-${index}`,
    reason: "completed",
    turnStartSeq: startSeq,
    records: events.map((event, offset) =>
      Object.freeze({
        seq: startSeq + offset,
        turnId: `turn-${index}`,
        type: event.type,
        time: 1_700_000_000_000 + startSeq + offset,
        data: encodeStoredData({ type: event.type, turnId: `turn-${index}`, seq: startSeq + offset, time: 0, data: event.data } as never),
      }),
    ),
    endedAt: 1_700_000_000_002 + index * 10,
  });
  return runId;
}

/** The real encoded size of one frame, as UTF-8. */
function frameBytes(frame: string): number {
  return Buffer.byteLength(frame, "utf8");
}

/** Waits until `check` holds, letting the host's own microtasks run. */
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await flush();
  }
}

// ---------------------------------------------------------------------------
// R02 — a commit that cannot be judged is not a commit that landed.
// ---------------------------------------------------------------------------

interface InstalledInterference {
  /** How many receipts were interfered with (0 or 1). */
  injected(): number;
  restore(): void;
}

/**
 * Leaves the terminal batch's transaction open, with both endings refused.
 *
 * The batch is written, the COMMIT never runs and the ROLLBACK never runs, so
 * the connection still holds the transaction — and its rows are visible to it.
 * A read taken here would answer "committed" about a batch the store never
 * made durable, which is exactly the proof this test forbids the host to use.
 */
function interfereWithEndingTheTransaction(): InstalledInterference {
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
    if (armed && sql === "COMMIT") {
      armed = false;
      stuck = true;
      fired += 1;
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

/** Interferes with the terminal COMMIT exactly as the first batch's tests do. */
function interfereWithCommit(mode: "landed" | "discarded"): InstalledInterference {
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
      if (mode === "landed") {
        originalExec.call(this, sql);
        throw new Error("injected: the commit receipt was lost");
      }
      originalExec.call(this, "ROLLBACK");
      throw new Error("injected: the commit was refused");
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

describe("R02 transaction endings", () => {
  it("publishes the real terminal when the commit landed and only its receipt was lost", async () => {
    const composed = composeTestHost({ modelClient: scriptedModel([textReply("answer")]).client });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);
    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "hello",
    });
    const runId = started.result?.run.runId as string;

    const interference = interfereWithCommit("landed");
    const terminal = await awaitRunTerminal(client, runId);
    expect(interference.injected()).toBe(1);
    interference.restore();

    // A: the transaction ended (the commit landed), so the batch's own evidence
    // is readable and is the durable truth.
    expect(terminal.status).toBe("completed");
    expect(composed.repository.getRun(runId)?.status).toBe("completed");
    expect(composed.repository.readHistory(session.sessionId, 100, 50).records).toHaveLength(4);

    client.detach();
    await composed.host.shutdown();
  });

  it("retries the same storage batch when the transaction was really rolled back", async () => {
    const model = scriptedModel([textReply("answer")]);
    const composed = composeTestHost({ modelClient: model.client });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);
    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "hello",
    });
    const runId = started.result?.run.runId as string;

    const interference = interfereWithCommit("discarded");
    const terminal = await awaitRunTerminal(client, runId);
    expect(interference.injected()).toBe(1);
    interference.restore();

    // B: the rollback ran, so the batch provably did not land — the same
    // storage batch is retried, and nothing executes a second time.
    expect(terminal.status).toBe("completed");
    expect(composed.repository.getRun(runId)?.status).toBe("completed");
    expect(model.requests).toHaveLength(1);

    client.detach();
    await composed.host.shutdown();
  });

  it("reports an unknown outcome — never completed — when the transaction could not be ended", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "stuck.db");
      const composed = composeTestHost({
        modelClient: scriptedModel([textReply("answer")]).client,
        location: path,
      });
      const client = connect(composed.host);
      await client.describe();
      await client.call("subscriptions.open", {});
      const session = await createSessionThrough(client);
      const started = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: nextId("sub"),
        text: "hello",
      });
      const runId = started.result?.run.runId as string;

      const interference = interfereWithEndingTheTransaction();
      await flush();
      await flush();
      expect(interference.injected()).toBe(1);
      interference.restore();

      // C and D: the COMMIT never ran and the ROLLBACK never ran. Nothing can
      // be proven, so nothing is published: no terminal of any kind, and the
      // batch's uncommitted rows are never read as a durable outcome.
      expect(client.events.filter((event) => event.type === "run.ended")).toHaveLength(0);

      // E: the live entry is released, so the client is not shown the execution
      // it was watching. The durable record is what is served (a fresh
      // connection reads committed facts only), and it says: unfinished.
      const queried = await client.call("runs.get", { runId });
      expect(queried.error).toBeUndefined();
      const run = queried.result?.run;
      if (run?.status !== "running") throw new Error(`the run should read as unfinished, not ${String(run?.status)}`);
      expect(run.live).toEqual([]);
      expect(run.liveTruncated).toBe(true);

      // No new execution while the store cannot be trusted.
      const refused = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: nextId("sub"),
        text: "again",
      });
      expect(refused.error?.code).toBe("STORAGE_UNAVAILABLE");

      // The durable truth, read after the host released the file: no turn was
      // committed and the run never reached a terminal.
      client.detach();
      await composed.host.shutdown();
      const database = new DatabaseSync(path);
      const durable = database.prepare("SELECT status, committed_from_seq FROM runs WHERE run_id = ?").get(runId) as {
        readonly status?: string;
        readonly committed_from_seq?: number | null;
      };
      const history = database.prepare("SELECT COUNT(*) AS count FROM session_events").get() as { readonly count?: number };
      const highWater = database
        .prepare("SELECT committed_seq FROM sessions WHERE session_id = ?")
        .get(session.sessionId) as { readonly committed_seq?: number };
      database.close();
      expect(durable.status).toBe("running");
      expect(durable.committed_from_seq ?? null).toBeNull();
      expect(history.count).toBe(0);
      expect(highWater.committed_seq).toBe(0);

      // And a restart reconciles that unfinished run honestly.
      const restarted = composeTestHost({ modelClient: MODEL().client, location: path });
      const again = connect(restarted.host);
      await again.describe();
      const after = await again.call("runs.get", { runId });
      expect(after.result?.run.status).toBe("interrupted");
      expect(after.result?.run.executionKnowledge).toBe("unknown");
      expect(restarted.repository.getSession(session.sessionId)?.status).toBe("blocked");
      again.detach();
      await restarted.host.shutdown();
    });
  });

  it("refuses every read rather than answer from a connection it cannot trust", async () => {
    // An in-memory store has no second connection to re-read from, so the only
    // honest answer to a read is that the store cannot be read.
    const composed = composeTestHost({ modelClient: scriptedModel([textReply("answer")]).client });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);
    await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "hello",
    });

    const interference = interfereWithEndingTheTransaction();
    await flush();
    await flush();
    expect(interference.injected()).toBe(1);
    interference.restore();

    const list = await client.call("sessions.list", {});
    expect(list.error?.code).toBe("STORAGE_UNAVAILABLE");
    const get = await client.call("sessions.get", { sessionId: session.sessionId });
    expect(get.error?.code).toBe("STORAGE_UNAVAILABLE");
    const opened = await client.call("subscriptions.open", {});
    expect(opened.error?.code).toBe("STORAGE_UNAVAILABLE");

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R03 — one step, one validation, one durable representation.
// ---------------------------------------------------------------------------

/** A model that ends its stream without ever saying `done`. */
function eofReply(events: readonly ModelEvent[]): () => AsyncGenerator<ModelEvent> {
  return async function* (): AsyncGenerator<ModelEvent> {
    yield* events;
  };
}

describe("R03 step representability", () => {
  it.each([
    ["oversized arguments", { text: "x".repeat(70 * 1024) }],
    ["an input JSON cannot carry", { when: undefined }],
  ])("refuses %s on a stream that simply ends, with no tool dispatched", async (_name, input) => {
    let effects = 0;
    const tool = {
      ...constantTool("observer"),
      execute: async (): Promise<string> => {
        effects += 1;
        return "ran";
      },
    };
    const composed = composeTestHost({
      modelClient: scriptedModel([eofReply([{ type: "tool-call", call: { callId: "c1", name: "observer", input } }])], {
        repeatLast: true,
      }).client,
      plugins: [testPlugin({ id: "tools", tools: [tool] })],
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "use it",
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
    expect(terminal.status).toBe("failed");
    expect(effects).toBe(0);

    // Nothing was fabricated in the canonical log either: no assistant record
    // declared the call and no tool call stands without a declaration.
    const rows = composed.repository.readHistory(session.sessionId, 100, 50).records;
    expect(rows.some((record) => record.type === "tool/call")).toBe(false);
    expect(rows.some((record) => record.type === "message/assistant")).toBe(false);

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses an accessor on a stream that simply ends, without ever reading it", async () => {
    let reads = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "secret", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "leaked";
      },
    });

    let effects = 0;
    const tool = {
      ...constantTool("observer"),
      execute: async (): Promise<string> => {
        effects += 1;
        return "ran";
      },
    };
    const composed = composeTestHost({
      modelClient: scriptedModel([eofReply([{ type: "tool-call", call: { callId: "c1", name: "observer", input: hostile } }])], {
        repeatLast: true,
      }).client,
      plugins: [testPlugin({ id: "tools", tools: [tool] })],
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "use it",
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
    expect(terminal.status).toBe("failed");
    expect(effects).toBe(0);
    expect(reads).toBe(0);

    client.detach();
    await composed.host.shutdown();
  });

  /**
   * The arguments that make one step's assistant record exactly `size` bytes.
   *
   * The size is computed the way the store computes it — through the payload
   * builder the commit path uses, with the turn identity the step will really
   * be written under — so "exactly at the bound" is a fact about the record,
   * not about a test's arithmetic.
   */
  function argumentsForStepSize(size: number): { readonly pad: string } {
    const turnId = "00000000-0000-4000-8000-000000000000";
    const empty = stepRecordPayloads({ text: "", toolCalls: [{ callId: "c1", name: "big", input: { pad: "" } }] }, turnId)[0];
    const base = byteLength(empty) + byteLength(turnId) + 64;
    const pad = "x".repeat(size - base);
    return { pad };
  }

  function byteLength(data: string): number {
    return Buffer.byteLength(data, "utf8");
  }

  it("accepts a step whose record is exactly at the bound, and runs its tool", async () => {
    const bound = 64 * 1024;
    const input = argumentsForStepSize(bound);
    let executions = 0;
    const tool = {
      ...constantTool("big"),
      execute: async (): Promise<string> => {
        executions += 1;
        return "done";
      },
    };
    const composed = composeTestHost({
      modelClient: scriptedModel([toolReply("c1", "big", input), textReply("finished")]).client,
      plugins: [testPlugin({ id: "tools", tools: [tool] })],
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "go",
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);

    expect(terminal.status).toBe("completed");
    expect(executions).toBe(1);
    // The record the store accepted is exactly at the bound, turn identity and
    // envelope included — the same number the preflight measured.
    const assistant = composed.repository
      .readHistory(session.sessionId, 100, 50)
      .records.find((record) => record.type === "message/assistant");
    expect(assistant).toBeDefined();
    expect(byteLength(assistant?.data ?? "") + byteLength(assistant?.turnId ?? "") + 64).toBe(bound);

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses a step one byte past the bound, before the tool is dispatched", async () => {
    const bound = 64 * 1024;
    const input = argumentsForStepSize(bound + 1);
    let executions = 0;
    const tool = {
      ...constantTool("big"),
      execute: async (): Promise<string> => {
        executions += 1;
        return "done";
      },
    };
    const composed = composeTestHost({
      modelClient: scriptedModel([toolReply("c1", "big", input)], { repeatLast: true }).client,
      plugins: [testPlugin({ id: "tools", tools: [tool] })],
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "go",
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);

    expect(terminal.status).toBe("failed");
    expect(executions).toBe(0);
    const rows = composed.repository.readHistory(session.sessionId, 100, 50).records;
    expect(rows.some((record) => record.type === "tool/call")).toBe(false);

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R04 — the call the host validates is the call that runs and is recorded.
// ---------------------------------------------------------------------------

describe("R04 owned tool input", () => {
  it("keeps a provider's later mutation out of validation, execution and storage", async () => {
    const seen: unknown[] = [];
    const mutable: { pad: string; nested: { count: number }; items: string[] } = {
      pad: "original",
      nested: { count: 1 },
      items: ["a"],
    };

    // The provider hands over the call and then writes to the very objects it
    // handed over — the mutation a shallow copy would let through.
    const reply = async function* (): AsyncGenerator<ModelEvent> {
      yield { type: "tool-call", call: { callId: "c1", name: "observer", input: mutable } };
      mutable.pad = "changed";
      mutable.nested.count = 99;
      mutable.items.push("b");
      yield { type: "done" };
    };

    const composed = composeTestHost({
      modelClient: scriptedModel([reply, textReply("finished")]).client,
      plugins: [testPlugin({ id: "tools", tools: [recordingTool("observer", seen)] })],
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "use it",
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
    expect(terminal.status).toBe("completed");

    // The tool received the value as it was when the host took it over.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ pad: "original", nested: { count: 1 }, items: ["a"] });

    // And so did storage: the canonical item is the owned snapshot, not the
    // provider's object read again later.
    const page = await client.call("sessions.history", { sessionId: session.sessionId });
    const call = page.result?.page.items.find((item) => item.kind === "tool-call");
    expect(call).toBeDefined();
    expect(call !== undefined && call.kind === "tool-call" ? call.input : undefined).toEqual({
      kind: "json",
      value: { pad: "original", nested: { count: 1 }, items: ["a"] },
    });

    client.detach();
    await composed.host.shutdown();
  });

  it("owns a nested value deeply, not just the top-level properties", async () => {
    const seen: unknown[] = [];
    const shared = { items: ["a"], nested: { count: 1 } };
    const input = { first: shared, second: shared };

    const reply = async function* (): AsyncGenerator<ModelEvent> {
      yield { type: "tool-call", call: { callId: "c1", name: "observer", input } };
      // Every reachable property, including the shared one, is rewritten.
      shared.items.push("b");
      shared.nested.count = 99;
      yield { type: "done" };
    };

    const composed = composeTestHost({
      modelClient: scriptedModel([reply, textReply("finished")]).client,
      plugins: [testPlugin({ id: "tools", tools: [recordingTool("observer", seen)] })],
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "use it",
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
    expect(terminal.status).toBe("completed");
    expect(seen[0]).toEqual({ first: { items: ["a"], nested: { count: 1 } }, second: { items: ["a"], nested: { count: 1 } } });

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R05 — corruption is fully validated, and it stops the session.
// ---------------------------------------------------------------------------

describe("R05 canonical corruption", () => {
  async function seed(path: string, withTool = false): Promise<{ sessionId: string; runId: string }> {
    const composed = composeTestHost({ modelClient: MODEL().client, location: path });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    const runId = withTool ? writeToolTurn(composed.repository, "s-1", 1) : writeTurn(composed.repository, "s-1", 1, "q", "a");
    await composed.host.shutdown();
    return { sessionId: "s-1", runId };
  }

  /**
   * Every damage below is a durable record that disagrees with itself, and each
   * one is checked the same way: the page is refused, the session stops taking
   * runs, and nothing reaches a model.
   */
  const DAMAGE: readonly {
    readonly name: string;
    readonly apply: (database: DatabaseSync) => void;
    readonly withTool: boolean;
    /** Which read is expected to notice the disagreement. */
    readonly noticedBy: "run" | "page";
  }[] = [
    {
      name: "a completed run with no committed range",
      apply: (database) => {
        database.prepare("UPDATE runs SET committed_from_seq = NULL, committed_to_seq = NULL").run();
      },
      withTool: false,
      noticedBy: "run",
    },
    {
      name: "an assistant declaration that names a different call",
      apply: (database) => {
        database
          .prepare(
            `UPDATE session_events SET data = json_set(data, '$.toolCalls[0].callId', 'WRONG')
             WHERE type = 'message/assistant' AND json_array_length(json_extract(data, '$.toolCalls')) > 0`,
          )
          .run();
      },
      withTool: true,
      noticedBy: "page",
    },
    {
      name: "an assistant declaration whose input is not the call's",
      apply: (database) => {
        database
          .prepare(
            `UPDATE session_events SET data = json_set(data, '$.toolCalls[0].input.value.n', 999)
             WHERE type = 'message/assistant' AND json_array_length(json_extract(data, '$.toolCalls')) > 0`,
          )
          .run();
      },
      withTool: true,
      noticedBy: "page",
    },
    {
      name: "a display input claiming JSON with no value",
      apply: (database) => {
        database
          .prepare(`UPDATE session_events SET data = json_remove(data, '$.input.value') WHERE type = 'tool/call'`)
          .run();
      },
      withTool: true,
      noticedBy: "page",
    },
  ];

  it.each(DAMAGE)("refuses a session with %s, and stops it from executing", async (damage) => {
    await withTempDir(async (dir) => {
      const path = join(dir, "corrupt.db");
      await seed(path, damage.withTool);
      const database = new DatabaseSync(path);
      damage.apply(database);
      database.close();

      const model = scriptedModel([textReply("later")]);
      const composed = composeTestHost({ modelClient: model.client, location: path });
      const client = connect(composed.host);
      await client.describe();

      // Whichever read notices the disagreement, the answer is a refusal — and
      // that is the moment this session stops being executable.
      const noticed =
        damage.noticedBy === "run"
          ? await client.call("runs.get", { runId: "seed-run-1" })
          : await client.call("sessions.history", { sessionId: "s-1" });
      expect(noticed.error?.code).toBe("INTERNAL_ERROR");
      expect(noticed.result).toBeUndefined();
      expect(composed.repository.getSession("s-1")?.status).toBe("blocked");

      const refused = await client.call("runs.start", {
        sessionId: "s-1",
        submissionId: nextId("sub"),
        text: "next",
      });
      expect(refused.error?.code).toBe("SESSION_UNAVAILABLE");
      expect(model.requests).toHaveLength(0);

      client.detach();
      await composed.host.shutdown();
    });
  });

  it("refuses a page whose assistant declaration and call disagree, and blocks the session", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "pairing.db");
      await seed(path, true);
      const database = new DatabaseSync(path);
      database
        .prepare(`UPDATE session_events SET data = json_set(data, '$.toolCalls[0].name', 'other')
        WHERE type = 'message/assistant' AND json_array_length(json_extract(data, '$.toolCalls')) > 0`)
        .run();
      database.close();

      const composed = composeTestHost({ modelClient: MODEL().client, location: path });
      const client = connect(composed.host);
      await client.describe();

      const page = await client.call("sessions.history", { sessionId: "s-1" });
      expect(page.error?.code).toBe("INTERNAL_ERROR");
      expect(page.result).toBeUndefined();
      expect(composed.repository.getSession("s-1")?.status).toBe("blocked");

      // A run on this session is refused before admission, so no model call
      // ever sees the corrupted log.
      const refused = await client.call("runs.start", {
        sessionId: "s-1",
        submissionId: nextId("sub"),
        text: "next",
      });
      expect(refused.error?.code).toBe("SESSION_UNAVAILABLE");

      // Blocked is not deleted: the session is still readable and deletable.
      const summary = await client.call("sessions.get", { sessionId: "s-1" });
      expect(summary.result?.session.status).toBe("blocked");
      const renamed = await client.call("sessions.rename", {
        sessionId: "s-1",
        expectedRevision: summary.result?.session.metadataRevision as number,
        title: "still readable",
      });
      expect(renamed.result?.session.title).toBe("still readable");

      client.detach();
      await composed.host.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// R10 — the execution window is bounded in the representation the Core gets.
// ---------------------------------------------------------------------------

describe("R10 window representation", () => {
  /** The window's real cost: the events exactly as the Core will hold them. */
  function representationBytes(records: readonly StoredRecord[]): number {
    return encodedBytes(records.map(toSessionEvent));
  }

  it.each([
    ["ASCII", () => "a".repeat(12 * 1024)],
    ["中文", () => "汉".repeat(8 * 1024)],
    ["emoji", () => "🙂".repeat(8 * 1024)],
    ["escaping-heavy", () => "\u0000".repeat(4 * 1024)],
  ])("keeps the loaded window inside the budget with %s content", async (_name, makeAnswer) => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    for (let index = 1; index <= 24; index += 1) {
      writeTurn(composed.repository, "s-1", index, `q${index}`, makeAnswer());
    }

    const budget = 256 * 1024;
    const read = composed.repository.readTurnWindow("s-1", 16, budget);
    expect(representationBytes(read.records)).toBeLessThanOrEqual(budget);
    expect(read.baseSeq).toBeGreaterThan(0);

    await composed.host.shutdown();
  });

  it("stops exactly at the budget: one byte under, at, and one over", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    writeTurn(composed.repository, "s-1", 1, "q1", "a".repeat(4096));

    const whole = composed.repository.readHistory("s-1", 100, 50).records;
    const exact = representationBytes(whole);

    // Exactly the representation's size: the turn is loaded.
    const at = composed.repository.readTurnWindow("s-1", 16, exact);
    expect(at.records).toHaveLength(whole.length);
    expect(at.baseSeq).toBe(0);

    // One byte less than it costs: the newest turn itself no longer fits, and
    // the honest window is empty rather than over budget.
    const under = composed.repository.readTurnWindow("s-1", 16, exact - 1);
    expect(under.records).toEqual([]);
    expect(under.baseSeq).toBe(under.nextSeq);

    // One byte more: unchanged, because the turn already fits.
    const over = composed.repository.readTurnWindow("s-1", 16, exact + 1);
    expect(over.records).toHaveLength(whole.length);

    await composed.host.shutdown();
  });

  it("bounds a window that carries tool calls and results, one byte either side", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    writeTurn(composed.repository, "s-1", 1, "old", "old answer");
    writeToolTurn(composed.repository, "s-1", 2);

    const both = composed.repository.readHistory("s-1", 100, 50).records;
    const newest = both.slice(4);
    expect(newest.some((record) => record.type === "tool/call")).toBe(true);
    expect(newest.some((record) => record.type === "tool/result")).toBe(true);

    // Budget - 1: the newest turn — the one carrying the call and its result —
    // does not fit, so the honest window is empty rather than over budget.
    const underNewest = composed.repository.readTurnWindow("s-1", 16, representationBytes(newest) - 1);
    expect(underNewest.records).toEqual([]);
    expect(underNewest.baseSeq).toBe(underNewest.nextSeq);

    // Budget: exactly that turn, occurrences whole.
    const atNewest = composed.repository.readTurnWindow("s-1", 16, representationBytes(newest));
    expect(atNewest.records).toHaveLength(newest.length);
    expect(atNewest.baseSeq).toBe(4);
    expect(atNewest.records.some((record) => record.type === "tool/call")).toBe(true);
    expect(atNewest.records.some((record) => record.type === "tool/result")).toBe(true);

    // Budget + 1: unchanged, because the older turn still does not fit beside it.
    const overNewest = composed.repository.readTurnWindow("s-1", 16, representationBytes(newest) + 1);
    expect(overNewest.records).toHaveLength(newest.length);
    expect(overNewest.baseSeq).toBe(4);

    // Budget - 1 for both turns: the older one ends the window, and it is not
    // skipped over for an even older turn that might fit.
    const underBoth = composed.repository.readTurnWindow("s-1", 16, representationBytes(both) - 1);
    expect(underBoth.records).toHaveLength(newest.length);
    expect(underBoth.baseSeq).toBe(4);

    // Budget and budget + 1: the whole log fits.
    const atBoth = composed.repository.readTurnWindow("s-1", 16, representationBytes(both));
    expect(atBoth.records).toHaveLength(both.length);
    expect(atBoth.baseSeq).toBe(0);
    const overBoth = composed.repository.readTurnWindow("s-1", 16, representationBytes(both) + 1);
    expect(overBoth.records).toHaveLength(both.length);
    expect(overBoth.baseSeq).toBe(0);
    expect(representationBytes(overBoth.records)).toBeLessThanOrEqual(representationBytes(both) + 1);

    await composed.host.shutdown();
  });

  it("takes whole turns only: an older turn that would exceed the budget is not forced in", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client });
    composed.repository.createSession({ sessionId: "s-1", title: "t", createdAt: 1 });
    writeTurn(composed.repository, "s-1", 1, "old", "old answer");
    writeTurn(composed.repository, "s-1", 2, "newer", "a".repeat(2048));

    const newest = composed.repository.readHistory("s-1", 100, 50).records.slice(4);
    const newestCost = representationBytes(newest);
    const read = composed.repository.readTurnWindow("s-1", 16, newestCost);
    expect(read.baseSeq).toBe(4);
    expect(read.records).toHaveLength(4);

    // One byte short of both turns: only the newest is kept, and the older one
    // is not skipped over for an even older one that might fit.
    const partial = composed.repository.readTurnWindow("s-1", 16, newestCost + 4);
    expect(partial.baseSeq).toBe(4);

    await composed.host.shutdown();
  });

  it("bounds what a running execution actually holds, not just what it read", async () => {
    // A long, escaping-heavy history: the newest turns fit the window and the
    // oldest ones do not. What the Core is handed is measured as the value it
    // really holds — the loaded suffix, in its own representation.
    let state: HostState | undefined;
    let windowBytes = 0;
    let windowTurns = 0;
    const composed = composeHost(
      {
        modelClient: scriptedModel([
          async function* (): AsyncGenerator<ModelEvent> {
            const run = [...(state?.runs.values() ?? [])][0];
            const loaded = run?.window?.loadedSeq ?? 0;
            const events = (run?.window?.session.events() ?? []).slice(0, loaded);
            windowBytes = encodedBytes(events);
            windowTurns = events.filter((event) => event.type === "turn/start").length;
            yield { type: "text-delta", text: "done" };
            yield { type: "done" };
          },
        ]).client,
        plugins: [],
        persistence: { kind: "ephemeral" },
      },
      { onState: (observed) => (state = observed) },
    );
    composed.repository.createSession({ sessionId: "s-2", title: "t", createdAt: 1 });
    for (let index = 1; index <= 24; index += 1) {
      writeTurn(composed.repository, "s-2", index, `q${index}`, "\u0000".repeat(6 * 1024));
    }

    const client = connect(composed.host);
    await client.describe();
    const started = await client.call("runs.start", {
      sessionId: "s-2",
      submissionId: nextId("sub"),
      text: "continue",
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
    expect(terminal.status).toBe("completed");

    expect(windowBytes).toBeGreaterThan(0);
    expect(windowBytes).toBeLessThanOrEqual(256 * 1024);
    expect(windowTurns).toBeGreaterThanOrEqual(1);
    expect(windowTurns).toBeLessThan(24);

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R28 — an accepted configuration leaves room for every legal state.
// ---------------------------------------------------------------------------

describe("R28 snapshot headroom", () => {
  /** A plugin whose static summary carries `bytes` of description. */
  function bigPlugin(bytes: number): Plugin {
    return {
      manifest: { id: "big", name: "Big", version: "1.0.0", description: "d".repeat(bytes) },
      activate: (): void => undefined,
    };
  }

  it("keeps the heaviest legal run subscribable under a large static configuration", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client, plugins: [bigPlugin(150 * 1024)] });
    const client = connect(composed.host);
    await client.describe();
    const session = await createSessionThrough(client);

    // The largest input the store accepts, as a value: control characters,
    // escaped into a record that exactly fills the bound.
    const input = heaviestAcceptedText(64 * 1024);
    expect(Buffer.byteLength(input, "utf8")).toBeLessThanOrEqual(16 * 1024);
    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: input,
    });
    expect(started.error).toBeUndefined();

    // A run is in flight (its model reply is waiting on nothing, so settle
    // whatever state it reached), and the cut has to travel.
    await until(() => composed.repository.getSession(session.sessionId)?.activeRunId !== null, "the admission");
    const opened = await client.call("subscriptions.open", {});
    expect(opened.error).toBeUndefined();
    const frame = client.frames[client.frames.length - 1] as string;
    expect(frameBytes(frame)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    // The run is in the cut: nothing legal is hidden to make the frame fit.
    expect(opened.result?.snapshot.runs.items.some((run) => run.runId === started.result?.run.runId)).toBe(true);

    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
    expect(terminal.status).toBe("completed");
    const again = await client.call("subscriptions.open", {});
    expect(again.error).toBeUndefined();

    client.detach();
    await composed.host.shutdown();
  });

  it("keeps a cut bounded with existing sessions and an active run", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client, plugins: [bigPlugin(120 * 1024)] });
    composed.repository.createSession({ sessionId: "s-old", title: "t", createdAt: 1 });
    for (let index = 1; index <= 5; index += 1) {
      writeTurn(composed.repository, "s-old", index, "x".repeat(1024) + index, `a${index}`);
    }

    const client = connect(composed.host);
    await client.describe();
    const session = await createSessionThrough(client);
    await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: heaviestAcceptedText(64 * 1024),
    });
    await until(() => composed.repository.getSession(session.sessionId)?.activeRunId !== null, "the admission");

    const opened = await client.call("subscriptions.open", {});
    expect(opened.error).toBeUndefined();
    const frame = client.frames[client.frames.length - 1] as string;
    expect(frameBytes(frame)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    const snapshot = opened.result?.snapshot;
    expect(snapshot).toBeDefined();
    // Whatever the cut left out, it says it left out.
    if ((snapshot?.sessions.items.length ?? 0) < 6 || (snapshot?.runs.items.length ?? 0) < 6) {
      expect(snapshot?.runs.hasMore === true || snapshot?.sessions.hasMore === true).toBe(true);
    }

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses a configuration that leaves no room for any legal run", () => {
    // The static catalogue alone fits, but nothing can be added to it: this is
    // the configuration the startup check exists to refuse.
    expect(() => composeTestHost({ modelClient: MODEL().client, plugins: [bigPlugin(200 * 1024)] })).toThrow(
      /frame|room/i,
    );
  });

  it("refuses an input whose accepted run could never be published, before admission", async () => {
    const composed = composeTestHost({ modelClient: MODEL().client, plugins: [bigPlugin(150 * 1024)] });
    const client = connect(composed.host);
    await client.describe();
    const session = await createSessionThrough(client);

    // A legal input, but an identity no frame could carry alongside it.
    const submissionId = "s".repeat(200 * 1024);
    const refused = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId,
      text: "hello",
    });
    expect(refused.error?.code).toBe("LIMIT_EXCEEDED");
    expect(composed.repository.getSubmission(submissionId)).toBeUndefined();
    expect(composed.repository.listUnfinishedRuns()).toEqual([]);

    client.detach();
    await composed.host.shutdown();
  });
});
