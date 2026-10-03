/**
 * Repair Batch 1.3 — the contract errata's own regressions (E1, E3, E4).
 *
 * E1: a storage fault is a boundary, not an episode. The host that enters it
 * stops answering every current-state question — new connections included —
 * until a restart reconciles the durable facts; immutable canonical stays
 * readable, and nothing durable is invented.
 *
 * E3: `sessions.history`'s `limit` is a hard maximum, and a page is a legal
 * fragment of a traversal — it may carry one half of a tool occurrence whose
 * other half is on the next page. The execution window keeps requiring whole
 * turns; only the page is allowed to be a cut.
 *
 * E4: a request id is at most `MAX_REQUEST_ID_BYTES` UTF-8 bytes in every
 * envelope position. A legal id is echoed verbatim; an over-long one is not a
 * correlation at all, so the frame is a connection fault, not a response
 * signed with an identity the protocol does not accept.
 *
 * Everything runs against the real host, the real SQLite store and the real
 * protocol encoder; fault injections disarm themselves before assertions run.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { MAX_FRAME_BYTES, MAX_REQUEST_ID_BYTES } from "@every-dagent/protocol";

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
  toolReply,
  type TestClient,
} from "./helpers/harness.js";
import type { ComposedHost } from "../src/host.js";

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-repair-13-"));
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
 * One durable host with two committed turns in one session: the first carries
 * a tool occurrence, the second carries text that escapes to more bytes than
 * it looks like.
 */
async function runTwoTurns(
  location?: string,
): Promise<{ readonly composed: ComposedHost; readonly client: TestClient; readonly sessionId: string }> {
  const composed = await composeTestHost({
    modelClient: scriptedModel(
      [
        toolReply("c-1", "observer", { n: 1 }),
        textReply("with a tool"),
        textReply("héllo 🙂\u0000\" tail"),
        textReply("unused"),
      ],
      { repeatLast: true },
    ).client,
    plugins: [testPlugin({ id: "tools", tools: [constantTool("observer")] })],
    ...(location === undefined ? {} : { location }),
  });
  const client = connect(composed.host);
  await client.describe();
  await client.call("plugins.enable", { pluginId: "tools" });
  const session = await createSessionThrough(client);
  for (const text of ["use it", "and again"]) {
    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: `sub-${text}`,
      text,
    });
    const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
    expect(terminal.status).toBe("completed");
  }
  return { composed, client, sessionId: session.sessionId };
}

// ---------------------------------------------------------------------------
// E1 — the fault boundary holds for every connection that comes after it.
// ---------------------------------------------------------------------------

describe("E1 storage fault boundary", () => {
  it("refuses current-state answers on a faulted host, keeps canonical readable, and invents nothing", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "fault.db");
      const composed = await composeTestHost({
        modelClient: scriptedModel([textReply("first answer"), textReply("second answer")]).client,
        location: path,
      });
      const client = connect(composed.host);
      await client.describe();
      await client.call("subscriptions.open", {});
      const session = await createSessionThrough(client);

      // One committed turn: immutable canonical a faulted host may still serve.
      const first = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: "sub-1",
        text: "one",
      });
      const firstRunId = first.result?.run.runId as string;
      const firstTerminal = await awaitRunTerminal(client, firstRunId);
      expect(firstTerminal.status).toBe("completed");

      // A second run whose terminal outcome can never be confirmed.
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

      // The connected client is invalidated, and nothing was published for the
      // run the host cannot vouch for (the first run's own terminal was, and
      // stays, published).
      expect(client.isClosed).toBe(true);
      expect(
        client.events.filter((event) => event.type === "run.ended" && event.payload.run.runId === runId),
      ).toHaveLength(0);

      // A brand-new connection: the identity is still true, and nothing about
      // current state is. This is the residual E1 closed the door on — a new
      // bootstrap into a "healthy current" presentation out of a faulted host.
      const fresh = connect(composed.host);
      const described = await fresh.describe();
      expect(described.error).toBeUndefined();

      const opened = await fresh.call("subscriptions.open", {});
      expect(opened.error?.code).toBe("STORAGE_UNAVAILABLE");
      const listed = await fresh.call("sessions.list", {});
      expect(listed.error?.code).toBe("STORAGE_UNAVAILABLE");
      const got = await fresh.call("sessions.get", { sessionId: session.sessionId });
      expect(got.error?.code).toBe("STORAGE_UNAVAILABLE");
      const run = await fresh.call("runs.get", { runId });
      expect(run.error?.code).toBe("STORAGE_UNAVAILABLE");
      const runs = await fresh.call("runs.list", { sessionId: session.sessionId });
      expect(runs.error?.code).toBe("STORAGE_UNAVAILABLE");

      // Immutable canonical is not current state: the committed turn is still
      // served, as the store's own facts.
      const page = await fresh.call("sessions.history", { sessionId: session.sessionId, limit: 5 });
      expect(page.error).toBeUndefined();
      expect(page.result?.page.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
      // The host's own catalogue is not store state either.
      const plugins = await fresh.call("plugins.list", {});
      expect(plugins.error).toBeUndefined();

      // No new execution, and no fabricated terminal: the durable record is
      // still the unfinished run.
      const started = await fresh.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: "sub-3",
        text: "three",
      });
      expect(started.error?.code).toBe("STORAGE_UNAVAILABLE");
      expect(composed.repository.getRun(runId)?.status).toBe("running");
      expect(composed.repository.getRun(runId)?.turnId).toBeNull();

      fresh.detach();
      client.detach();
      await composed.host.shutdown();

      // The restart is the only reconciliation: unfinished becomes interrupted
      // with its evidence class, and the committed run keeps its fact.
      const restarted = await composeTestHost({
        modelClient: scriptedModel([textReply("unused")]).client,
        location: path,
      });
      const reader = connect(restarted.host);
      await reader.describe();
      const after = await reader.call("runs.get", { runId });
      expect(after.result?.run.status).toBe("interrupted");
      expect(after.result?.run.executionKnowledge).toBe("unknown");
      expect(restarted.repository.getSession(session.sessionId)?.status).toBe("blocked");
      const kept = await reader.call("runs.get", { runId: firstRunId });
      expect(kept.result?.run.status).toBe("completed");

      reader.detach();
      await restarted.host.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// E3 — a page is a hard limit and a legal fragment; a window is neither.
// ---------------------------------------------------------------------------

describe("E3 history pages", () => {
  it("serves a traversal in hard-limited fragments, and every item exactly once", async () => {
    const { composed, client, sessionId } = await runTwoTurns();

    const traversal = async (
      limit: number | undefined,
    ): Promise<{ readonly items: { kind: string; seq: number }[]; readonly pages: number; readonly pagesWith: string[][] }> => {
      const items: { kind: string; seq: number }[] = [];
      const pagesWith: string[][] = [];
      let cursor: string | undefined;
      let previousFrom: number | undefined;
      let pages = 0;
      for (;;) {
        const requestId = `history-${pages}-${limit ?? "default"}`;
        const answer = await client.call(
          "sessions.history",
          { sessionId, ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) },
          { requestId },
        );
        expect(answer.error).toBeUndefined();
        const page = answer.result?.page;
        if (page === undefined) throw new Error("the page was not served");
        pages += 1;

        // The hard maximum, and the page's own frame staying inside the wire
        // bound: a small limit is not a licence to over-return, and a heavily
        // escaped item is not a licence to exceed the frame.
        if (limit !== undefined) expect(page.items.length).toBeLessThanOrEqual(limit);
        const frame = client.frames.find(
          (candidate) => (JSON.parse(candidate) as { requestId?: string }).requestId === requestId,
        ) as string;
        expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);

        // Coverage tiles the traversal: the older page starts exactly where
        // the newer one stopped.
        if (previousFrom !== undefined) expect(page.coverage.toSeq).toBe(previousFrom);
        previousFrom = page.coverage.fromSeq;

        items.unshift(...page.items.map((item) => ({ kind: item.kind, seq: item.seq })));
        pagesWith.push(page.items.map((item) => item.kind));
        if (page.nextCursor === null) {
          expect(page.atStart).toBe(true);
          break;
        }
        cursor = page.nextCursor;
        if (pages > 40) throw new Error("the traversal did not end");
      }
      return { items, pages, pagesWith };
    };

    // One item per page: the tool turn necessarily splits between its call and
    // its result, and both halves are served as the fragments they are.
    const one = await traversal(1);
    expect(one.items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool-call",
      "tool-result",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(one.pagesWith.some((kinds) => kinds.length === 1 && kinds[0] === "tool-call")).toBe(true);
    expect(one.pagesWith.some((kinds) => kinds.length === 1 && kinds[0] === "tool-result")).toBe(true);

    // A wider page returns more per page, never a different set of items.
    const two = await traversal(2);
    expect(two.items).toEqual(one.items);
    expect(two.pages).toBeLessThan(one.pages);

    // Reading a fragment is not corruption: the session stayed ready and can
    // execute again.
    expect(composed.repository.getSession(sessionId)?.status).toBe("ready");
    const again = await client.call("runs.start", { sessionId, submissionId: "sub-after-pages", text: "once more" });
    expect(again.error).toBeUndefined();
    const terminal = await awaitRunTerminal(client, again.result?.run.runId as string);
    expect(terminal.status).toBe("completed");

    client.detach();
    await composed.host.shutdown();
  });

  it("keeps the execution window on provable whole turns: a page's fragment licence does not reach it", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "window.db");
      const seeded = await runTwoTurns(path);
      seeded.client.detach();
      await seeded.composed.host.shutdown();

      // The damage: the committed turns lose their owning runs entirely. No
      // run read can notice it first — there is nothing left to read — so the
      // damage is found exactly where it matters: loading the history a new
      // run would execute against. A history page is a fragment of the log
      // and may be cut mid-turn; a window is the history a model is handed,
      // and this one cannot be proven to be whole turns someone committed.
      const database = new DatabaseSync(path);
      database.prepare("DELETE FROM runs WHERE session_id = ?").run(seeded.sessionId);
      database.close();

      const model = scriptedModel([textReply("later")]);
      const composed = await composeTestHost({ modelClient: model.client, location: path });
      const client = connect(composed.host);
      await client.describe();
      // Nothing was read from the session first, so nothing has been refused:
      // the window load is the first place the damage is found.
      expect(composed.repository.getSession(seeded.sessionId)?.status).toBe("ready");

      const started = await client.call("runs.start", {
        sessionId: seeded.sessionId,
        submissionId: "sub-window",
        text: "continue",
      });
      expect(started.error).toBeUndefined();
      const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);
      expect(terminal.status).toBe("failed");
      expect(terminal.endReason).toBe("host_error");
      // The model was never asked anything: the window it would have been
      // handed could not be proven.
      expect(model.requests).toHaveLength(0);
      expect(composed.repository.getSession(seeded.sessionId)?.status).toBe("blocked");

      client.detach();
      await composed.host.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// E4 — the request-id bound at the wire edge.
// ---------------------------------------------------------------------------

describe("E4 request-id bound", () => {
  const LEGAL: readonly { readonly id: string; readonly what: string }[] = [
    { id: "a".repeat(MAX_REQUEST_ID_BYTES - 1), what: "127 bytes" },
    { id: "a".repeat(MAX_REQUEST_ID_BYTES), what: "128 bytes" },
    { id: "中".repeat(42), what: "42 three-byte characters (126 bytes)" },
    { id: "🙂".repeat(32), what: "32 four-byte characters (128 bytes)" },
    { id: "\u0000".repeat(MAX_REQUEST_ID_BYTES), what: "the worst-case NUL id" },
  ];

  it("echoes every legal id byte for byte", async () => {
    const composed = await composeTestHost({ modelClient: scriptedModel([textReply("ok")], { repeatLast: true }).client });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await createSessionThrough(client);

    for (const { id, what } of LEGAL) {
      const answer = await client.call("sessions.list", {}, { requestId: id });
      expect(answer.error, what).toBeUndefined();
      const frame = client.frames.find(
        (candidate) => (JSON.parse(candidate) as { requestId?: string }).requestId === id,
      );
      expect(frame, what).toBeDefined();
      expect((JSON.parse(frame as string) as { requestId?: string }).requestId, what).toBe(id);
    }

    client.detach();
    await composed.host.shutdown();
  });

  it("treats one byte past the bound as a connection fault, never an answered request", async () => {
    const composed = await composeTestHost({ modelClient: scriptedModel([textReply("ok")], { repeatLast: true }).client });
    const client = connect(composed.host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const instance = client.hostInstanceId as string;

    // Over the bound in *bytes*, not in characters: 43 three-byte characters
    // are 129 bytes, and the id is refused for that reason.
    const over = "中".repeat(43);
    expect(Buffer.byteLength(over, "utf8")).toBe(MAX_REQUEST_ID_BYTES + 1);
    const framesBefore = client.frames.length;
    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "2",
        requestId: over,
        method: "sessions.list",
        params: {},
        hostInstanceId: instance,
      }),
    );
    await flush();

    // No response carries the illegal id — the association itself is refused —
    // and the connection it arrived on is over.
    expect(client.isClosed).toBe(true);
    expect(client.frames.length).toBe(framesBefore);
    expect(
      client.frames.filter((frame) => (JSON.parse(frame) as { requestId?: string }).requestId === over),
    ).toHaveLength(0);

    client.detach();
    await composed.host.shutdown();
  });

  it("refuses an over-long id with no business side effect at all", async () => {
    const composed = await composeTestHost({
      modelClient: scriptedModel([textReply("ok")], { repeatLast: true }).client,
    });
    const client = connect(composed.host);
    await client.describe();
    const instance = client.hostInstanceId as string;

    // A create-shaped frame whose id is illegal: nothing may be created, and
    // nothing may be answered.
    const sessionsBefore = composed.repository.listSessions(50, null).records.length;
    const over = "x".repeat(MAX_REQUEST_ID_BYTES + 1);
    client.sendRaw(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "2",
        requestId: over,
        method: "sessions.create",
        params: {},
        hostInstanceId: instance,
      }),
    );
    await flush();
    expect(client.isClosed).toBe(true);
    expect(composed.repository.listSessions(50, null).records.length).toBe(sessionsBefore);

    client.detach();
    await composed.host.shutdown();
  });
});
