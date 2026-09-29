/**
 * Runtime-level failures, injected where they actually happen.
 *
 * The only way a `Runtime.stream()` iterator can reject is a `Session.append`
 * that throws — every other failure inside a turn is reported as a turn outcome
 * by design. So this file replaces `createSession` with a wrapper around the
 * real one, which can fail or silently drop a chosen append. Nothing else about
 * the Core is mocked: the runtime, the loop, the registry and the host are the
 * real ones.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session, SessionEvent, SessionEventInput } from "@every-dagent/agent-core";

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
    createSession: (id: string): Session => {
      const session = actual.createSession(id);
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
    },
  };
});

const { connect, createSessionThrough, awaitRunTerminal, scriptedModel, testHost, textReply } =
  await import("./helpers/harness.js");

beforeEach(() => {
  control.failFrom = undefined;
  control.dropType = undefined;
});

async function blockedSessionRun(text: string) {
  const host = testHost({ modelClient: scriptedModel([textReply("the answer")]).client });
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
  return { client, session, terminal, after };
}

describe("runtime failures", () => {
  it("turns a stream that never started into a host failure with a blocked session", async () => {
    control.failFrom = 1;

    const { terminal, after } = await blockedSessionRun("fails immediately");

    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("host_error");
    expect(terminal.error?.code).toBe("INTERNAL_ERROR");
    expect(terminal.live).toBeNull();
    expect(after?.status).toBe("blocked");
    expect(after?.activeRunId).toBeNull();
    expect(after?.canonical).toEqual([]);
  });

  it("does not complete a run whose turn was written but whose stream then threw", async () => {
    // The turn's own end is recorded, and the append of it still fails: the log
    // looks closed while the execution never settled cleanly.
    control.failFrom = 4;

    const { terminal, after, client } = await blockedSessionRun("closes then throws");

    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("host_error");
    // The turn that the log may hold is not published as history.
    expect(after?.status).toBe("blocked");
    expect(after?.canonical).toEqual([]);
    expect(client.events.filter((event) => event.type === "run.ended")).toHaveLength(1);
  });

  it("treats a missing turn end as an unverifiable log, not as a completion", async () => {
    control.dropType = "turn/end";

    const { terminal, after } = await blockedSessionRun("no closing record");

    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("host_error");
    expect(after?.status).toBe("blocked");
    expect(after?.canonical).toEqual([]);
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
