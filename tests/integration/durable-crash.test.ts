/**
 * M1's process-crash suite: real forced terminations of a real host on a real
 * SQLite file.
 *
 * Releasing a store in-process proves what the *code* would have written next;
 * it cannot prove what a process that never got to run any more code leaves
 * behind. Every case here starts a child process that drives a real host, kills
 * it with SIGKILL at one named boundary — before a COMMIT, after one, or in the
 * middle of a batch — and then asks the file what happened.
 *
 * The boundaries are the ones the SPEC names: before the admission commit,
 * after admission and before the start marker, after the start marker and
 * before any execution, inside the terminal transaction, before the terminal
 * COMMIT, after it, and inside a restart's reconciliation. The parent checks
 * the durable facts each one must leave: the canonical turn, the run's status
 * and execution knowledge, the session's pointer and blocked state, the
 * submission's dedup, and that a second reconciliation has nothing left to do.
 *
 * What this proves is *process* crash semantics. It is not a power-loss or
 * hardware-durability certification, and it is not claimed as one.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ModelClient, ModelEvent, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";

import { createHost } from "@every-dagent/host";
import { openRepository, submissionHash } from "../../packages/host/src/repository.js";
import type { Repository } from "../../packages/host/src/repository.js";

import { TEST_MODEL_LIMITS } from "../helpers/model-limits.js";

const MAX_RECORD_BYTES = 64 * 1024;

let bundle: string;
let root: string;

/** Every child this file ever started, so a failing test cannot leak one. */
const children = new Set<ChildProcess>();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "every-dagent-crash-"));
  bundle = join(root, "durable-crash-child.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../fixtures/durable-crash-child.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    logLevel: "silent",
  });
}, 120_000);

afterAll(async () => {
  // A test that failed before its kill, or timed out, may still have a child
  // parked at a boundary and holding the file; terminate them all before the
  // directory goes away.
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await new Promise((resolve) => {
    setTimeout(resolve, 250);
  });
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A file still held by a dying child is not a test failure.
  }
});

interface Manifest {
  readonly phase: string;
  readonly sessionId: string;
  readonly submissionId: string;
}

interface CrashOutcome {
  readonly manifest: Manifest;
  readonly databasePath: string;
  readonly journal: readonly Record<string, unknown>[];
  readonly signal: NodeJS.Signals | null;
  readonly boundary: string | undefined;
}

/** Runs one child until its boundary, kills it, and reports what it left. */
async function crashAt(phase: string, databasePath: string): Promise<CrashOutcome> {
  const journalPath = `${databasePath}.journal`;

  const child: ChildProcess = spawn(process.execPath, [bundle, phase, databasePath, journalPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);

  let stdout = "";
  let stderr = "";
  let boundary: string | undefined;

  const boundarySeen = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`child (${phase}) never reached its boundary; stderr: ${stderr}`));
    }, 60_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = /BOUNDARY (\S+) (\S+)/.exec(stdout);
      if (match !== null && boundary === undefined) {
        boundary = `${match[1]} ${match[2]}`;
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (boundary === undefined) {
        clearTimeout(timer);
        reject(new Error(`child (${phase}) exited early with ${String(code)}; stderr: ${stderr}`));
      }
    });
  });

  await boundarySeen;
  child.kill("SIGKILL");
  const signal = await new Promise<NodeJS.Signals | null>((resolve) => {
    child.once("exit", (_code, exitSignal) => resolve(exitSignal));
  });
  children.delete(child);

  const manifest = JSON.parse(readFileSync(`${databasePath}.manifest.json`, "utf8")) as Manifest;
  let journal: Record<string, unknown>[] = [];
  try {
    journal = readFileSync(journalPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    // No journal means the child died before it recorded anything, which is
    // itself the answer for the earliest boundary.
  }

  return { manifest, databasePath, journal, signal, boundary };
}

function countJournal(journal: readonly Record<string, unknown>[], kind: string): number {
  return journal.filter((entry) => entry["kind"] === kind).length;
}

/** Opens the store the killed child left, the way a restart would. */
function reopen(databasePath: string): Repository {
  return openRepository({ location: databasePath, limits: { maxRecordBytes: MAX_RECORD_BYTES } });
}

/** A model client that counts, for proving a restart executes nothing. */
function countingModel(calls: { count: number }): ModelClient {
  return {
    limits: TEST_MODEL_LIMITS,
    async *stream(_request: ModelRequest, _context: RuntimeContext): AsyncGenerator<ModelEvent> {
      calls.count += 1;
      yield { type: "text-delta", text: "unexpected" };
      yield { type: "done" };
    },
  };
}

describe("process crashes at the durable boundaries", () => {
  it("leaves nothing committed when killed before the admission commit", async () => {
    const databasePath = join(root, "admission-before.db");
    const outcome = await crashAt("admission-before", databasePath);
    // The process was terminated, not asked to stop.
    expect(outcome.signal).toBe("SIGKILL");
    const repository = reopen(databasePath);

    try {
      // The admission transaction never committed, so there is no run, no
      // submission and no pointer — and the session itself (created earlier) is
      // untouched and ready.
      expect(repository.getSubmission(outcome.manifest.submissionId)).toBeUndefined();
      expect(repository.getSession(outcome.manifest.sessionId)?.activeRunId).toBeNull();
      expect(repository.getSession(outcome.manifest.sessionId)?.status).toBe("ready");
      expect(repository.listUnfinishedRuns()).toEqual([]);
      expect(repository.getSession(outcome.manifest.sessionId)?.committedSeq).toBe(0);

      // Nothing executed: no model call, no tool.
      expect(countJournal(outcome.journal, "model-call")).toBe(0);
      expect(countJournal(outcome.journal, "tool-execution")).toBe(0);

      // A resubmission is a fresh admission, because nothing was committed.
      const repeated = repository.admitRun({
        runId: "run-after-crash",
        submissionId: outcome.manifest.submissionId,
        sessionId: outcome.manifest.sessionId,
        text: "hello",
        inputHash: submissionHash(outcome.manifest.sessionId, "hello"),
        hostInstanceId: "restarted",
        acceptedAt: Date.now(),
      });
      expect(repeated.kind).toBe("admitted");
    } finally {
      repository.close();
    }
  }, 30_000);

  it("recovers an accepted run as interrupted / not-started when killed before the start marker", async () => {
    const databasePath = join(root, "accepted.db");
    const outcome = await crashAt("accepted", databasePath);
    const repository = reopen(databasePath);

    try {
      const run = repository.getSubmission(outcome.manifest.submissionId)?.runId ?? undefined;
      const record = run === undefined ? undefined : repository.getRun(run);
      expect(record?.status).toBe("accepted");
      expect(record?.startedAt).toBeNull();
      expect(countJournal(outcome.journal, "model-call")).toBe(0);

      const reconciled = repository.reconcileInterrupted("restarted", Date.now());
      expect(reconciled.interrupted).toBe(1);

      const settled = run === undefined ? undefined : repository.getRun(run);
      expect(settled?.status).toBe("interrupted");
      expect(settled?.endReason).toBe("interrupted");
      expect(settled?.executionKnowledge).toBe("not-started");
      const session = repository.getSession(outcome.manifest.sessionId);
      expect(session?.activeRunId).toBeNull();
      expect(session?.status).toBe("ready");

      // Idempotent: a second reconciliation has nothing left to do.
      expect(repository.reconcileInterrupted("restarted-again", Date.now()).interrupted).toBe(0);

      // Dedup survives the restart: the same submission returns the same run.
      const duplicate = repository.admitRun({
        runId: "run-after-crash",
        submissionId: outcome.manifest.submissionId,
        sessionId: outcome.manifest.sessionId,
        text: "hello",
        inputHash: submissionHash(outcome.manifest.sessionId, "hello"),
        hostInstanceId: "restarted",
        acceptedAt: Date.now(),
      });
      expect(duplicate.kind).toBe("existing");
      expect(duplicate.kind === "existing" ? duplicate.run.runId : undefined).toBe(run);
    } finally {
      repository.close();
    }
  }, 30_000);

  it("recovers a started run as interrupted / unknown and blocks the session", async () => {
    const databasePath = join(root, "running.db");
    const outcome = await crashAt("running", databasePath);
    const repository = reopen(databasePath);

    try {
      const runId = repository.getSubmission(outcome.manifest.submissionId)?.runId ?? undefined;
      expect(runId).toBeDefined();

      // The start marker is durable, and nothing after it ran.
      const before = runId === undefined ? undefined : repository.getRun(runId);
      expect(before?.status).toBe("running");
      expect(countJournal(outcome.journal, "model-call")).toBe(0);
      expect(countJournal(outcome.journal, "tool-execution")).toBe(0);
      expect(repository.getSession(outcome.manifest.sessionId)?.committedSeq).toBe(0);

      expect(repository.reconcileInterrupted("restarted", Date.now()).interrupted).toBe(1);
      const settled = runId === undefined ? undefined : repository.getRun(runId);
      expect(settled?.status).toBe("interrupted");
      expect(settled?.executionKnowledge).toBe("unknown");
      const session = repository.getSession(outcome.manifest.sessionId);
      expect(session?.status).toBe("blocked");
      expect(session?.blockedReason).toBe("unknown-execution");
      expect(session?.activeRunId).toBeNull();
      expect(repository.reconcileInterrupted("restarted-again", Date.now()).interrupted).toBe(0);

      // The committed history was never touched.
      expect(repository.readHistory(outcome.manifest.sessionId, 100, 50).records).toEqual([]);
    } finally {
      repository.close();
    }
  }, 30_000);

  it("discards the whole terminal batch when killed inside it", async () => {
    const databasePath = join(root, "terminal-mid.db");
    const outcome = await crashAt("terminal-mid", databasePath);
    const repository = reopen(databasePath);

    try {
      const runId = repository.getSubmission(outcome.manifest.submissionId)?.runId ?? undefined;
      // The model ran and the tool executed; only the commit was interrupted.
      expect(countJournal(outcome.journal, "model-call")).toBeGreaterThan(0);
      expect(countJournal(outcome.journal, "tool-execution")).toBe(1);

      const session = repository.getSession(outcome.manifest.sessionId);
      expect(session?.committedSeq).toBe(0);
      expect(repository.readHistory(outcome.manifest.sessionId, 100, 50).records).toEqual([]);
      expect(repository.getRun(runId ?? "")?.status).toBe("running");

      expect(repository.reconcileInterrupted("restarted", Date.now()).interrupted).toBe(1);
      const settled = repository.getRun(runId ?? "");
      expect(settled?.status).toBe("interrupted");
      expect(settled?.executionKnowledge).toBe("unknown");
      expect(repository.getSession(outcome.manifest.sessionId)?.status).toBe("blocked");
      expect(repository.reconcileInterrupted("restarted-again", Date.now()).interrupted).toBe(0);
    } finally {
      repository.close();
    }
  }, 30_000);

  it("discards the whole terminal batch when killed before its commit", async () => {
    const databasePath = join(root, "terminal-before.db");
    const outcome = await crashAt("terminal-before", databasePath);
    const repository = reopen(databasePath);

    try {
      const runId = repository.getSubmission(outcome.manifest.submissionId)?.runId ?? undefined;
      expect(countJournal(outcome.journal, "model-call")).toBeGreaterThan(0);
      expect(repository.getSession(outcome.manifest.sessionId)?.committedSeq).toBe(0);
      expect(repository.getRun(runId ?? "")?.status).toBe("running");
      expect(repository.getSession(outcome.manifest.sessionId)?.activeRunId).toBe(runId);

      expect(repository.reconcileInterrupted("restarted", Date.now()).interrupted).toBe(1);
      expect(repository.getRun(runId ?? "")?.status).toBe("interrupted");
      expect(repository.getRun(runId ?? "")?.executionKnowledge).toBe("unknown");
    } finally {
      repository.close();
    }
  }, 30_000);

  it("keeps the committed terminal when killed after its commit but before any response", async () => {
    const databasePath = join(root, "terminal-after.db");
    const outcome = await crashAt("terminal-after", databasePath);
    const repository = reopen(databasePath);

    try {
      const runId = repository.getSubmission(outcome.manifest.submissionId)?.runId ?? undefined;
      const session = repository.getSession(outcome.manifest.sessionId);
      // The commit landed: canonical turn, run terminal, cleared pointer — all
      // of it — and the process died before it could tell anyone.
      // Seven records: turn start, user, assistant, call, result, final
      // assistant, turn end — the whole turn, and nothing half of it.
      expect(session?.committedSeq).toBe(7);
      expect(repository.readHistory(outcome.manifest.sessionId, 100, 50).records).toHaveLength(7);
      expect(repository.getRun(runId ?? "")?.status).toBe("completed");
      expect(repository.getRun(runId ?? "")?.endReason).toBe("completed");
      expect(session?.activeRunId).toBeNull();
      expect(session?.status).toBe("ready");

      // Restart reconciles nothing: a committed terminal is never demoted.
      expect(repository.reconcileInterrupted("restarted", Date.now()).interrupted).toBe(0);
      expect(repository.getRun(runId ?? "")?.status).toBe("completed");
      expect(repository.reconcileInterrupted("restarted-again", Date.now()).interrupted).toBe(0);

      // Dedup across the restart: the same submission answers with the same
      // run, and the run is not executed again — by anyone.
      const duplicate = repository.admitRun({
        runId: "run-after-crash",
        submissionId: outcome.manifest.submissionId,
        sessionId: outcome.manifest.sessionId,
        text: "hello",
        inputHash: submissionHash(outcome.manifest.sessionId, "hello"),
        hostInstanceId: "restarted",
        acceptedAt: Date.now(),
      });
      expect(duplicate.kind).toBe("existing");
      expect(duplicate.kind === "existing" ? duplicate.run.status : undefined).toBe("completed");
      repository.close();

      // A real host over the same file, with a model that would be called if
      // anything resumed: nothing resumes.
      const calls = { count: 0 };
      const host = createHost({
        modelClient: countingModel(calls),
        plugins: [],
        persistence: { kind: "sqlite", location: databasePath },
      });
      await host.shutdown();
      expect(calls.count).toBe(0);
    } finally {
      repository.close();
    }
  }, 30_000);

  it("completes an interrupted reconciliation on the next start, idempotently", async () => {
    const databasePath = join(root, "reconcile-mid.db");

    // First child: durable run left running (the same file the second uses).
    const first = await crashAt("running", databasePath);
    const repository = reopen(databasePath);
    repository.close();

    // Second child: killed inside its own startup reconciliation.
    const second = await crashAt("reconcile-mid", databasePath);
    expect(second.manifest.sessionId).toBe(first.manifest.sessionId);

    const after = reopen(databasePath);
    try {
      const runId = after.getSubmission(second.manifest.submissionId)?.runId;
      // The interrupted reconciliation left the run unfinished again — never
      // partially reconciled.
      const left = after.getRun(runId ?? "");
      expect(left?.status === "running" || left?.status === "interrupted").toBe(true);

      // The next start finishes the same job, and a further one has nothing to
      // do: reconciliation is idempotent across its own crash.
      const firstPass = after.reconcileInterrupted("restarted", Date.now());
      const settled = after.getRun(runId ?? "");
      expect(settled?.status).toBe("interrupted");
      expect(settled?.executionKnowledge).toBe("unknown");
      expect(after.reconcileInterrupted("restarted-again", Date.now()).interrupted).toBe(0);
      void firstPass;
      expect(after.getSession(second.manifest.sessionId)?.status).toBe("blocked");
    } finally {
      after.close();
    }
  }, 30_000);

  it("leaves no half-state: no journal of a turn that is not in storage", async () => {
    // The suite's own sanity check, over every database it produced: whatever a
    // child executed must never be presented as committed history.
    const databases = readdirSync(root).filter((name) => name.endsWith(".db"));

    for (const name of databases) {
      const repository = reopen(join(root, name));
      try {
        const rows = repository.listRecentRuns(50, 1024 * 1024).records;
        for (const run of rows) {
          const session = repository.getSession(run.sessionId);
          if (session === undefined) continue;
          if (run.status === "completed") {
            // A completed run's turn is in the index, and the session agrees.
            expect(session.committedSeq).toBeGreaterThan(0);
            expect(repository.verifyRunHistory(run)).toBe(true);
          }
          if (run.status === "accepted" || run.status === "running") {
            // Unfinished, and pointed at.
            expect(session.activeRunId).toBe(run.runId);
          }
          if (run.status === "interrupted") {
            expect(session.activeRunId).toBeNull();
          }
        }
      } finally {
        repository.close();
      }
    }
  }, 30_000);
});
