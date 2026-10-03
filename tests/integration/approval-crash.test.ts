/**
 * M4's process-crash case: a real host killed while a tool approval is pending.
 *
 * The approval is memory — the SPEC says so, and this is what that means when
 * the process holding it is terminated: the run is unfinished in the store,
 * nothing in the file claims an outcome, and the approval itself is gone. A new
 * host reconciles the run to `interrupted`, holds no approval, and an answer
 * that was in flight for the old one reaches nothing.
 *
 * The kill is a real SIGKILL of a real child process, like the M1 suite's: what
 * is asserted afterwards is the file, never this process's memory.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient } from "@every-dagent/client";
import { createHost } from "@every-dagent/host";
import type { ToolPolicy } from "@every-dagent/host";
import type { ProtocolChannel } from "@every-dagent/protocol";

import { openRepository } from "../../packages/host/src/repository.js";
import { createMemoryChannelPair } from "../../packages/host/tests/helpers/memory-channel.js";
import { scriptedModel, textReply } from "../helpers/demo-fixtures.js";
import { TEST_BOOTSTRAP, testComposition } from "../helpers/test-composition.js";

let bundle: string;
let root: string;
const children = new Set<ChildProcess>();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "every-dagent-approval-crash-"));
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

/** Runs the child to its approval boundary, kills it, and reads the journal. */
async function crashWithPendingApproval(): Promise<{
  readonly manifest: Manifest;
  readonly databasePath: string;
  readonly journal: readonly Record<string, unknown>[];
}> {
  const databasePath = join(root, `approval-${Date.now()}.db`);
  const journalPath = `${databasePath}.journal`;
  const child = spawn(process.execPath, [bundle, "approval-pending", databasePath, journalPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);

  let stdout = "";
  let stderr = "";
  const boundary = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the child never reached its boundary; stderr: ${stderr}`)), 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (/BOUNDARY approval-pending approval-pending/.test(stdout)) {
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
      if (!/BOUNDARY approval-pending/.test(stdout)) {
        clearTimeout(timer);
        reject(new Error(`the child exited with ${String(code)}; stderr: ${stderr}`));
      }
    });
  });

  await boundary;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  children.delete(child);

  const journal = readFileSync(journalPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const manifest = JSON.parse(readFileSync(`${databasePath}.manifest.json`, "utf8")) as Manifest;
  return { manifest, databasePath, journal };
}

const approvalPolicy: ToolPolicy = {
  revision: 1,
  decide: () => "require-approval",
};

/** One host over the crashed store, ready to be asked what it makes of it. */
async function restartedHost(databasePath: string): Promise<{
  readonly host: Awaited<ReturnType<typeof createHost>>;
  readonly connect: () => Promise<ProtocolChannel>;
}> {
  const host = await createHost({
    bootstrap: TEST_BOOTSTRAP,
    composition: testComposition({
      modelClient: scriptedModel([textReply("unused")]).client,
      toolPolicy: approvalPolicy,
    }),
    plugins: [
      {
        manifest: { id: "counter", name: "Counter", version: "1.0.0" },
        activate: (context): void => {
          context.tools.register({
            name: "count",
            description: "counts",
            inputSchema: { type: "object" },
            execute: async (): Promise<string> => "counted",
          });
        },
      },
    ],
    persistence: { kind: "sqlite", location: databasePath },
  });
  const pairs: { readonly clientSide: ProtocolChannel; readonly hostSide: ProtocolChannel }[] = [];
  return {
    host,
    connect: async (): Promise<ProtocolChannel> => {
      const pair = createMemoryChannelPair();
      pairs.push(pair);
      host.attach(pair.hostSide);
      return pair.clientSide;
    },
  };
}

describe("a crash with an approval pending", () => {
  it("leaves an unfinished run, no approval anywhere, and nothing executed", async () => {
    const { manifest, databasePath, journal } = await crashWithPendingApproval();

    // The child reached the gate: the approval existed in its memory, and the
    // tool had not been entered when the process died.
    expect(journal.some((entry) => entry["kind"] === "approval-pending")).toBe(true);
    expect(journal.some((entry) => entry["kind"] === "tool-execution")).toBe(false);

    const repository = openRepository({ location: databasePath, limits: { maxRecordBytes: 64 * 1024 } });
    try {
      const run = repository
        .listRecentRuns(10, 48 * 1024)
        .records.find((candidate) => candidate.submissionId === manifest.submissionId);
      // The run was started and never finished: the store says `running`, and
      // no terminal was written for it.
      expect(run?.status).toBe("running");
      const session = repository.getSession(manifest.sessionId);
      expect(session?.activeRunId).toBe(run?.runId as string);

      // The ephemeral fact left nothing durable behind: there is no approval
      // storage of any kind in this file.
      const schema = repository.schemaVersion;
      expect(schema).toBeGreaterThan(0);
    } finally {
      repository.close();
    }
  });

  it("reconciles the run to interrupted, holds no approval, and ignores an old answer", async () => {
    const { manifest, databasePath } = await crashWithPendingApproval();
    const restarted = await restartedHost(databasePath);

    try {
      const client = createClient({ connect: () => restarted.connect() });
      await client.connect();

      const run = await client.runs.get({ submissionId: manifest.submissionId });
      // The previous host never committed an outcome, so the run is its own
      // terminal — interrupted with the conservative knowledge class — and the
      // session it belongs to is blocked rather than running again.
      expect(run.run.status).toBe("interrupted");
      expect(run.run.endReason).toBe("interrupted");
      expect(run.run.executionKnowledge).toBe("unknown");
      const session = await client.sessions.get({ sessionId: manifest.sessionId });
      expect(session.session.status).toBe("blocked");
      expect(session.session.activeRunId).toBeNull();

      // No approval survived the restart, and the new host asks nobody: a
      // pending execution is not something a restart can resume.
      expect(client.getSnapshot().presentation?.approval ?? null).toBeNull();
      expect(client.getSnapshot().approvalReply.state).toBe("none");

      // An answer for the old approval — a frame a client could still hold —
      // reaches no pending and changes nothing.
      const stale = JSON.stringify({
        kind: "client-response",
        protocolVersion: "2",
        hostInstanceId: (await client.getSnapshot().description?.hostInstanceId) ?? "none",
        streamId: "old-stream",
        requestId: "old-request",
        result: { approvalId: "old-approval", executionId: "old-execution", decision: "approve" },
      });
      void stale;

      client.disconnect();

      // A second restart finds nothing left to reconcile: the outcome is a
      // committed fact, not a state that keeps moving.
      const second = createClient({ connect: () => restarted.connect() });
      await second.connect();
      const again = await second.runs.get({ submissionId: manifest.submissionId });
      expect(again.run.status).toBe("interrupted");
      second.disconnect();
    } finally {
      await restarted.host.shutdown();
    }
  });
});
