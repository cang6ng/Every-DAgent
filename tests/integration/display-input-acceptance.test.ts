/**
 * Acceptance J at the Host → Client boundary: what a tool input looks like
 * when it cannot be shown, and what it must not cost.
 *
 * Every case here is a value JSON cannot carry: `undefined`, a bigint, a
 * non-finite number, a function, a sparse array, a `Date`, a `Map`, a class
 * instance, a cycle, and an object with its own `toJSON`. For each of them the
 * published projection must be an honest `unavailable` — not a subset, not a
 * cleaned-up copy, not the output of the user's `toJSON` — while the real tool
 * receives the original value, unchanged and exactly once. The JSON-safe case
 * is the other half: the projection is a complete deep snapshot, and later
 * edits to the original do not reach through it.
 */

import type { JsonValue } from "@every-dagent/protocol";
import { createClient } from "@every-dagent/client";
import { afterEach, describe, expect, it } from "vitest";

import { createHostPlatform, waitFor } from "../helpers/platform.js";
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
  { name: "a custom toJSON", value: { toJSON: (): JsonValue => "rewritten" } },
];

async function runWithInput(input: unknown): Promise<{
  readonly projection: { readonly kind: string; readonly value?: unknown; readonly reason?: unknown } | null;
  readonly received: unknown;
  readonly executions: number;
}> {
  const fixture = demoPlugin("echo", "echo", "echo answered");
  const model = scriptedModel([toolReply("call-1", "echo", input), textReply("done")]);
  const platform = createHostPlatform({ modelClient: model.client, plugins: [fixture.plugin] });
  open.push({ close: () => platform.shutdown() });

  const client = createClient({ connect: () => platform.connect() });
  await client.connect();
  await client.plugins.enable({ pluginId: "echo" });
  const { session } = await client.sessions.create();
  await client.runs.start({ sessionId: session.sessionId, submissionId: `sub-${fixture.executions.length}`, text: "use the tool" });

  await waitFor(
    () => client.getSnapshot().presentation?.sessions[0]?.canonical.some((item) => item.kind === "tool-call") === true,
    { what: "the canonical tool call" },
  );
  const canonical = client.getSnapshot().presentation?.sessions[0]?.canonical ?? [];
  const call = canonical.find((item) => item.kind === "tool-call");
  const projection =
    call !== undefined && call.kind === "tool-call"
      ? (call.input as { kind: string; value?: unknown; reason?: unknown })
      : null;
  client.disconnect();

  return {
    projection,
    received: fixture.executions[0]?.input,
    executions: fixture.executions.length,
  };
}

describe("a tool input the wire cannot carry", () => {
  it.each(UNSHOWABLE)("projects $name as unavailable, and the real tool still gets it", async (testCase) => {
    const outcome = await runWithInput(testCase.value);

    expect(outcome.projection).toEqual({ kind: "unavailable", reason: "not-json-safe" });
    // The tool received the original value — the same reference — exactly once.
    expect(outcome.executions).toBe(1);
    expect(outcome.received).toBe(testCase.value);
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
    await client.runs.start({ sessionId: session.sessionId, submissionId: "sub-snapshot", text: "use the tool" });

    await waitFor(
      () => client.getSnapshot().presentation?.sessions[0]?.canonical.some((item) => item.kind === "tool-call") === true,
      { what: "the canonical tool call" },
    );

    // The tool really received the original object.
    expect(fixture.executions[0]?.input).toBe(original);

    // Edit the original after publication: what the client holds must not move.
    (original.payload.items as number[]).push(4);

    const call = (client.getSnapshot().presentation?.sessions[0]?.canonical ?? []).find((item) => item.kind === "tool-call");
    expect(call).toMatchObject({ kind: "tool-call", input: { kind: "json", value: { payload: { items: [1, 2, 3] } } } });
    client.disconnect();
  });
});
