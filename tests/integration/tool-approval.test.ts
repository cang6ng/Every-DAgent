/**
 * M4 acceptance across the whole stack: a real host, a real client, and a real
 * approval answered over the wire.
 *
 * The client here is the shipped one — its typed approval handler is the only
 * way an answer leaves it — and the host is the shipped one, with a trusted
 * policy that decides `require-approval`. What these tests prove is the pair
 * of facts the milestone exists for: nothing runs before an approval, and
 * exactly one thing runs after one.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { Tool } from "@every-dagent/agent-core";
import type { ApprovalSnapshot, ToolApprovalResponse } from "@every-dagent/protocol";
import type { ToolPolicy, ToolPolicyView } from "@every-dagent/host";
import type { Client } from "@every-dagent/client";

import { createClientOn, createHostPlatform, runSettled, waitFor } from "../helpers/platform.js";
import type { HostPlatform } from "../helpers/platform.js";
import { scriptedModel, textReply, toolReply } from "../helpers/demo-fixtures.js";

const open: HostPlatform[] = [];

afterEach(async () => {
  for (const platform of open.splice(0)) {
    await platform.shutdown();
  }
});

/** A tool that counts its executions — a controlled side effect, and nothing else. */
function counterTool(): { readonly tool: Tool; readonly executions: unknown[] } {
  const executions: unknown[] = [];
  const tool = {
    name: "counter",
    description: "Counts.",
    inputSchema: { type: "object" },
    async execute(input: unknown): Promise<string> {
      executions.push(input);
      return `count:${executions.length}`;
    },
  };
  return { tool: tool as unknown as Tool, executions };
}

function approvalPolicy(): ToolPolicy {
  return {
    revision: 9,
    decide: (view: ToolPolicyView) => {
      void view;
      return "require-approval";
    },
  } as unknown as ToolPolicy;
}

/** Args with a legal own `__proto__` key: a real JSON key that must survive unchanged. */
function protoArguments(): Record<string, unknown> {
  const input: Record<string, unknown> = { n: 1 };
  Object.defineProperty(input, "__proto__", {
    value: { polluted: "no" },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return input;
}

/** A host whose one tool requires approval, and a run that has reached the gate. */
async function approvalPlatform(options: {
  readonly input?: unknown;
  readonly registerHandler?: boolean;
}): Promise<{
  readonly platform: HostPlatform;
  readonly executions: unknown[];
  readonly snapshots: ApprovalSnapshot[];
  readonly answers: ((response: ToolApprovalResponse) => void)[];
  readonly client: Client;
  readonly seenStatuses: (string | null)[];
  readonly runId: string;
}> {
  const counter = counterTool();
  const model = scriptedModel([
    toolReply("call-1", "counter", options.input ?? { n: 1 }),
    textReply("finished"),
  ]);
  const platform = await createHostPlatform({
    modelClient: model.client,
    plugins: [
      {
        manifest: { id: "tools", name: "Tools", version: "1.0.0" },
        activate: (context): void => {
          context.tools.register(counter.tool);
        },
      },
    ],
    toolPolicy: approvalPolicy(),
  });
  open.push(platform);

  const snapshots: ApprovalSnapshot[] = [];
  const answers: ((response: ToolApprovalResponse) => void)[] = [];
  const client = createClientOn(platform);
  // Every approval status this replica publishes, in order. A decided approval
  // stops being `current` the moment its execution is over, so "the client saw
  // the decision" is a fact about the states it passed through, not about the
  // one it holds at the end.
  const seenStatuses: (string | null)[] = [];
  if (options.registerHandler !== false) {
    client.registerToolApprovalHandler((snapshot): Promise<ToolApprovalResponse> => {
      snapshots.push(snapshot);
      // The Host's own approval state is folded before the request that asks
      // about it is dispatched: a client is never asked about something it has
      // not been told.
      expect(client.getSnapshot().presentation?.approval?.approvalId).toBe(snapshot.approvalId);
      return new Promise<ToolApprovalResponse>((resolve) => {
        answers.push(resolve);
      });
    });
  }
  await client.connect();
  client.subscribe(() => {
    seenStatuses.push(client.getSnapshot().presentation?.approval?.status ?? null);
  });
  await client.plugins.enable({ pluginId: "tools" });
  const session = (await client.sessions.create()).session;
  const started = await client.runs.start({ sessionId: session.sessionId, submissionId: "sub-1", text: "count" });

  return {
    platform,
    executions: counter.executions,
    snapshots,
    answers,
    client,
    seenStatuses,
    runId: started.run.runId,
  };
}

function decide(snapshot: ApprovalSnapshot, decision: "approve" | "reject"): ToolApprovalResponse {
  return { approvalId: snapshot.approvalId, executionId: snapshot.executionId, decision };
}

describe("a tool approval over the wire", () => {
  it("runs nothing before the approval and exactly one thing after it", async () => {
    const harness = await approvalPlatform({});
    await waitFor(() => harness.snapshots.length === 1, { what: "the approval" });

    expect(harness.executions).toEqual([]);
    const snapshot = harness.snapshots[0] as ApprovalSnapshot;
    expect(snapshot.status).toBe("pending");
    expect(snapshot.canRespond).toBe(true);
    expect(snapshot.name).toBe("counter");
    expect(snapshot.input).toEqual({ kind: "json", value: { n: 1 } });
    expect(snapshot.invocationId).toEqual(expect.any(String));
    expect(snapshot.executionId).toEqual(expect.any(String));
    expect(snapshot.turnId).toEqual(expect.any(String));
    expect(harness.client.getSnapshot().approvalCanRespond).toBe(true);

    harness.answers[0]?.(decide(snapshot, "approve"));
    await waitFor(() => runSettled(harness.client.getSnapshot(), harness.runId), { what: "the run to settle" });

    expect(harness.executions).toEqual([{ n: 1 }]);
    // The decision is the Host's, and the replica read it on the way through:
    // `approved` was published before the execution ended, and once it ended the
    // approval stopped being the current one.
    expect(harness.seenStatuses).toContain("approved");
    expect(harness.client.getSnapshot().presentation?.approval).toBeNull();
    expect(harness.client.getSnapshot().approvalCanRespond).toBe(false);
  });

  it("carries the exact prepared arguments, own __proto__ key included", async () => {
    const harness = await approvalPlatform({ input: protoArguments() });
    await waitFor(() => harness.snapshots.length === 1, { what: "the approval" });

    const snapshot = harness.snapshots[0] as ApprovalSnapshot;
    const shown = snapshot.input;
    expect(shown.kind).toBe("json");
    if (shown.kind !== "json") throw new Error("unreachable");
    const value = shown.value as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(value, "__proto__")).toBe(true);
    expect(value["__proto__"]).toEqual({ polluted: "no" });
    expect((value as { polluted?: unknown }).polluted).toBeUndefined();

    harness.answers[0]?.(decide(snapshot, "approve"));
    await waitFor(() => harness.executions.length === 1, { what: "the execution" });
    const executed = harness.executions[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(executed, "__proto__")).toBe(true);
    expect(executed["__proto__"]).toEqual({ polluted: "no" });
  });

  it("records a rejection as a not-executed observation and finishes the turn", async () => {
    const harness = await approvalPlatform({});
    await waitFor(() => harness.snapshots.length === 1, { what: "the approval" });
    const snapshot = harness.snapshots[0] as ApprovalSnapshot;

    harness.answers[0]?.(decide(snapshot, "reject"));
    await waitFor(() => runSettled(harness.client.getSnapshot(), harness.runId), { what: "the run to settle" });

    expect(harness.executions).toEqual([]);
    expect(harness.seenStatuses).toContain("denied");
    expect(harness.client.getSnapshot().presentation?.approval).toBeNull();
    const history = await harness.client.sessions.history({ sessionId: snapshot.sessionId });
    const result = history.page.items.find((item) => item.kind === "tool-result");
    expect(result?.kind === "tool-result" && result.ok).toBe(false);
    expect(result?.kind === "tool-result" && result.content).toContain("not executed");
    expect(result?.kind === "tool-result" && result.disposition).toBe("not-executed");
  });

  it("keeps the approval pending across a disconnect and asks again after reconnecting", async () => {
    const harness = await approvalPlatform({});
    await waitFor(() => harness.snapshots.length === 1, { what: "the first delivery" });
    const first = harness.snapshots[0] as ApprovalSnapshot;
    expect(harness.executions).toEqual([]);

    // The client goes away: its delivery ends, the business record does not.
    harness.client.disconnect();
    expect(harness.client.getSnapshot().approvalReply.state).not.toBe("pending");
    expect(harness.client.getSnapshot().approvalCanRespond).toBe(false);

    await harness.client.reconnect();
    await waitFor(() => harness.snapshots.length === 2, { what: "the re-offered approval" });
    const again = harness.snapshots[1] as ApprovalSnapshot;

    // The same business approval, delivered again: same identities, same exact
    // input, and the same business deadline — reconnecting refreshes nothing.
    expect(again.approvalId).toBe(first.approvalId);
    expect(again.executionId).toBe(first.executionId);
    expect(again.input).toEqual(first.input);
    expect(again.deadlineAt).toBe(first.deadlineAt);
    expect(harness.client.getSnapshot().approvalCanRespond).toBe(true);

    // The first delivery's answer arrives after its scope ended: this client
    // does not send it, and nothing runs because of it.
    harness.answers[0]?.(decide(first, "reject"));
    await waitFor(() => harness.client.getSnapshot().approvalReply.state === "pending", {
      what: "the new delivery to be answerable",
    });
    expect(harness.executions).toEqual([]);

    harness.answers[1]?.(decide(again, "approve"));
    await waitFor(() => runSettled(harness.client.getSnapshot(), harness.runId), { what: "the run to settle" });
    expect(harness.executions).toEqual([{ n: 1 }]);
  });

  it("lets the first valid decision win across two connections", async () => {
    const counter = counterTool();
    const model = scriptedModel([toolReply("call-1", "counter", { n: 1 }), textReply("finished")]);
    const platform = await createHostPlatform({
      modelClient: model.client,
      plugins: [
        {
          manifest: { id: "tools", name: "Tools", version: "1.0.0" },
          activate: (context): void => {
            context.tools.register(counter.tool);
          },
        },
      ],
      toolPolicy: approvalPolicy(),
    });
    open.push(platform);

    const answers: ((response: ToolApprovalResponse) => void)[] = [];
    const handler = (): Promise<ToolApprovalResponse> =>
      new Promise<ToolApprovalResponse>((resolve) => {
        answers.push(resolve);
      });

    const first = createClientOn(platform);
    first.registerToolApprovalHandler(handler);
    await first.connect();

    const second = createClientOn(platform);
    second.registerToolApprovalHandler(handler);
    await second.connect();

    const session = (await first.sessions.create()).session;
    await first.plugins.enable({ pluginId: "tools" });
    const started = await first.runs.start({ sessionId: session.sessionId, submissionId: "sub-1", text: "count" });
    await waitFor(() => answers.length === 2, { what: "two deliveries" });

    const snapshot = first.getSnapshot().presentation?.approval as ApprovalSnapshot;
    expect(snapshot.status).toBe("pending");
    // Both deliveries carry the same business approval; only one decision will
    // ever exist, and whoever answers first is the one that decides.
    const approve = decide(snapshot, "approve");
    answers[1]?.(approve);
    answers[0]?.(approve);

    await waitFor(() => runSettled(first.getSnapshot(), started.run.runId), { what: "the run to settle" });
    await waitFor(() => runSettled(second.getSnapshot(), started.run.runId), { what: "the second client's view" });
    expect(counter.executions).toEqual([{ n: 1 }]);
    // The losing delivery is told the decision too — approval.updated is a
    // broadcast, and the business state is one fact for every replica.
    expect(second.getSnapshot().presentation?.approval ?? null).toBeNull();
  });

  it("answers a client with no handler by ending the delivery, not the approval", async () => {
    const harness = await approvalPlatform({ registerHandler: false });

    // The client is asked and refuses the capability; the Host's approval stays
    // exactly where it is, and nothing runs.
    await waitFor(
      () => harness.client.getSnapshot().presentation?.approval?.status === "pending",
      { what: "the pending approval" },
    );
    await waitFor(() => harness.client.getSnapshot().approvalCanRespond === false, {
      what: "the delivery to end",
    });
    expect(harness.executions).toEqual([]);
    expect(harness.client.getSnapshot().presentation?.approval?.status).toBe("pending");
  });
});
