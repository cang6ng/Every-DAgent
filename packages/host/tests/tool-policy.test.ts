/**
 * M4 at the host's boundary: the trusted policy, the managed call profile, and
 * the approval lifecycle that guards a call before it is dispatched.
 *
 * These are the host-level facts. The cross-layer acceptance — a real client
 * approving a real call — lives with the integration and browser suites; what
 * is here is what the host does when a step is prepared, when a policy
 * answers, when an approval is asked about, and when the mapping a call was
 * prepared against has moved.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Tool } from "@every-dagent/agent-core";
import type { ApprovalSnapshot } from "@every-dagent/protocol";
import type { ToolPolicy, ToolPolicyView } from "@every-dagent/host";

import type { ComposedHost } from "../src/host.js";
import { testComposition } from "../../../tests/helpers/test-composition.js";
import {
  composeTestHost,
  connect,
  flush,
  nextId,
  scriptedModel,
  testClock,
  testPlugin,
  textReply,
  toolReply,
} from "./helpers/harness.js";
import type { TestClient } from "./helpers/harness.js";

const open: ComposedHost[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const composed of open.splice(0)) {
    await composed.host.shutdown();
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A tool that records every value it is handed, and who it was when it ran. */
function countingTool(name = "counter"): { readonly tool: Tool; readonly executions: unknown[] } {
  const executions: unknown[] = [];
  const tool = {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    marker: "registered",
    async execute(this: { readonly marker: string }, input: unknown): Promise<string> {
      executions.push(input);
      return `${this.marker}:${executions.length}`;
    },
  };
  return { tool: tool as unknown as Tool, executions };
}

/** A policy that allows the names it is given, refuses everything else. */
function namePolicy(options: {
  readonly allow?: readonly string[];
  readonly requireApproval?: readonly string[];
  readonly decide?: (view: ToolPolicyView) => unknown;
  readonly catalogue?: readonly Tool[];
}): ToolPolicy {
  return {
    revision: 5,
    ...(options.catalogue === undefined ? {} : { tools: options.catalogue }),
    decide: (view: ToolPolicyView) => {
      if (options.decide !== undefined) return options.decide(view);
      if (options.allow?.includes(view.toolName) === true) return "allow";
      if (options.requireApproval?.includes(view.toolName) === true) return "require-approval";
      return "deny";
    },
  } as unknown as ToolPolicy;
}

async function waitFor(condition: () => boolean, what: string, attempts = 200): Promise<void> {
  if (await waitUntil(condition, attempts)) return;
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The same wait, without the throw.
 *
 * A test that is *about* something not happening — a call that must not run, a
 * delivery that must not be re-offered — cannot assert it by timing out: the
 * timeout would be the failure message instead of the fact. These waits settle
 * quietly, and the assertions that follow are what fail when the behaviour is
 * wrong.
 */
async function waitUntil(condition: () => boolean, attempts = 120): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return true;
    await flush();
  }
  return condition();
}

interface OpenApproval {
  readonly request: {
    readonly requestId: string;
    readonly params: ApprovalSnapshot;
    readonly timeoutMs: number;
    readonly streamId: string;
  };
  readonly answer: {
    respond(result: unknown): void;
    fail(code: string): void;
    ignore(): void;
  };
}

interface RunUnderApproval {
  readonly composed: ComposedHost;
  readonly client: TestClient;
  readonly approvals: OpenApproval[];
  readonly sessionId: string;
  readonly runId: string;
}

/** A run that has reached the approve gate and is waiting there. */
async function runToApproval(options: {
  readonly tool: Tool;
  readonly policy: ToolPolicy;
  readonly clock?: ReturnType<typeof testClock>;
  readonly reverseRequests?: boolean;
}): Promise<RunUnderApproval> {
  const approvals: OpenApproval[] = [];
  const model = scriptedModel([toolReply("call-1", "counter", { n: 1 }), textReply("finished")]);
  const composed = await composeTestHost(
    {
      modelClient: model.client,
      plugins: [testPlugin({ id: "tools", tools: [options.tool] })],
      toolPolicy: options.policy,
    },
    options.clock === undefined ? {} : { clock: options.clock },
  );
  open.push(composed);

  const client = connectApprovals(composed, approvals, options.reverseRequests ?? true);
  await client.describe();
  // The delivery lives on a stream: a connection that never subscribed cannot
  // be asked, and the host does not invent a place to ask it.
  await client.call("subscriptions.open", {});
  await client.call("plugins.enable", { pluginId: "tools" });
  const session = (await client.call("sessions.create", {})).result?.session;
  const started = await client.call("runs.start", {
    sessionId: session?.sessionId as string,
    submissionId: nextId("sub"),
    text: "go",
  });
  return {
    composed,
    client,
    approvals,
    sessionId: session?.sessionId as string,
    runId: started.result?.run.runId as string,
  };
}

/** One connected client that records every approval request the host makes. */
function connectApprovals(composed: ComposedHost, approvals: OpenApproval[], reverseRequests = true): TestClient {
  return connect(composed.host, {
    reverseRequests,
    onReverse: (request, answer) => {
      approvals.push({ request: request as unknown as OpenApproval["request"], answer });
    },
  });
}

async function terminalOf(client: TestClient, runId: string): Promise<{ status: string; endReason: string | null }> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = (await client.call("runs.get", { runId })).result?.run;
    if (run !== undefined && run.live === null) return { status: run.status, endReason: run.endReason };
    await flush();
  }
  throw new Error("the run did not settle");
}

/** Starts one run through a connected client and waits for its terminal. */
async function runSimple(
  composed: ComposedHost,
  options: { readonly reverseRequests?: boolean } = {},
): Promise<{ readonly client: TestClient; readonly terminal: { status: string; endReason: string | null } }> {
  const client = connect(composed.host, { reverseRequests: options.reverseRequests ?? false });
  await client.describe();
  await client.call("plugins.enable", { pluginId: "tools" });
  const session = (await client.call("sessions.create", {})).result?.session;
  const started = await client.call("runs.start", {
    sessionId: session?.sessionId as string,
    submissionId: nextId("sub"),
    text: "go",
  });
  return { client, terminal: await terminalOf(client, started.result?.run.runId as string) };
}

describe("the trusted tool policy", () => {
  it("allows a classified call, and the tool runs exactly once", async () => {
    const counter = countingTool();
    const composed = await composeTestHost({
      modelClient: scriptedModel([toolReply("call-1", "counter", { n: 1 }), textReply("done")]).client,
      plugins: [testPlugin({ id: "tools", tools: [counter.tool] })],
      toolPolicy: namePolicy({ allow: ["counter"] }),
    });
    open.push(composed);

    const { terminal } = await runSimple(composed);

    expect(terminal).toEqual({ status: "completed", endReason: "completed" });
    expect(counter.executions).toEqual([{ n: 1 }]);
    const history = composed.repository.listSessions(1, null).records;
    const records = composed.repository.readHistory(history[0]?.sessionId as string, 100, 50).records;
    expect(records.find((record) => record.type === "tool/result")?.data).toContain('"disposition":"executed"');
  });

  it("denies without running anything, and the model is told plainly", async () => {
    const counter = countingTool();
    const composed = await composeTestHost({
      modelClient: scriptedModel([toolReply("call-1", "counter", { n: 1 }), textReply("continued")]).client,
      plugins: [testPlugin({ id: "tools", tools: [counter.tool] })],
      toolPolicy: namePolicy({ allow: [] }),
    });
    open.push(composed);

    const { terminal } = await runSimple(composed);

    // A refusal is an observation, not a failure: the conversation continues,
    // with a fixed sentence and no claim that anything ran.
    expect(terminal).toEqual({ status: "completed", endReason: "completed" });
    expect(counter.executions).toEqual([]);
    const records = composed.repository.readHistory(
      composed.repository.listSessions(1, null).records[0]?.sessionId as string,
      100,
      50,
    ).records;
    const result = records.find((record) => record.type === "tool/result");
    expect(result?.data).toContain("not executed");
    expect(result?.data).toContain('"disposition":"not-executed"');
  });

  it("denies a registered tool its catalogue does not name", async () => {
    const counter = countingTool();
    const other = countingTool("other");
    const composed = await composeTestHost({
      modelClient: scriptedModel([toolReply("call-1", "counter", { n: 1 }), textReply("continued")]).client,
      plugins: [testPlugin({ id: "tools", tools: [counter.tool, other.tool] })],
      // The catalogue names only `other`; a callback that would have allowed
      // everything is not consulted about `counter` at all.
      toolPolicy: namePolicy({ decide: () => "allow", catalogue: [other.tool] }),
    });
    open.push(composed);

    const { terminal } = await runSimple(composed);

    expect(terminal.status).toBe("completed");
    expect(counter.executions).toEqual([]);
  });

  it("refuses every call when the composition supplies no policy at all", async () => {
    const counter = countingTool();
    const model = scriptedModel([toolReply("call-1", "counter", { n: 1 }), textReply("nothing ran")]);
    const composed = await composeTestHost({
      modelClient: model.client,
      plugins: [testPlugin({ id: "tools", tools: [counter.tool] })],
      // `null` is the fixture's way of saying "this trusted side classifies
      // nothing", which is what an unconfigured product composition does too.
      composition: testComposition({ modelClient: model.client, toolPolicy: null }),
    });
    open.push(composed);

    const { terminal } = await runSimple(composed);

    expect(terminal.status).toBe("completed");
    expect(counter.executions).toEqual([]);
  });

  it("refuses a policy that cannot decide: a throw, a promise, an object, nothing", async () => {
    for (const answer of ["throwing", Promise.resolve("allow"), { decision: "allow" }, undefined] as const) {
      const counter = countingTool();
      const composed = await composeTestHost({
        modelClient: scriptedModel([toolReply("call-1", "counter", { n: 1 }), textReply("continued")]).client,
        plugins: [testPlugin({ id: "tools", tools: [counter.tool] })],
        toolPolicy: namePolicy({
          catalogue: [counter.tool],
          decide: () => {
            if (answer === "throwing") throw new Error("the policy exploded");
            return answer;
          },
        }),
      });
      open.push(composed);

      const { client, terminal } = await runSimple(composed);

      // No decision is no authorization: the call does not run, and the turn
      // continues with a safe observation.
      expect(terminal.status).toBe("completed");
      expect(counter.executions).toEqual([]);
      client.detach();
    }
  });

  it("keeps its own copy of the policy: mutating the caller's object changes nothing", async () => {
    const counter = countingTool();
    const policy = {
      revision: 3,
      tools: [counter.tool],
      decide: (): unknown => "deny",
    } as ToolPolicy;
    const composed = await composeTestHost({
      modelClient: scriptedModel([toolReply("call-1", "counter", { n: 1 }), textReply("continued")]).client,
      plugins: [testPlugin({ id: "tools", tools: [counter.tool] })],
      toolPolicy: policy,
    });
    open.push(composed);

    // The caller rewrites the policy it handed over — the list and the callback
    // — and the host keeps deciding with what it captured at startup.
    (policy as unknown as { decide: () => unknown }).decide = (): unknown => "allow";
    (policy as unknown as { tools: readonly Tool[] }).tools = [];

    const { terminal } = await runSimple(composed);

    expect(terminal.status).toBe("completed");
    expect(counter.executions).toEqual([]);
  });
});

describe("the managed call profile", () => {
  it("binds the executor taken at registration, not whatever the tool says afterwards", async () => {
    const counter = countingTool();
    let replacements = 0;
    const composed = await composeTestHost({
      modelClient: scriptedModel([toolReply("call-1", "counter", { n: 1 }), textReply("done")]).client,
      plugins: [testPlugin({ id: "tools", tools: [counter.tool] })],
      toolPolicy: namePolicy({ allow: ["counter"] }),
    });
    open.push(composed);

    const client = connect(composed.host);
    await client.describe();
    // Enabling is what registers the tool; the replacement happens afterwards,
    // so it is a *replacement* of a registered implementation.
    await client.call("plugins.enable", { pluginId: "tools" });
    (counter.tool as { execute: unknown }).execute = async (): Promise<string> => {
      replacements += 1;
      return "the replacement";
    };

    const session = (await client.call("sessions.create", {})).result?.session;
    const started = await client.call("runs.start", {
      sessionId: session?.sessionId as string,
      submissionId: nextId("sub"),
      text: "go",
    });
    const terminal = await terminalOf(client, started.result?.run.runId as string);

    expect(terminal.status).toBe("completed");
    expect(replacements).toBe(0);
    expect(counter.executions).toEqual([{ n: 1 }]);
  });

  it("gives the tool its own receiver and its own copy of the arguments", async () => {
    const seen: { receiver: string; n: number }[] = [];
    const tool = {
      name: "counter",
      description: "The counter tool.",
      inputSchema: { type: "object" },
      marker: "the registered receiver",
      async execute(this: { marker: string }, input: { n: number }): Promise<string> {
        seen.push({ receiver: this.marker, n: input.n });
        // A tool is free to rewrite the value it was handed…
        (input as { n: number }).n = 999;
        return this.marker;
      },
    } as unknown as Tool;
    const composed = await composeTestHost({
      modelClient: scriptedModel([toolReply("call-1", "counter", { n: 1 }), textReply("done")]).client,
      plugins: [testPlugin({ id: "tools", tools: [tool] })],
      toolPolicy: namePolicy({ allow: ["counter"] }),
    });
    open.push(composed);

    await runSimple(composed);

    expect(seen).toEqual([{ receiver: "the registered receiver", n: 1 }]);
    // …and what was recorded is the authority value, not what the tool made of it.
    const records = composed.repository.readHistory(
      composed.repository.listSessions(1, null).records[0]?.sessionId as string,
      100,
      50,
    ).records;
    const call = records.find((record) => record.type === "tool/call");
    expect(call?.data).toContain('"n":1');
    expect(call?.data).not.toContain("999");
  });

  it("refuses a step that names a tool the registry does not have", async () => {
    const counter = countingTool();
    const composed = await composeTestHost({
      modelClient: scriptedModel([
        [
          { type: "tool-call", call: { callId: "call-1", name: "counter", input: { n: 1 } } },
          { type: "tool-call", call: { callId: "call-2", name: "ghost", input: {} } },
          { type: "done" },
        ],
        textReply("never reached"),
      ]).client,
      plugins: [testPlugin({ id: "tools", tools: [counter.tool] })],
      toolPolicy: namePolicy({ allow: ["counter", "ghost"] }),
    });
    open.push(composed);

    const { terminal } = await runSimple(composed);

    // The whole group is judged before anything is written down: the first call
    // never ran, nothing was declared, and the turn stops there.
    expect(terminal.status).toBe("failed");
    expect(counter.executions).toEqual([]);
    const records = composed.repository.readHistory(
      composed.repository.listSessions(1, null).records[0]?.sessionId as string,
      100,
      50,
    ).records;
    expect(records.some((record) => record.type === "tool/call")).toBe(false);
  });

  it("refuses a call that would need an approval too large to represent", async () => {
    const counter = countingTool();
    const huge = { pad: "x".repeat(40 * 1024) };
    const composed = await composeTestHost({
      modelClient: scriptedModel([toolReply("call-1", "counter", huge), textReply("continued")]).client,
      plugins: [testPlugin({ id: "tools", tools: [counter.tool] })],
      toolPolicy: namePolicy({ requireApproval: ["counter"] }),
    });
    open.push(composed);

    const approvals: OpenApproval[] = [];
    const client = connectApprovals(composed, approvals);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = (await client.call("sessions.create", {})).result?.session;
    const started = await client.call("runs.start", {
      sessionId: session?.sessionId as string,
      submissionId: nextId("sub"),
      text: "go",
    });
    const terminal = await terminalOf(client, started.result?.run.runId as string);

    // No truncated approval, no dispatch: the call fails closed and the
    // conversation continues with a safe observation.
    expect(terminal.status).toBe("completed");
    expect(counter.executions).toEqual([]);
    expect(approvals).toEqual([]);
  });
});

describe("approvals", () => {
  it("does not dispatch before an approval, and dispatches exactly once after it", async () => {
    const counter = countingTool();
    const { client, approvals, runId } = await runToApproval({
      tool: counter.tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
    });

    await waitUntil(() => approvals.length >= 1);
    expect(approvals).toHaveLength(1);
    expect(counter.executions).toEqual([]);
    const snapshot = approvals[0]?.request.params as ApprovalSnapshot;
    expect(snapshot.status).toBe("pending");
    expect(snapshot.canRespond).toBe(true);
    expect(snapshot.callId).toBe("call-1");
    expect(snapshot.name).toBe("counter");
    // The snapshot carries the exact prepared arguments, never a display truncation.
    expect(snapshot.input).toEqual({ kind: "json", value: { n: 1 } });
    // And the delivery window is the whole remaining business deadline.
    expect(approvals[0]?.request.timeoutMs).toBe(120_000);

    // The approval is keyed to the occurrence this host's own projection made:
    // the live card and the approval carry one invocation id, which is what a
    // client needs to place the question next to the call it is about.
    const live = (await client.call("runs.get", { runId })).result?.run.live ?? [];
    const card = live.find((item) => item.kind === "tool");
    expect(card?.kind === "tool" && card.invocationId).toBe(snapshot.invocationId);
    expect(card?.kind === "tool" && card.executionId).toBe(snapshot.executionId);

    approvals[0]?.answer.respond({
      approvalId: snapshot.approvalId,
      executionId: snapshot.executionId,
      decision: "approve",
    });

    expect((await terminalOf(client, runId)).status).toBe("completed");
    expect(counter.executions).toEqual([{ n: 1 }]);
  });

  it("keeps duplicate and late approvals from dispatching twice, or deciding twice", async () => {
    const counter = countingTool();
    const { client, approvals, runId } = await runToApproval({
      tool: counter.tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
    });
    await waitFor(() => approvals.length === 1, "the approval request");
    const snapshot = approvals[0]?.request.params as ApprovalSnapshot;
    const answer = { approvalId: snapshot.approvalId, executionId: snapshot.executionId, decision: "approve" };

    // Three answers, sent back to back: the decision, a duplicate of it, and a
    // contradictory one. All three are read; only the first is a decision.
    approvals[0]?.answer.respond(answer);
    approvals[0]?.answer.respond(answer);
    approvals[0]?.answer.respond({ ...answer, decision: "reject" });

    expect((await terminalOf(client, runId)).status).toBe("completed");
    expect(counter.executions).toEqual([{ n: 1 }]);
    const decided = client.events.filter((event) => event.type === "approval.updated");
    // The approval was decided once, and no later frame re-opened it: the
    // duplicate and the contradiction changed nothing, not even the state the
    // Host published.
    expect(decided.some((event) => event.payload.approval?.status === "denied")).toBe(false);
    expect(decided.filter((event) => event.payload.approval?.status === "approved")).toHaveLength(1);
  });

  it("records a rejection as a not-executed observation and continues", async () => {
    const counter = countingTool();
    const { client, approvals, runId, composed, sessionId } = await runToApproval({
      tool: counter.tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
    });
    await waitFor(() => approvals.length === 1, "the approval request");
    const snapshot = approvals[0]?.request.params as ApprovalSnapshot;
    approvals[0]?.answer.respond({
      approvalId: snapshot.approvalId,
      executionId: snapshot.executionId,
      decision: "reject",
    });

    expect((await terminalOf(client, runId)).status).toBe("completed");
    expect(counter.executions).toEqual([]);
    const records = composed.repository.readHistory(sessionId, 100, 50).records;
    const result = records.find((record) => record.type === "tool/result");
    expect(result?.data).toContain("user rejected");
    expect(result?.data).toContain('"disposition":"not-executed"');
  });

  it("expires an unanswered approval at the deadline, and refuses the tool", async () => {
    const clock = testClock();
    const counter = countingTool();
    const { client, approvals, runId } = await runToApproval({
      tool: counter.tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
      clock,
    });
    await waitFor(() => approvals.length === 1, "the approval request");

    await clock.advance(120_000);
    const terminal = await terminalOf(client, runId);

    expect(terminal.status).toBe("completed");
    expect(counter.executions).toEqual([]);
  });

  it("refuses an answer that arrives after the deadline already passed", async () => {
    const clock = testClock();
    const counter = countingTool();
    const { client, approvals, runId } = await runToApproval({
      tool: counter.tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
      clock,
    });
    await waitFor(() => approvals.length === 1, "the approval request");
    const snapshot = approvals[0]?.request.params as ApprovalSnapshot;

    // Time moves without letting the timer run: the deadline is the authority,
    // not the callback that may still be queued.
    clock.advanceWithoutTimers(120_001);
    await flush();

    approvals[0]?.answer.respond({
      approvalId: snapshot.approvalId,
      executionId: snapshot.executionId,
      decision: "approve",
    });

    expect((await terminalOf(client, runId)).status).toBe("completed");
    expect(counter.executions).toEqual([]);
  });

  it("does not dispatch when the registry moved while the approval was pending", async () => {
    const counter = countingTool();
    let registry: { register(tool: Tool): () => void } | undefined;
    const approvals: OpenApproval[] = [];
    const model = scriptedModel([toolReply("call-1", "counter", { n: 1 }), textReply("finished")]);
    const composed = await composeTestHost(
      {
        modelClient: model.client,
        plugins: [testPlugin({ id: "tools", tools: [counter.tool] })],
        toolPolicy: namePolicy({ requireApproval: ["counter"] }),
      },
      { onState: (state) => { registry = state.registry; } },
    );
    open.push(composed);

    const client = connectApprovals(composed, approvals);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = (await client.call("sessions.create", {})).result?.session;
    const started = await client.call("runs.start", {
      sessionId: session?.sessionId as string,
      submissionId: nextId("sub"),
      text: "go",
    });
    const runId = started.result?.run.runId as string;
    await waitFor(() => approvals.length === 1, "the approval request");
    const snapshot = approvals[0]?.request.params as ApprovalSnapshot;

    // The public mutation path is blocked while this run holds the lease, so
    // the change comes from outside the gate — which is exactly the mapping
    // movement the dispatch guard exists for: a call prepared against the old
    // registry must not run against the new one.
    const replacement = countingTool("late");
    registry?.register(replacement.tool);

    approvals[0]?.answer.respond({
      approvalId: snapshot.approvalId,
      executionId: snapshot.executionId,
      decision: "approve",
    });

    expect((await terminalOf(client, runId)).status).toBe("completed");
    expect(counter.executions).toEqual([]);
    expect(replacement.executions).toEqual([]);
  });

  it("keeps the approval pending across a disconnect, and asks again on a new stream", async () => {
    const counter = countingTool();
    const { client, approvals, runId, composed } = await runToApproval({
      tool: counter.tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
    });
    await waitFor(() => approvals.length === 1, "the approval request");
    const first = approvals[0]?.request.params as ApprovalSnapshot;

    // The first client goes away: its delivery ends, the business record does
    // not — and nothing was approved, denied or executed by the disconnect.
    client.detach();
    await flush();
    expect(counter.executions).toEqual([]);

    const second = connectApprovals(composed, approvals);
    await second.describe();
    await second.call("subscriptions.open", {});
    await waitUntil(() => approvals.length >= 2);
    // The approval is still the Host's, and the new stream is asked about it.
    expect(approvals).toHaveLength(2);

    const again = approvals[1]?.request.params as ApprovalSnapshot;
    // The same business approval, delivered again: same identities, same exact
    // input, same deadline — and a *new* delivery, on the new stream, with its
    // own request id in that stream's own numbering.
    expect(again.approvalId).toBe(first.approvalId);
    expect(again.executionId).toBe(first.executionId);
    expect(again.input).toEqual(first.input);
    expect(again.deadlineAt).toBe(first.deadlineAt);
    expect(approvals[1]?.request.streamId).not.toBe(approvals[0]?.request.streamId);

    approvals[1]?.answer.respond({
      approvalId: again.approvalId,
      executionId: again.executionId,
      decision: "approve",
    });

    expect((await terminalOf(second, runId)).status).toBe("completed");
    expect(counter.executions).toEqual([{ n: 1 }]);
    second.detach();
  });

  it("refuses to dispatch when the run was cancelled before the approval was decided", async () => {
    const counter = countingTool();
    const { client, approvals, runId } = await runToApproval({
      tool: counter.tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
    });
    await waitFor(() => approvals.length === 1, "the approval request");

    await client.call("runs.cancel", { runId });
    const terminal = await terminalOf(client, runId);

    expect(terminal.status).toBe("cancelled");
    expect(counter.executions).toEqual([]);
  });

  it("decides the approve/cancel race deterministically, and dispatches at most once", async () => {
    const counter = countingTool();
    const { client, approvals, runId } = await runToApproval({
      tool: counter.tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
    });
    await waitFor(() => approvals.length === 1, "the approval request");
    const snapshot = approvals[0]?.request.params as ApprovalSnapshot;

    // The approval is claimed first, synchronously, in the frame path; the
    // cancellation arrives while the execution is authorized but not yet
    // dispatched. The guard decides: the call does not run, and the run does
    // not claim to have completed it.
    approvals[0]?.answer.respond({
      approvalId: snapshot.approvalId,
      executionId: snapshot.executionId,
      decision: "approve",
    });
    await client.call("runs.cancel", { runId });

    const terminal = await terminalOf(client, runId);
    expect(terminal.status).toBe("cancelled");
    expect(counter.executions).toEqual([]);
  });

  it("lets a cancel after dispatch only ask for an abort, and keeps the disposition executed", async () => {
    const starts: (() => void)[] = [];
    const tool = {
      name: "counter",
      description: "The counter tool.",
      inputSchema: { type: "object" },
      async execute(_input: unknown, context: { readonly signal: AbortSignal }): Promise<string> {
        await new Promise<void>((resolve) => {
          starts.push(resolve);
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return "settled after the abort";
      },
    } as unknown as Tool;
    const { client, approvals, runId, composed, sessionId } = await runToApproval({
      tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
    });
    await waitFor(() => approvals.length === 1, "the approval request");
    const snapshot = approvals[0]?.request.params as ApprovalSnapshot;

    approvals[0]?.answer.respond({
      approvalId: snapshot.approvalId,
      executionId: snapshot.executionId,
      decision: "approve",
    });
    await waitFor(() => starts.length === 1, "the tool to start");

    // The execution already exists: cancelling asks for an abort, and the
    // record says the call was dispatched — never that it did not happen.
    await client.call("runs.cancel", { runId });
    starts[0]?.();
    const terminal = await terminalOf(client, runId);

    expect(terminal.status).toBe("cancelled");
    const records = composed.repository.readHistory(sessionId, 100, 50).records;
    const result = records.find((record) => record.type === "tool/result");
    expect(result?.data).toContain('"disposition":"executed"');
  });

  it("keeps the approval's exact input even when the tool rewrites what it was handed", async () => {
    const seen: unknown[] = [];
    const tool = {
      name: "counter",
      description: "The counter tool.",
      inputSchema: { type: "object" },
      async execute(input: { n: number }): Promise<string> {
        seen.push({ ...input });
        input.n = 4242;
        return "rewritten";
      },
    } as unknown as Tool;
    const { client, approvals, runId, composed, sessionId } = await runToApproval({
      tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
    });
    await waitFor(() => approvals.length === 1, "the approval request");
    const snapshot = approvals[0]?.request.params as ApprovalSnapshot;
    expect(snapshot.input).toEqual({ kind: "json", value: { n: 1 } });

    approvals[0]?.answer.respond({
      approvalId: snapshot.approvalId,
      executionId: snapshot.executionId,
      decision: "approve",
    });
    expect((await terminalOf(client, runId)).status).toBe("completed");

    expect(seen).toEqual([{ n: 1 }]);
    // The tool's own copy was rewritten; the approval that authorized the call
    // and the canonical fact that records it were not.
    const records = composed.repository.readHistory(sessionId, 100, 50).records;
    expect(records.find((record) => record.type === "tool/call")?.data).not.toContain("4242");
  });

  it("never re-shortens the delivery window on reconnect", async () => {
    const clock = testClock();
    const counter = countingTool();
    const { client, approvals, composed, runId } = await runToApproval({
      tool: counter.tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
      clock,
    });
    await waitFor(() => approvals.length === 1, "the approval request");
    expect(approvals[0]?.request.timeoutMs).toBe(120_000);

    // Thirty of the business window's seconds pass, the client drops and comes
    // back: the new delivery gets the *rest* of the window, not a fresh one.
    clock.advanceWithoutTimers(30_000);
    client.detach();
    await flush();

    const second = connectApprovals(composed, approvals);
    await second.describe();
    await second.call("subscriptions.open", {});
    await waitFor(() => approvals.length === 2, "the re-offered approval");
    expect(approvals[1]?.request.timeoutMs).toBe(90_000);

    const snapshot = approvals[1]?.request.params as ApprovalSnapshot;
    approvals[1]?.answer.respond({
      approvalId: snapshot.approvalId,
      executionId: snapshot.executionId,
      decision: "approve",
    });
    expect((await terminalOf(second, runId)).status).toBe("completed");
    expect(counter.executions).toEqual([{ n: 1 }]);
    second.detach();
  });

  it("ignores an answer that arrives on a connection the request was not sent to", async () => {
    const counter = countingTool();
    const { client, approvals, composed, runId } = await runToApproval({
      tool: counter.tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
    });
    await waitFor(() => approvals.length === 1, "the approval request");
    const snapshot = approvals[0]?.request.params as ApprovalSnapshot;

    // A second connection knows the request id and tries to answer it: the
    // host's pending ledger belongs to the connection the request went out on,
    // so this frame is read, validated and dropped.
    const stranger = connect(composed.host, { reverseRequests: true });
    await stranger.describe();
    await stranger.call("subscriptions.open", {});
    stranger.sendRaw(
      JSON.stringify({
        kind: "client-response",
        protocolVersion: "2",
        hostInstanceId: stranger.hostInstanceId,
        streamId: approvals[0]?.request.streamId,
        requestId: approvals[0]?.request.requestId,
        result: { approvalId: snapshot.approvalId, executionId: snapshot.executionId, decision: "approve" },
      }),
    );
    await flush();
    expect(counter.executions).toEqual([]);

    // The real delivery still decides.
    approvals[0]?.answer.respond({
      approvalId: snapshot.approvalId,
      executionId: snapshot.executionId,
      decision: "approve",
    });
    expect((await terminalOf(client, runId)).status).toBe("completed");
    expect(counter.executions).toEqual([{ n: 1 }]);
    stranger.detach();
  });

  it("refuses a group whose approval could never travel in one frame", async () => {
    const counter = countingTool();
    // NUL escapes six times over: 45 KiB of them cannot fit a 256 KiB frame
    // once the run and the catalogue travel with them.
    const oversized = { pad: "\u0000".repeat(45 * 1024) };
    const composed = await composeTestHost({
      modelClient: scriptedModel([toolReply("call-1", "counter", oversized), textReply("never reached")]).client,
      plugins: [testPlugin({ id: "tools", tools: [counter.tool] })],
      toolPolicy: namePolicy({ requireApproval: ["counter"] }),
    });
    open.push(composed);

    const { terminal } = await runSimple(composed);

    // The prospective check runs before the step is declared, so the group is
    // refused whole: nothing was recorded and nothing ran.
    expect(terminal.status).toBe("failed");
    expect(counter.executions).toEqual([]);
    const records = composed.repository.readHistory(
      composed.repository.listSessions(1, null).records[0]?.sessionId as string,
      100,
      50,
    ).records;
    expect(records.some((record) => record.type === "tool/call")).toBe(false);
  });

  it("asks nobody when no capable client is connected, and lets the approval expire", async () => {
    const clock = testClock();
    const counter = countingTool();
    const { composed, approvals } = await runToApproval({
      tool: counter.tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
      clock,
    });
    await waitFor(() => approvals.length === 1, "the approval request");

    // A capable connection that never subscribes gets nothing: the delivery
    // lives on a stream, and there is no stream to ask on.
    const capable = connect(composed.host, { reverseRequests: true });
    await capable.describe();
    await flush();
    expect(approvals).toHaveLength(1);

    await clock.advance(120_000);
    expect(counter.executions).toEqual([]);
    capable.detach();
  });

  it("keeps the execution lease while an approval is pending", async () => {
    const counter = countingTool();
    const { client, approvals, composed, runId, sessionId } = await runToApproval({
      tool: counter.tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
    });
    await waitFor(() => approvals.length === 1, "the approval request");

    const other = connect(composed.host);
    await other.describe();
    const busy = await other.call("runs.start", {
      sessionId,
      submissionId: nextId("sub"),
      text: "second",
    });
    expect(busy.error?.code).toBe("HOST_BUSY");
    // A settings write is refused too: the registry is owned by the waiting run.
    const settings = await other.call("settings.update", {
      namespace: "host",
      expectedRevision: 1,
      value: { systemPrompt: "next", loop: { maxSteps: 4, maxModelAttempts: 2 } },
    });
    expect(settings.error?.code).toBe("HOST_BUSY");
    // And a plugin lifecycle operation as well.
    const lifecycle = await other.call("plugins.disable", { pluginId: "tools" });
    expect(lifecycle.error?.code).toBe("HOST_BUSY");

    const snapshot = approvals[0]?.request.params as ApprovalSnapshot;
    approvals[0]?.answer.respond({
      approvalId: snapshot.approvalId,
      executionId: snapshot.executionId,
      decision: "approve",
    });
    expect((await terminalOf(client, runId)).status).toBe("completed");
    other.detach();
  });

  it("wakes a pending approval on shutdown without releasing the lease early", async () => {
    const dir = mkdtempSync(join(tmpdir(), "every-dagent-m4-"));
    tempDirs.push(dir);
    const location = join(dir, "store.db");
    const counter = countingTool();
    const model = scriptedModel([toolReply("call-1", "counter", { n: 1 }), textReply("finished")]);
    const approvals: OpenApproval[] = [];
    const composed = await composeTestHost({
      modelClient: model.client,
      plugins: [testPlugin({ id: "tools", tools: [counter.tool] })],
      toolPolicy: namePolicy({ requireApproval: ["counter"] }),
      location,
    });
    open.push(composed);

    const client = connectApprovals(composed, approvals);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = (await client.call("sessions.create", {})).result?.session;
    const started = await client.call("runs.start", {
      sessionId: session?.sessionId as string,
      submissionId: nextId("sub"),
      text: "go",
    });
    const runId = started.result?.run.runId as string;
    await waitFor(() => approvals.length === 1, "the approval request");

    // The shutdown resolves — the wait it must break is broken immediately —
    // and it does not dispatch anything on its way out.
    await composed.host.shutdown();
    await flush();
    expect(counter.executions).toEqual([]);

    // What the run settled as is a durable fact, and a fresh host on the same
    // store is how a test reads one: the cancellation the shutdown asked for,
    // never a completion nobody performed.
    const restarted = await composeTestHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [testPlugin({ id: "tools", tools: [countingTool().tool] })],
      location,
    });
    open.push(restarted);
    const record = restarted.repository.getRun(runId);
    expect(record?.status).toBe("cancelled");
  });

  it("does not ask a client that cannot answer, and expires the approval instead", async () => {
    const clock = testClock();
    const counter = countingTool();
    const { client, approvals, runId, composed } = await runToApproval({
      tool: counter.tool,
      policy: namePolicy({ requireApproval: ["counter"] }),
      reverseRequests: false,
      clock,
    });
    await flush();

    // A client that never declared the capability is never asked; the approval
    // stays pending until its deadline, and nothing runs.
    expect(approvals).toEqual([]);
    await clock.advance(120_000);
    expect((await terminalOf(client, runId)).status).toBe("completed");
    expect(counter.executions).toEqual([]);
    expect(composed).toBeDefined();
  });
});
