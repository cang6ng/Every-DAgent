/**
 * Runtime-level failures, injected where they actually happen.
 *
 * The only way a `Runtime.stream()` iterator can reject is a `Session.append`
 * that throws — every other failure inside a turn is reported as a turn outcome
 * by design. So this file wraps `restoreSessionWindow` — the window of committed
 * history a run executes against — around the real one, which can fail or
 * silently drop a chosen append. Nothing else about the Core is mocked: the
 * runtime, the loop, the registry and the host are the real ones.
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
  /** Fail from the nth append on (1-based). */
  failFrom: undefined as number | undefined,
  /** Write nothing for this event type, and report no failure. */
  dropType: undefined as string | undefined,
}));

vi.mock("@every-dagent/agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@every-dagent/agent-core")>();
  return {
    ...actual,
    restoreSessionWindow: (id: string, window: SessionWindow): Session =>
      instrumentAppends(actual.restoreSessionWindow(id, window)),
  };
});

/** The same session, with its appends able to fail or to vanish. */
function instrumentAppends(session: Session): Session {
  let appends = 0;
  return {
    id: session.id,
    append: (event: SessionEventInput): SessionEvent => {
      appends += 1;
      if (control.failFrom !== undefined && appends >= control.failFrom) {
        throw new Error("injected session append failure");
      }
      if (control.dropType === event.type) {
        // No write, no throw: the Runtime believes the turn closed.
        return { ...event, seq: appends, time: Date.now() } as unknown as SessionEvent;
      }
      return session.append(event);
    },
    events: () => session.events(),
    deriveMessages: () => session.deriveMessages(),
  };
}

const { connect, createSessionThrough, awaitRunTerminal, scriptedModel, testHost, textReply } =
  await import("./helpers/harness.js");

beforeEach(() => {
  control.failFrom = undefined;
  control.dropType = undefined;
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

async function blockedSessionRun(text: string) {
  const host = await testHost({ modelClient: scriptedModel([textReply("the answer")]).client });
  const client = connect(host);
  await client.describe();
  await client.call("subscriptions.open", {});
  const session = await createSessionThrough(client);

  const started = await client.call("runs.start", {
    sessionId: session.sessionId,
    submissionId: `sub-${text}`,
    text,
  });
  const runId = started.result?.run.runId as string;
  const terminal = await awaitRunTerminal(client, runId);
  const after = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session;
  const history = await conversation(client, session.sessionId);
  return { client, session, terminal, after, history };
}

describe("runtime failures", () => {
  it("turns a stream that never started into a host failure with a blocked session", async () => {
    control.failFrom = 1;

    const { terminal, after, history } = await blockedSessionRun("fails immediately");

    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("host_error");
    expect(terminal.error?.code).toBe("INTERNAL_ERROR");
    expect(terminal.live).toBeNull();
    expect(after?.status).toBe("blocked");
    expect(after?.activeRunId).toBeNull();
    expect(history).toEqual([]);
  });

  it("does not complete a run whose turn was written but whose stream then threw", async () => {
    // The turn's own end is recorded, and the append of it still fails: the log
    // looks closed while the execution never settled cleanly.
    control.failFrom = 4;

    const { terminal, after, client, history } = await blockedSessionRun("closes then throws");

    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("host_error");
    // The turn that the log may hold is not published as history.
    expect(after?.status).toBe("blocked");
    expect(history).toEqual([]);
    expect(client.events.filter((event) => event.type === "run.ended")).toHaveLength(1);
  });

  it("treats a missing turn end as an unverifiable log, not as a completion", async () => {
    control.dropType = "turn/end";

    const { terminal, after, history } = await blockedSessionRun("no closing record");

    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("host_error");
    expect(after?.status).toBe("blocked");
    expect(history).toEqual([]);
  });

  it("keeps the session readable and refuses new runs once it is blocked", async () => {
    control.dropType = "turn/end";
    const { client, session } = await blockedSessionRun("block me");

    const readable = await client.call("sessions.get", { sessionId: session.sessionId });
    expect(readable.result?.session.status).toBe("blocked");

    const refused = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "sub-after-block",
      text: "try again",
    });
    expect(refused.error?.code).toBe("SESSION_UNAVAILABLE");

    // A different session on the same host is unaffected.
    const other = await createSessionThrough(client);
    expect(other.status).toBe("ready");
  });

  it("reports the failure once, and keeps the host usable afterwards", async () => {
    control.failFrom = 1;
    const { client, terminal } = await blockedSessionRun("one bad run");

    const again = await client.call("runs.get", { runId: terminal.runId });
    expect(again.result?.run).toEqual(terminal);

    expect(client.events.filter((event) => event.type === "run.ended")).toHaveLength(1);
  });
});
