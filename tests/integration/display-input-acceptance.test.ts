/**
 * Acceptance J at the Host → Client boundary: what happens to a tool input the
 * durable JSON profile cannot carry.
 *
 * v2 answers this before anything depends on it. Every case here is a value
 * JSON cannot carry: `undefined`, a bigint, a non-finite number, a function, a
 * sparse array, a `Date`, a `Map`, a class instance, a cycle, and an object with
 * its own `toJSON`. For each of them the managed execution refuses the model
 * step it arrived in — before the tool is dispatched, before an assistant record
 * is written, before any canonical tool call exists — so the tool count is zero
 * and nothing is fabricated to stand in for the call. A refused step is also
 * not *read*: the guard never invokes an accessor or a `toJSON` to decide.
 *
 * The JSON-safe case is the other half: the projection is a complete deep
 * snapshot, later edits to the original do not reach through it, and the tool
 * still receives the object the model produced.
 */

import type { CanonicalItem } from "@every-dagent/protocol";
import { createClient } from "@every-dagent/client";
import { afterEach, describe, expect, it } from "vitest";

import { createHostPlatform, runSettled, waitFor } from "../helpers/platform.js";
import { demoPlugin, scriptedModel, textReply, toolReply } from "../helpers/demo-fixtures.js";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

interface Case {
  readonly name: string;
  readonly value: unknown;
}

function circular(): unknown {
  const node: Record<string, unknown> = { name: "loop" };
  node["self"] = node;
  return node;
}

const UNSHOWABLE: readonly Case[] = [
  { name: "undefined", value: undefined },
  { name: "bigint", value: 12345678901234567890n },
  { name: "NaN", value: Number.NaN },
  { name: "Infinity", value: Number.POSITIVE_INFINITY },
  { name: "a function", value: () => "not json" },
  // eslint-disable-next-line no-sparse-arrays
  { name: "a sparse array", value: [1, , 3] },
  { name: "a Date", value: new Date(0) },
  { name: "a Map", value: new Map([["k", "v"]]) },
  { name: "a class instance", value: new (class Point { readonly x = 1 })() },
  { name: "a cycle", value: circular() },
  { name: "a custom toJSON", value: { toJSON: (): string => "rewritten" } },
];

async function runWithInput(input: unknown): Promise<{
  readonly canonical: readonly CanonicalItem[];
  readonly executions: number;
  readonly received: unknown;
  readonly status: string;
}> {
  const fixture = demoPlugin("echo", "echo", "echo answered");
  // The model repeats the same refused step — three scripted attempts, which is
  // exactly what the loop's retry budget spends — so the turn ends as a model
  // failure, deterministically, with no valid step to hide it.
  const refusedStep = async function* (): AsyncGenerator<{ readonly type: "tool-call"; readonly call: { readonly callId: string; readonly name: string; readonly input: unknown } } | { readonly type: "done" }> {
    yield { type: "tool-call", call: { callId: "call-1", name: "echo", input } };
    yield { type: "done" };
  };
  const model = scriptedModel([refusedStep, refusedStep, refusedStep]);
  const platform = createHostPlatform({ modelClient: model.client, plugins: [fixture.plugin] });
  open.push({ close: () => platform.shutdown() });

  const client = createClient({ connect: () => platform.connect() });
  await client.connect();
  await client.plugins.enable({ pluginId: "echo" });
  const { session } = await client.sessions.create();
  const started = await client.runs.start({
    sessionId: session.sessionId,
    submissionId: `sub-${fixture.executions.length}-${String(input)}`,
    text: "use the tool",
  });

  await waitFor(() => runSettled(client.getSnapshot(), started.run.runId), { what: "the run to settle" });
  const canonical = (await client.sessions.history({ sessionId: session.sessionId })).page.items;
  const run = await client.runs.get({ runId: started.run.runId });
  client.disconnect();

  return {
    canonical,
    executions: fixture.executions.length,
    received: fixture.executions[0]?.input,
    status: run.run.status,
  };
}

describe("a tool input the wire cannot carry", () => {
  it.each(UNSHOWABLE)("refuses $name before the tool can run", async (testCase) => {
    const outcome = await runWithInput(testCase.value);

    // The step was refused, so nothing was dispatched and nothing was invented
    // to stand in for the call that never became canonical.
    expect(outcome.executions).toBe(0);
    expect(outcome.received).toBeUndefined();
    expect(outcome.canonical.some((item) => item.kind === "tool-call")).toBe(false);
    expect(outcome.canonical.some((item) => item.kind === "tool-result")).toBe(false);
    expect(outcome.canonical.some((item) => item.kind === "assistant")).toBe(false);
    // And the run says so honestly instead of completing on a step it refused.
    expect(outcome.status).toBe("failed");
  });
});

describe("a tool input the wire can carry", () => {
  it("is a complete deep snapshot that later edits cannot reach", async () => {
    const original: { readonly payload: { readonly items: number[] } } = { payload: { items: [1, 2, 3] } };

    const fixture = demoPlugin("echo", "echo", "echo answered");
    const model = scriptedModel([toolReply("call-1", "echo", original), textReply("done")]);
    const platform = createHostPlatform({ modelClient: model.client, plugins: [fixture.plugin] });
    open.push({ close: () => platform.shutdown() });

    const client = createClient({ connect: () => platform.connect() });
    await client.connect();
    await client.plugins.enable({ pluginId: "echo" });
    const { session } = await client.sessions.create();
    const started = await client.runs.start({
      sessionId: session.sessionId,
      submissionId: "sub-snapshot",
      text: "use the tool",
    });

    await waitFor(() => runSettled(client.getSnapshot(), started.run.runId), { what: "the run to settle" });

    // The tool really received the original object.
    expect(fixture.executions[0]?.input).toBe(original);

    // Edit the original after publication: what the client holds must not move.
    (original.payload.items as number[]).push(4);

    const committed = (await client.sessions.history({ sessionId: session.sessionId })).page.items;
    const call = committed.find((item) => item.kind === "tool-call");
    expect(call).toMatchObject({ kind: "tool-call", input: { kind: "json", value: { payload: { items: [1, 2, 3] } } } });
    client.disconnect();
  });
});
