/**
 * Repair Batch 1.2 — the four findings the targeted re-review left open: R02,
 * R04, R05 and R28.
 *
 * Everything here runs against the real host, the real SQLite store and the
 * real protocol encoder. Fault injections sit at the API the failure really
 * happens at and disarm themselves, so a test that asserts afterwards is
 * asserting about a healthy store.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { Tool } from "@every-dagent/agent-core";
import type { Plugin } from "@every-dagent/plugin-system";
import type { HostSnapshot } from "@every-dagent/protocol";
import { MAX_FRAME_BYTES, MAX_REQUEST_ID_BYTES, PROTOCOL_VERSION, encodeFrame } from "@every-dagent/protocol";

import { composeHost, type ComposedHost } from "../src/host.js";
import { heaviestAcceptedText } from "../src/repository.js";
import {
  PREPARED_REQUEST_ID,
  snapshotFrameFits,
  snapshotOfHeaviestState,
  snapshotOfProspectiveRun,
} from "../src/state.js";
import type { HostState } from "../src/state.js";
import {
  awaitRunTerminal,
  composeTestHost,
  connect,
  constantTool,
  createSessionThrough,
  flush,
  gate,
  gatedReply,
  nextId,
  recordingTool,
  scriptedModel,
  testPlugin,
  textReply,
  toolReply,
} from "./helpers/harness.js";

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-repair-12-"));
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

/** The exact bytes one frame occupies on the wire. */
function frameBytes(frame: string): number {
  return Buffer.byteLength(frame, "utf8");
}

/**
 * The frame a subscriber would be sent for `snapshot`, through the protocol's
 * own encoder — the very call the host makes to decide whether a frame fits.
 */
function frameBytesOf(state: HostState, snapshot: HostSnapshot, requestId: string): number {
  const encoded = encodeFrame(
    { kind: "host-response", method: "subscriptions.open" },
    {
      kind: "host-response",
      protocolVersion: PROTOCOL_VERSION,
      hostInstanceId: state.hostInstanceId,
      requestId,
      result: { snapshot },
    },
  );
  if (!encoded.success) throw new Error("the fixture could not encode the frame it measured");
  return frameBytes(encoded.output);
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
// R04 — a call is owned from its descriptors, before anything is read.
// ---------------------------------------------------------------------------

/** One tool whose execution count is visible, registered for the guard tests. */
function countingTool(executions: { value: number }): Tool {
  return {
    name: "observer",
    description: "The observer tool.",
    inputSchema: { type: "object" },
    execute: async (): Promise<string> => {
      executions.value += 1;
      return "ran";
    },
  };
}

describe("R04 hostile tool-call slots", () => {
  /** One call with an accessor where a business field belongs. */
  function arm(slot: "input" | "callId" | "name"): { readonly reads: () => number; readonly call: unknown } {
    let reads = 0;
    const secret = (): unknown => {
      reads += 1;
      return slot === "input" ? { n: 1 } : "value";
    };
    const call: Record<string, unknown> = { callId: "call-1", name: "observer", input: { n: 1 } };
    delete call[slot];
    Object.defineProperty(call, slot, { enumerable: true, configurable: true, get: secret });
    return { reads: () => reads, call };
  }

  it.each(["input", "callId", "name"] as const)(
    "refuses a %s accessor without running it, and dispatches nothing",
    async (slot) => {
      const armed = arm(slot);
      const executions = { value: 0 };

      // The hostile step is the first reply; the Core's own contract retries a
      // failed attempt, and the retry answers cleanly — so the run completes
      // and the canonical history can be asked what it holds.
      const hostile = async function* (): AsyncGenerator<never> {
        yield { type: "tool-call", call: armed.call } as never;
        yield { type: "done" } as never;
      };

      const composed = await composeTestHost({
        modelClient: scriptedModel([hostile, textReply("clean answer")]).client,
        plugins: [testPlugin({ id: "tools", tools: [countingTool(executions)] })],
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

      // The accessor was never executed to decide anything, the tool never ran,
      // and no call it could have carried exists in the canonical history.
      expect(armed.reads()).toBe(0);
      expect(executions.value).toBe(0);
      const page = await client.call("sessions.history", { sessionId: session.sessionId });
      expect(page.result?.page.items.some((item) => item.kind === "tool-call")).toBe(false);
      expect(page.result?.page.items.some((item) => item.kind === "tool-result")).toBe(false);
      expect(
        page.result?.page.items.some((item) => item.kind === "assistant" && item.text === "clean answer"),
      ).toBe(true);

      client.detach();
      await composed.host.shutdown();
    },
  );

  it("refuses a nested accessor inside an input without reading it", async () => {
    let reads = 0;
    const executions = { value: 0 };
    const input: Record<string, unknown> = { ok: true };
    Object.defineProperty(input, "hidden", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return "never";
      },
    });

    const composed = await composeTestHost({
      modelClient: scriptedModel([toolReply("call-1", "observer", input), textReply("clean answer")]).client,
      plugins: [testPlugin({ id: "tools", tools: [countingTool(executions)] })],
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
    expect(reads).toBe(0);
    expect(executions.value).toBe(0);

    client.detach();
    await composed.host.shutdown();
  });

  it("owns a plain call as a deep snapshot, and runs its tool once", async () => {
    const seen: unknown[] = [];
    const composed = await composeTestHost({
      modelClient: scriptedModel([toolReply("call-1", "observer", { n: 1 }), textReply("done")]).client,
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
    expect(seen).toEqual([{ n: 1 }]);

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R05 4.4 — a legal fragment is not corruption.
// ---------------------------------------------------------------------------

describe("R05 legal history fragments", () => {
  it("walks a real tool turn one item at a time without calling it corruption", async () => {
    const seen: unknown[] = [];
    const composed = await composeTestHost({
      modelClient: scriptedModel([toolReply("call-1", "observer", { n: 1 }), textReply("finished")], {
        repeatLast: true,
      }).client,
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
    expect(seen).toHaveLength(1);

    // Walk the whole history one item per page. Pages arrive newest-first and
    // carry their own items in log order, so the pages are reversed at the end.
    const pages: { kind: string; seq: number }[][] = [];
    let cursor: string | undefined;
    for (;;) {
      const answer = await client.call("sessions.history", {
        sessionId: session.sessionId,
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(answer.error).toBeUndefined();
      const page = answer.result?.page;
      if (page === undefined) throw new Error("the page was not served");
      pages.push(page.items.map((item) => ({ kind: item.kind, seq: item.seq })));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      if (pages.length > 40) throw new Error("the traversal did not end");
    }
    const items = pages.reverse().flat();

    // The whole turn, once, in order — and the session never stopped being ready.
    expect(items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool-call",
      "tool-result",
      "assistant",
    ]);
    expect(composed.repository.getSession(session.sessionId)?.status).toBe("ready");

    // And it can still execute: a blocked session would refuse this.
    const again = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: nextId("sub"),
      text: "once more",
    });
    expect(again.error).toBeUndefined();
    const second = await awaitRunTerminal(client, again.result?.run.runId as string);
    expect(second.status).toBe("completed");

    client.detach();
    await composed.host.shutdown();
  });
});

// ---------------------------------------------------------------------------
// R05 4.1 / 4.2 / 4.3 — one validation authority over every public path.
// ---------------------------------------------------------------------------

describe("R05 terminal run authority", () => {
  /** Two runs really finished, one after the other, in one session. */
  async function twoRealRuns(path: string): Promise<{ sessionId: string; first: string; second: string }> {
    const composed = await composeTestHost({
      modelClient: scriptedModel([
        toolReply("c-1", "observer", { n: 1 }),
        textReply("one"),
        toolReply("c-2", "observer", { n: 2 }),
        textReply("two"),
      ]).client,
      plugins: [testPlugin({ id: "tools", tools: [constantTool("observer")] })],
      location: path,
    });
    const client = connect(composed.host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);
    const one = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "sub-first",
      text: "first",
    });
    const first = one.result?.run.runId as string;
    await awaitRunTerminal(client, first);
    const two = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "sub-second",
      text: "second",
    });
    const second = two.result?.run.runId as string;
    await awaitRunTerminal(client, second);
    client.detach();
    await composed.host.shutdown();
    return { sessionId: session.sessionId, first, second };
  }

  it("refuses a run that claims another run's committed turn, on every public path", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "ownership.db");
      const { sessionId, first, second } = await twoRealRuns(path);

      // The damage: the first run is rewritten to claim the second run's turn.
      // The turn exists, its range matches it, its reason matches and the
      // session's high-water covers it — everything a range check can see.
      // What it is not is *its* turn, and two terminals claiming one committed
      // turn is a state the store's own writes cannot produce.
      const database = new DatabaseSync(path);
      const owner = database
        .prepare("SELECT turn_id, committed_from_seq, committed_to_seq FROM runs WHERE run_id = ?")
        .get(second) as {
        readonly turn_id?: string;
        readonly committed_from_seq?: number;
        readonly committed_to_seq?: number;
      };
      database
        .prepare("UPDATE runs SET turn_id = ?, committed_from_seq = ?, committed_to_seq = ? WHERE run_id = ?")
        .run(owner.turn_id as string, owner.committed_from_seq as number, owner.committed_to_seq as number, first);
      database.close();

      const composed = await composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();

      // Every public read refuses the damaged run.
      const got = await client.call("runs.get", { runId: first });
      expect(got.error?.code).toBe("INTERNAL_ERROR");
      expect(composed.repository.getSession(sessionId)?.status).toBe("blocked");

      const listed = await client.call("runs.list", { sessionId });
      expect(listed.error?.code).toBe("INTERNAL_ERROR");

      // The block is one session's, not the host's.
      const other = await client.call("sessions.create", {});
      const otherSession = other.result?.session.sessionId as string;
      const started = await client.call("runs.start", {
        sessionId: otherSession,
        submissionId: nextId("sub"),
        text: "unaffected",
      });
      expect(started.error).toBeUndefined();

      // A fresh host sees the same damaged record and refuses it the same way
      // on the paths that do not need a live run: the dedup answer, cancel, and
      // the published cut.
      client.detach();
      await composed.host.shutdown();

      const again = await composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const reader = connect(again.host);
      await reader.describe();

      const dedup = await reader.call("runs.start", { sessionId, submissionId: "sub-first", text: "first" });
      expect(dedup.error?.code).toBe("INTERNAL_ERROR");

      const cancelled = await reader.call("runs.cancel", { runId: first });
      expect(cancelled.error?.code).toBe("INTERNAL_ERROR");

      const cut = await reader.call("subscriptions.open", {});
      expect(cut.error).toBeUndefined();
      const snapshot = cut.result?.snapshot;
      // Never projected as a normal completed run...
      expect(snapshot?.runs.items.some((run) => run.runId === first)).toBe(false);
      // ...its session is in the cut as blocked, and the healthy one still is.
      expect(snapshot?.sessions.items.find((session) => session.sessionId === sessionId)?.status).toBe("blocked");
      expect(snapshot?.sessions.items.some((session) => session.sessionId === otherSession)).toBe(true);

      reader.detach();
      await again.host.shutdown();
    });
  });

  it("refuses a terminal whose own committed range is not canonical, on a run read", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "declaration.db");
      const { sessionId, second } = await twoRealRuns(path);

      // The second run's own assistant declaration names a different call than
      // the one recorded. The page path already refuses that pairing; the run's
      // own range check refuses it too, because it is the same records held to
      // the same rules.
      const database = new DatabaseSync(path);
      const range = database
        .prepare("SELECT committed_from_seq, committed_to_seq FROM runs WHERE run_id = ?")
        .get(second) as { readonly committed_from_seq?: number; readonly committed_to_seq?: number };
      database
        .prepare(
          `UPDATE session_events SET data = json_set(data, '$.toolCalls[0].callId', 'WRONG')
           WHERE type = 'message/assistant' AND seq >= ? AND seq < ?
             AND json_array_length(json_extract(data, '$.toolCalls')) > 0`,
        )
        .run(range.committed_from_seq as number, range.committed_to_seq as number);
      database.close();

      const composed = await composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path });
      const client = connect(composed.host);
      await client.describe();
      const got = await client.call("runs.get", { runId: second });
      expect(got.error?.code).toBe("INTERNAL_ERROR");
      expect(composed.repository.getSession(sessionId)?.status).toBe("blocked");

      client.detach();
      await composed.host.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// E4 / R28 — the request-id bound, and one frame authority over it.
// ---------------------------------------------------------------------------

describe("E4 request-id reservation and one frame authority", () => {
  /** A plugin whose static summary carries `bytes` of description. */
  function bigPlugin(bytes: number): Plugin {
    return {
      manifest: { id: "big", name: "Big", version: "1.0.0", description: "d".repeat(bytes) },
      activate: (): void => undefined,
    };
  }

  /** A host at one static configuration, with its live state observed. */
  async function hostAt(
    bytes: number,
    model = scriptedModel([textReply("ok")], { repeatLast: true }),
  ): Promise<{
    readonly composed: ComposedHost;
    readonly state: HostState;
    readonly model: ReturnType<typeof scriptedModel>;
  }> {
    let state: HostState | undefined;
    const composed = await composeTestHost(
      { modelClient: model.client, plugins: [bigPlugin(bytes)] },
      {
        onState: (observed) => {
          state = observed;
        },
      },
    );
    if (state === undefined) throw new Error("the composition did not expose its state");
    return { composed, state, model };
  }

  /** The boundary configuration: heaviest legal state exactly at the limit, with the reservation. */
  async function boundaryAt(base: number): Promise<number> {
    const measured = await hostAt(base);
    const baseSnapshot = snapshotOfHeaviestState(measured.state, "prepare:stream");
    const baseBytes = frameBytesOf(measured.state, baseSnapshot, PREPARED_REQUEST_ID);
    expect(snapshotFrameFits(measured.state, baseSnapshot)).toBe(true);
    const atLimit = base + (MAX_FRAME_BYTES - baseBytes);
    await measured.composed.host.shutdown();
    return atLimit;
  }

  /** One legal request id of each shape the bound allows. */
  function legalIds(): readonly { readonly id: string; readonly what: string }[] {
    return [
      { id: "00000000-0000-4000-8000-000000000000", what: "a 36 B UUID" },
      { id: "a".repeat(MAX_REQUEST_ID_BYTES), what: "128 B of ASCII" },
      { id: "中".repeat(Math.floor(MAX_REQUEST_ID_BYTES / 3)), what: "128 B of multibyte text" },
      { id: PREPARED_REQUEST_ID, what: "the worst-case NUL id" },
    ];
  }

  it("reserves the worst legal request id, and refuses a configuration that would not carry it", async () => {
    // The reservation really is the worst case: a full identity's worth of
    // NUL costs six JSON bytes each, so its string token is 2 + 6 * 128.
    const token = Buffer.byteLength(JSON.stringify(PREPARED_REQUEST_ID), "utf8");
    expect(token).toBe(2 + 6 * MAX_REQUEST_ID_BYTES);
    expect(Buffer.byteLength(PREPARED_REQUEST_ID, "utf8")).toBe(MAX_REQUEST_ID_BYTES);

    const atLimit = await boundaryAt(96 * 1024);

    // Startup: the heaviest state a legal run can force measures exactly the
    // limit *with the reservation*, and one configuration byte more is
    // refused — this host will not exist if the only ids it could serve are
    // the short ones.
    const startup = await hostAt(atLimit);
    const heaviest = snapshotOfHeaviestState(startup.state, "prepare:stream");
    expect(frameBytesOf(startup.state, heaviest, PREPARED_REQUEST_ID)).toBe(MAX_FRAME_BYTES);
    await expect(hostAt(atLimit + 1)).rejects.toThrow(/frame|room/i);

    // And under that reservation every legal request id fits, measured one at
    // a time through the encoder: the 36 B placeholder this used to reserve
    // could accept a state that a real long id then failed to carry, and that
    // counterexample is what the reservation removes.
    for (const { id, what } of legalIds()) {
      expect(snapshotFrameFits(startup.state, heaviest, id), what).toBe(true);
      expect(frameBytesOf(startup.state, heaviest, id), what).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    }
    // One raw byte past the bound is not a request id at all: the schema
    // refuses it, so there is no frame for it to travel in.
    expect(snapshotFrameFits(startup.state, heaviest, "a".repeat(MAX_REQUEST_ID_BYTES + 1))).toBe(false);

    await startup.composed.host.shutdown();
  });

  it("serves a prospective-accepted state to every legal request id, at the boundary", async () => {
    // The run is held inside its model call, so the state being measured stays
    // the state being served, and the admission is sized with the same
    // reserved request id the host's own check uses — exactly at the boundary
    // the prospective check accepts.
    const atLimit = await boundaryAt(96 * 1024);
    const hold = gate();
    const model = scriptedModel([gatedReply(hold, textReply("late"))], { repeatLast: true });
    const admitting = await hostAt(atLimit, model);
    const client = connect(admitting.composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);
    const record = admitting.composed.repository.getSession(session.sessionId);
    if (record === undefined) throw new Error("the session was not created");

    // The run id is measured at the shape the host really mints (a 36 B
    // UUID); the submission id is the part a caller sizes, and it is what
    // moves the prospective frame to the boundary the check accepts.
    const text = heaviestAcceptedText(64 * 1024);
    const prospective = snapshotOfProspectiveRun(admitting.state, "prepare:stream", record, {
      runId: "00000000-0000-4000-8000-000000000000",
      submissionId: "s",
      text,
      acceptedAt: 1_800_000_000_000,
    });
    const prospectiveBytes = frameBytesOf(admitting.state, prospective, PREPARED_REQUEST_ID);
    const pad = MAX_FRAME_BYTES - prospectiveBytes;
    expect(pad).toBeGreaterThan(0);

    const admitted = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "s".repeat(1 + pad),
      text,
    });
    expect(admitted.error).toBeUndefined();
    const runId = admitted.result?.run.runId as string;
    await until(
      () => client.events.some((event) => event.type === "run.updated" && event.payload.run.status === "running"),
      "the run to start",
    );

    // The cut the host now really sends, captured and measured for each legal
    // id shape. Nothing here is a second budget: each frame is the one the
    // client received, and the reservation's own frame is the largest of the
    // four — the reason the prospective check bounds them all.
    const served: { readonly what: string; readonly bytes: number }[] = [];
    for (const { id, what } of legalIds()) {
      const opened = await client.call("subscriptions.open", {}, { requestId: id });
      expect(opened.error, what).toBeUndefined();
      const frame = client.frames[client.frames.length - 1] as string;
      const bytes = frameBytes(frame);
      expect(bytes, what).toBeLessThanOrEqual(MAX_FRAME_BYTES);
      served.push({ what, bytes });
    }
    const worst = served[served.length - 1];
    expect(worst?.what).toBe("the worst-case NUL id");
    for (const entry of served) {
      expect(entry.bytes, entry.what).toBeLessThanOrEqual(worst?.bytes ?? 0);
    }

    // None of this disturbed the execution: it is still running, and settling
    // it after the gate opens leaves the same completed facts.
    const live = await client.call("runs.get", { runId });
    expect(live.result?.run.status).toBe("running");
    hold.open();
    const terminal = await awaitRunTerminal(client, runId);
    expect(terminal.status).toBe("completed");

    client.detach();
    await admitting.composed.host.shutdown();
  });
});
