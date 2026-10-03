/**
 * One process of the durable crash suite.
 *
 * The suite's question is what a *forced termination* leaves behind, so the
 * child is a real one: a real host, a real SQLite file, a real client on a
 * loopback channel, and a boundary it can be killed at. Nothing here simulates
 * a crash in-process — the parent sends SIGKILL from outside, and every
 * assertion afterwards is about the file, never about this process's memory.
 *
 * A boundary is armed at the SQLite API, one level below the repository: the
 * child watches for the statement that starts the transaction it cares about
 * and then parks (printing `BOUNDARY <phase>` first) at the exact moment the
 * phase names — before a COMMIT, after one, or in the middle of a batch. The
 * parent's kill lands while the process is parked there, which is what makes
 * the kill point real rather than approximate.
 *
 * `argv`: `[phase, databasePath, journalPath]`. The journal is the only channel
 * that survives the kill, and it is how the parent learns how many model calls
 * and tool executions actually happened before it.
 */

import { appendFileSync, writeFileSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { ModelClient, ModelEvent, ModelRequest, RuntimeContext, Tool } from "@every-dagent/agent-core";
import { createClient } from "@every-dagent/client";
import { createHost } from "@every-dagent/host";
import type { ToolPolicy } from "@every-dagent/host";
import type { ProtocolChannel, ProtocolChannelListener } from "@every-dagent/protocol";
import type { Plugin } from "@every-dagent/plugin-system";

import { TEST_MODEL_LIMITS } from "../helpers/model-limits.js";
import { TEST_BOOTSTRAP, testComposition } from "../helpers/test-composition.js";

const [phase, databasePath, journalPath] = process.argv.slice(2);
if (phase === undefined || databasePath === undefined || journalPath === undefined) {
  process.stderr.write("usage: durable-crash-child <phase> <database> <journal>\n");
  process.exit(2);
}

const SUBMISSION_ID = "crash-submission";
const MANIFEST_PATH = `${databasePath}.manifest.json`;

function journal(entry: Record<string, unknown>): void {
  appendFileSync(journalPath, `${JSON.stringify(entry)}\n`);
}

// ---------------------------------------------------------------------------
// The boundary.
// ---------------------------------------------------------------------------

/** Parks the process until the parent kills it; the marker is printed first. */
function park(at: string): void {
  process.stdout.write(`BOUNDARY ${phase} ${at}\n`);
  // A real block on the main thread: the process is alive, holding whatever the
  // transaction holds, and does nothing until it is terminated.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  // Reached only if the parent somehow failed to kill it: that is a suite
  // failure, not a boundary.
  process.stderr.write(`the boundary at ${at} was never terminated\n`);
  process.exit(4);
}

/**
 * The statement each phase's transaction opens with, and when to park.
 *
 * `before`: park at that transaction's COMMIT, before it lands — the
 * transaction and everything in it is lost. `after`: park at the COMMIT, after
 * it landed — the batch is durable and the process dies before it can say so.
 * `inside`: park in the middle of the batch, with no COMMIT yet attempted.
 */
const BOUNDARY_OF: Record<string, { readonly opens: string; readonly when: "before" | "after" | "inside" }> = {
  "admission-before": { opens: "INSERT INTO runs", when: "before" },
  accepted: { opens: "UPDATE runs SET status = 'running'", when: "before" },
  running: { opens: "UPDATE runs SET status = 'running'", when: "after" },
  "terminal-mid": { opens: "INSERT INTO session_events", when: "inside" },
  "terminal-before": { opens: "INSERT INTO session_events", when: "before" },
  "terminal-after": { opens: "INSERT INTO session_events", when: "after" },
  "reconcile-mid": { opens: "UPDATE runs SET status = 'interrupted'", when: "inside" },
};

function armBoundary(): void {
  const boundary = BOUNDARY_OF[phase];
  if (boundary === undefined) {
    process.stderr.write(`unknown phase ${phase}
`);
    process.exit(2);
  }

  let armed = false;
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;

  /** Whether this statement is the one that opens the boundary's transaction. */
  const opens = (sql: string): boolean => sql.startsWith(boundary.opens);

  // Statements reach the database two ways — `exec(sql)` and
  // `prepare(sql).run(...)` — and the transactions this suite cares about use
  // both, so both are watched. The watch only arms: the boundary itself is the
  // COMMIT (or the statement, for an in-batch kill) that follows.
  DatabaseSync.prototype.prepare = function patchedPrepare(this: DatabaseSync, sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (!opens(sql)) return statement;

    if (boundary.when === "inside") {
      const run = statement.run.bind(statement);
      (statement as { run: unknown }).run = (...args: Parameters<typeof run>): unknown => {
        const result = run(...args);
        park("mid-batch");
        return result;
      };
      return statement;
    }

    if (!armed) armed = true;
    return statement;
  };

  DatabaseSync.prototype.exec = function patchedExec(this: DatabaseSync, sql: string): void {
    if (sql === "COMMIT" && armed) {
      armed = false;
      if (boundary.when === "before") park("commit-before");
      originalExec.call(this, sql);
      if (boundary.when === "after") park("commit-after");
      return;
    }
    if (!armed && opens(sql)) armed = true;
    originalExec.call(this, sql);
  };
}

// ---------------------------------------------------------------------------
// The composition: a real host over the file, a real client over a channel.
// ---------------------------------------------------------------------------

function channelPair(): { readonly hostSide: ProtocolChannel; readonly clientSide: ProtocolChannel } {
  const state: {
    clientListener?: ProtocolChannelListener;
    hostListener?: ProtocolChannelListener;
    closed: boolean;
  } = { closed: false };

  function closeBoth(): void {
    if (state.closed) return;
    state.closed = true;
    state.clientListener?.onClose();
    state.hostListener?.onClose();
  }

  function side(direction: "client" | "host"): ProtocolChannel {
    const isClient = direction === "client";
    return {
      send(frame: string): void {
        if (state.closed) throw new Error("channel is closed");
        const listener = isClient ? state.hostListener : state.clientListener;
        if (listener === undefined) throw new Error("listener must be installed before traffic");
        listener.onFrame(frame);
      },
      listen(listener: ProtocolChannelListener): () => void {
        if (state.closed) throw new Error("channel is closed");
        if (isClient) state.clientListener = listener;
        else state.hostListener = listener;
        return () => {
          if (isClient) state.clientListener = undefined;
          else state.hostListener = undefined;
        };
      },
      close(): void {
        closeBoth();
      },
    };
  }

  return { hostSide: side("host"), clientSide: side("client") };
}

/** The model that drives one turn: a tool call, then an answer. */
function crashModel(): ModelClient {
  return {
    limits: TEST_MODEL_LIMITS,
    async *stream(request: ModelRequest, _context: RuntimeContext): AsyncGenerator<ModelEvent> {
      journal({ kind: "model-call" });
      const last = request.messages[request.messages.length - 1];
      if (last === undefined || last.role !== "tool") {
        yield { type: "tool-call", call: { callId: "c1", name: "count", input: { n: 1 } } };
        yield { type: "done" };
        return;
      }
      yield { type: "text-delta", text: "done" };
      yield { type: "done" };
    },
  };
}

function countingTool(): Plugin {
  const tool: Tool = {
    name: "count",
    description: "counts one execution",
    inputSchema: { type: "object" },
    async execute(): Promise<string> {
      journal({ kind: "tool-execution" });
      return "counted";
    },
  };
  return {
    manifest: { id: "counter", name: "Counter", version: "1.0.0", permissions: [] },
    activate: (context): void => {
      context.tools.register(tool);
    },
  };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/**
 * The M4 phase: a run parked on a pending approval.
 *
 * No SQL boundary is armed — the interesting fact is not a transaction but
 * what a kill leaves *without* one: the approval is memory the dying process
 * held, the run is unfinished in the store, and nothing in the file may claim
 * otherwise. The tool must never have run, which is what the journal shows.
 */
async function approvalPhase(): Promise<boolean> {
  return phase === "approval-pending";
}

async function main(): Promise<void> {
  const parked = await approvalPhase();
  if (!parked) armBoundary();

  const policy: ToolPolicy | undefined = parked
    ? {
        revision: 1,
        decide: () => "require-approval",
      }
    : undefined;

  const channel = channelPair();
  const host = await createHost({
    bootstrap: TEST_BOOTSTRAP,
    composition: testComposition({
      modelClient: crashModel(),
      ...(policy === undefined ? {} : { toolPolicy: policy }),
    }),
    plugins: [countingTool()],
    persistence: { kind: "sqlite", location: databasePath },
  });
  host.attach(channel.hostSide);

  // `reconcile-mid` pauses inside the host's own startup, before a client can
  // exist; for every other phase the manifest is what the parent needs.
  const client = createClient({ connect: async () => channel.clientSide });
  await client.connect();

  await client.plugins.enable({ pluginId: "counter" });
  const session = (await client.sessions.create()).session;
  // What the parent needs to ask about this session after the kill. It is
  // written before the run starts, so even a kill at the admission boundary
  // leaves it behind.
  writeFileSync(MANIFEST_PATH, JSON.stringify({ phase, sessionId: session.sessionId, submissionId: SUBMISSION_ID }));
  journal({ kind: "session-created", sessionId: session.sessionId });

  await client.runs.start({ sessionId: session.sessionId, submissionId: SUBMISSION_ID, text: "hello" });

  if (parked) {
    // The host holds the approval in memory and waits. The parent kills the
    // process from here: no transaction boundary is involved, and the journal's
    // lack of a `tool-execution` entry is what proves nothing ran.
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if (client.getSnapshot().presentation?.approval !== null) {
        journal({ kind: "approval-pending" });
        park("approval-pending");
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    process.stderr.write("the approval never became pending\n");
    process.exit(6);
  }

  // The run is executing; the boundary (armed below the repository) is what
  // ends this process. Parking on a timer keeps it alive until the parent's
  // kill lands — and if the boundary never fires, the suite reports a setup
  // failure instead of counting a silent process exit as a crash.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 30_000);
  });
  process.stderr.write(`phase ${phase} ran to completion without reaching its boundary\n`);
  process.exit(5);
}

void main().catch((error: unknown) => {
  process.stderr.write(`child failed: ${String(error)}\n`);
  process.exit(1);
});
