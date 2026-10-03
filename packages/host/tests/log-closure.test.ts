/**
 * What a settled log has to look like before it becomes history.
 *
 * The sessions here are real — same `Session`, same Core, same loop — with one
 * seam: `events()` can hand back a corrupted view of the log. That is the only
 * way to produce a session whose record is wrong but whose turn really ran,
 * which is exactly what the host's closure check exists for.
 *
 * The positive fixtures matter as much as the negative ones: a pre-cancelled
 * turn, a Core error, a mid-turn cancel and a spent step budget all close
 * without some records a naive check would demand, and all of them are history
 * the Core really wrote.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Session,
  SessionEvent,
  SessionEventInput,
  SessionWindow,
} from "@every-dagent/agent-core";
import type { CanonicalItem } from "@every-dagent/protocol";
import { MAX_PAGE_ITEMS } from "@every-dagent/protocol";

import type { TestClient } from "./helpers/harness.js";

const control = vi.hoisted(() => ({
  /** Drop this event type from the log entirely. */
  dropType: undefined as string | undefined,
  /** Rewrite each stored event as the log is read back. */
  rewrite: undefined as undefined | ((event: SessionEvent, index: number) => SessionEvent),
}));

vi.mock("@every-dagent/agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@every-dagent/agent-core")>();
  return {
    ...actual,
    // A run records into, and is judged against, the window of committed
    // history the host restores from storage: corrupting that window's view of
    // the log is exactly the seam this file needs.
    restoreSessionWindow: (id: string, window: SessionWindow): Session =>
      corruptWindow(actual.restoreSessionWindow(id, window)),
  };
});

/** The same session, with its log handed back the way the test wants it read. */
function corruptWindow(session: Session): Session {
  return {
    id: session.id,
    append: (event: SessionEventInput): SessionEvent => {
      if (control.dropType === event.type) {
        // Never written, never refused: the record simply does not exist.
        return { ...event, seq: 0, time: Date.now() } as unknown as SessionEvent;
      }
      return session.append(event);
    },
    events: () => {
      const events = session.events();
      const rewrite = control.rewrite;
      return rewrite === undefined ? events : events.map((event, index) => rewrite(event, index));
    },
    deriveMessages: () => session.deriveMessages(),
  };
}

const { awaitRunTerminal, connect, createSessionThrough, gate, nextId, scriptedModel, testHost, testPlugin, textReply, toolReply } =
  await import("./helpers/harness.js");

beforeEach(() => {
  control.dropType = undefined;
  control.rewrite = undefined;
});

/**
 * One session's committed conversation, as one list.
 *
 * v2 keeps history out of the session summary and hands it out in bounded
 * pages, so reading "the whole conversation" is a traversal: each page is the
 * newest window not read yet, in log order, and the pages that follow are
 * older — so a later page is placed in front of what is already collected.
 * The largest legal page is asked for, so a conversation this size costs one
 * round trip; the traversal still follows whatever cursor comes back.
 */
async function conversation(client: TestClient, sessionId: string): Promise<readonly CanonicalItem[]> {
  const items: CanonicalItem[] = [];
  let cursor: string | undefined;

  for (;;) {
    const response = await client.call(
      "sessions.history",
      cursor === undefined ? { sessionId, limit: MAX_PAGE_ITEMS } : { sessionId, limit: MAX_PAGE_ITEMS, cursor },
    );
    if (response.result === undefined) {
      throw new Error(`sessions.history failed: ${response.error.code}`);
    }

    const page = response.result.page;
    items.unshift(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
}

async function runAndInspect(options: {
  readonly replies: Parameters<typeof scriptedModel>[0];
  readonly tools?: Parameters<typeof testPlugin>[0]["tools"];
  readonly before?: (client: Awaited<ReturnType<typeof connect>>, sessionId: string) => Promise<void>;
}) {
  const host = await testHost({
    modelClient: scriptedModel(options.replies, { repeatLast: true }).client,
    plugins:
      options.tools === undefined
        ? []
        : [testPlugin({ id: "tools", tools: options.tools })],
  });
  const client = connect(host);
  await client.describe();
  await client.call("subscriptions.open", {});
  if (options.tools !== undefined) await client.call("plugins.enable", { pluginId: "tools" });
  const session = await createSessionThrough(client);

  const started = await client.call("runs.start", {
    sessionId: session.sessionId,
    submissionId: nextId("sub"),
    text: "inspect me",
  });
  const runId = started.result?.run.runId as string;
  if (options.before !== undefined) await options.before(client, runId);

  const terminal = await awaitRunTerminal(client, runId);
  const after = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session;
  const history = await conversation(client, session.sessionId);
  return { client, session, terminal, after, history };
}

describe("corrupted logs become host failures, never history", () => {
  it("refuses a segment whose turn id is not the one the run bound", async () => {
    control.rewrite = (event, index) => (index === 1 ? { ...event, turnId: "some-other-turn" } : event);

    const { terminal, after, history } = await runAndInspect({ replies: [textReply("the answer")] });

    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("host_error");
    expect(after?.status).toBe("blocked");
    expect(history).toEqual([]);
  });

  it("refuses a segment whose positions run backwards", async () => {
    control.rewrite = (event, index) => (index === 2 ? { ...event, seq: 1 } : event);

    const { terminal, after } = await runAndInspect({ replies: [textReply("the answer")] });

    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("host_error");
    expect(after?.status).toBe("blocked");
  });

  it("refuses a segment with a repeated position", async () => {
    control.rewrite = (event, index) => (index === 2 ? { ...event, seq: 1 } : event);

    const { terminal, after } = await runAndInspect({
      replies: [textReply("the answer")],
    });

    expect(terminal.endReason).toBe("host_error");
    expect(after?.status).toBe("blocked");
  });

  it("refuses a segment that skips positions", async () => {
    control.rewrite = (event, index) => (index === 2 ? { ...event, seq: 9 } : event);

    const { terminal, after } = await runAndInspect({ replies: [textReply("the answer")] });

    expect(terminal.endReason).toBe("host_error");
    expect(after?.status).toBe("blocked");
  });

  it("refuses a completed turn that has no finished model step", async () => {
    control.dropType = "message/assistant";

    const { terminal, after, history } = await runAndInspect({ replies: [textReply("the answer")] });

    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("host_error");
    expect(after?.status).toBe("blocked");
    expect(history).toEqual([]);
  });

  it("refuses a completed turn whose last step still had open tool calls", async () => {
    // The assistant record is rewritten to claim a call that the turn completed
    // without dispatching: a shape the Core never writes for `completed`.
    control.rewrite = (event, index) =>
      index === 2 && event.type === "message/assistant"
        ? { ...event, data: { ...event.data, toolCalls: [{ callId: "ghost", name: "ghost", input: {} }] } }
        : event;

    const { terminal, after } = await runAndInspect({ replies: [textReply("the answer")] });

    expect(terminal.endReason).toBe("host_error");
    expect(after?.status).toBe("blocked");
  });
});

describe("the closures the Core really writes stay legal", () => {
  it("publishes a turn cancelled before the model was ever asked", async () => {
    const { terminal, after, history } = await runAndInspect({
      replies: [textReply("never produced")],
      before: async (client, runId) => {
        // No await in between: the abort lands before the drain starts the turn.
        await client.call("runs.cancel", { runId });
      },
    });

    expect(terminal.status).toBe("cancelled");
    expect(terminal.endReason).toBe("cancelled");
    expect(after?.status).toBe("ready");
    expect(history.map((item) => item.kind)).toEqual(["user"]);
  });

  it("publishes a cancelled turn that did reach a model step", async () => {
    const started = gate();
    const { terminal, after, history } = await runAndInspect({
      replies: [toolReply("call-1", "slow", {})],
      tools: [
        {
          name: "slow",
          description: "waits to be cancelled",
          inputSchema: {},
          execute: async (_input, context) => {
            started.open();
            await new Promise<void>((resolve) => {
              context.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            return "stopped";
          },
        },
      ],
      before: async (client, runId) => {
        // The call is in flight, so the turn really has a recorded assistant
        // step and a dispatch before it is cancelled.
        await started.promise;
        await client.call("runs.cancel", { runId });
      },
    });

    expect(terminal.status).toBe("cancelled");
    expect(after?.status).toBe("ready");
    expect(history.filter((item) => item.kind === "tool-result")).toHaveLength(1);
  });

  it("publishes a turn the Core failed", async () => {
    const { terminal, after, history } = await runAndInspect({ replies: [] });

    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("error");
    expect(after?.status).toBe("ready");
    expect(history.map((item) => item.kind)).toEqual(["user"]);
  });

  it("publishes a turn that spent its whole step budget", async () => {
    const { terminal, after, history } = await runAndInspect({
      replies: [toolReply("call-1", "echo", {})],
      tools: [{ name: "echo", description: "echo", inputSchema: {}, execute: async () => "42" }],
    });

    expect(terminal.status).toBe("limited");
    expect(terminal.endReason).toBe("max_steps");
    expect(after?.status).toBe("ready");
    expect(history.filter((item) => item.kind === "tool-call")).toHaveLength(12);
  });
});
