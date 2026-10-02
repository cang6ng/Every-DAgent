/**
 * Batch 2 — C5 / R26: every legal terminal run state is representable on every
 * public path.
 *
 * The bug this closes was a producer/schema mismatch: `runs.list` projected a
 * failed run with `error: null` while the contract requires a failed run to
 * carry one, so a run the store held — and `runs.get` served — could not be
 * listed at all. One authority projects a durable run now, and this pins it
 * against all five terminal kinds the runtime really produces.
 */

import { describe, expect, it } from "vitest";

import type { RunStatus } from "@every-dagent/protocol";

import {
  abortAwareReply,
  awaitRunTerminal,
  composeTestHost,
  connect,
  constantTool,
  createSessionThrough,
  flush,
  nextId,
  replyThenFail,
  scriptedModel,
  testPlugin,
  textReply,
  toolReply,
  type TestClient,
} from "./helpers/harness.js";

interface TerminalCase {
  readonly name: string;
  readonly status: RunStatus;
  readonly endReason: string;
  readonly run: (client: TestClient) => Promise<{ readonly sessionId: string; readonly runId: string }>;
}

async function startAndWait(client: TestClient, sessionId: string, text: string): Promise<string> {
  const started = await client.call("runs.start", { sessionId, submissionId: nextId("sub"), text });
  const runId = started.result?.run.runId as string;
  await awaitRunTerminal(client, runId);
  return runId;
}

const CASES: readonly TerminalCase[] = [
  {
    name: "a completed run",
    status: "completed",
    endReason: "completed",
    run: async (client) => {
      const session = await createSessionThrough(client);
      return { sessionId: session.sessionId, runId: await startAndWait(client, session.sessionId, "answer me") };
    },
  },
  {
    name: "a limited run",
    status: "limited",
    endReason: "max_steps",
    run: async (client) => {
      const session = await createSessionThrough(client);
      await client.call("plugins.enable", { pluginId: "tools" });
      return { sessionId: session.sessionId, runId: await startAndWait(client, session.sessionId, "count forever") };
    },
  },
  {
    name: "a cancelled run",
    status: "cancelled",
    endReason: "cancelled",
    run: async (client) => {
      const session = await createSessionThrough(client);
      const started = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: nextId("sub"),
        text: "hold on",
      });
      const runId = started.result?.run.runId as string;
      await client.call("runs.cancel", { runId });
      await awaitRunTerminal(client, runId);
      return { sessionId: session.sessionId, runId };
    },
  },
  {
    name: "a run that failed at the model",
    status: "failed",
    endReason: "error",
    run: async (client) => {
      const session = await createSessionThrough(client);
      const started = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: nextId("sub"),
        text: "the provider dies",
      });
      const runId = started.result?.run.runId as string;
      await awaitRunTerminal(client, runId);
      return { sessionId: session.sessionId, runId };
    },
  },
  {
    name: "a run the host could not keep",
    status: "failed",
    endReason: "host_error",
    run: async (client) => {
      const session = await createSessionThrough(client);
      await client.call("plugins.enable", { pluginId: "big" });
      return { sessionId: session.sessionId, runId: await startAndWait(client, session.sessionId, "use the big tool") };
    },
  },
];

describe("C5 every terminal run state is listable, readable and in the cut", () => {
  for (const testCase of CASES) {
    it(`serves ${testCase.name} through runs.list, runs.get and the snapshot`, async () => {
      const host = composeTestHost({
        // The model script is per case; a repeat last keeps a run alive until
        // its own outcome applies.
        modelClient: scriptedModel(
          testCase.status === "limited"
            ? [toolReply("c-1", "echo", { n: 1 })]
            : testCase.status === "cancelled"
              ? [abortAwareReply()]
              : testCase.status === "failed" && testCase.endReason === "error"
                ? [replyThenFail([{ type: "text-delta", text: "half" }], new Error("provider died"))]
                : testCase.endReason === "host_error"
                  ? [toolReply("c-1", "big", {}), textReply("done")]
                  : [textReply("answered")],
          { repeatLast: true },
        ).client,
        plugins: [
          testPlugin({ id: "tools", tools: [constantTool("echo", "42")] }),
          testPlugin({ id: "big", tools: [constantTool("big", "x".repeat(70 * 1024))] }),
        ],
      });
      const client = connect(host.host);
      try {
        await client.describe();
        await client.call("subscriptions.open", {});
        const { sessionId, runId } = await testCase.run(client);

        // The listing: this is the path that used to answer INTERNAL_ERROR for
        // a failed run, because the page could not be encoded at all.
        const listed = await client.call("runs.list", { sessionId });
        expect(listed.error).toBeUndefined();
        const entry = listed.result?.runs.items.find((run) => run.runId === runId);
        expect(entry?.status).toBe(testCase.status);
        expect(entry?.endReason).toBe(testCase.endReason);
        expect(entry?.endedAt).not.toBeNull();
        if (testCase.status === "failed") expect(entry?.error).not.toBeNull();
        else expect(entry?.error).toBeNull();

        // The single read agrees, field for field, on the outcome.
        const fetched = await client.call("runs.get", { runId });
        expect(fetched.error).toBeUndefined();
        expect(fetched.result?.run.status).toBe(testCase.status);
        expect(fetched.result?.run.endReason).toBe(testCase.endReason);

        // And the bounded cut carries the same view of the run.
        const opened = await client.call("subscriptions.open", {});
        const inCut = opened.result?.snapshot.runs.items.find((run) => run.runId === runId);
        expect(inCut?.status).toBe(testCase.status);
        expect(inCut?.endReason).toBe(testCase.endReason);
      } finally {
        await flush();
        client.detach();
        await host.host.shutdown();
      }
    });
  }

  it("lists a terminal run whose session is blocked, alongside the session itself", async () => {
    const host = composeTestHost({
      modelClient: scriptedModel([toolReply("c-1", "big", {}), textReply("done")]).client,
      plugins: [testPlugin({ id: "big", tools: [constantTool("big", "x".repeat(70 * 1024))] })],
    });
    const client = connect(host.host);
    try {
      await client.describe();
      await client.call("subscriptions.open", {});
      const session = await createSessionThrough(client);
      await client.call("plugins.enable", { pluginId: "big" });
      const started = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: "sub-blocked",
        text: "use the big tool",
      });
      const runId = started.result?.run.runId as string;
      await awaitRunTerminal(client, runId);

      const after = await client.call("sessions.get", { sessionId: session.sessionId });
      expect(after.result?.session.status).toBe("blocked");
      expect(after.result?.session.blockedReason).toBe("host-fault");

      const listed = await client.call("runs.list", { sessionId: session.sessionId });
      expect(listed.error).toBeUndefined();
      expect(listed.result?.runs.items.map((run) => run.status)).toEqual(["failed"]);
      expect(listed.result?.runs.items[0]?.error).not.toBeNull();
    } finally {
      client.detach();
      await host.host.shutdown();
    }
  });
});
