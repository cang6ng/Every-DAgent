/**
 * `turn/end` is not a settled execution.
 *
 * The real Runtime closes its channel right after the turn's last event, so the
 * window between "the turn said it ended" and "the iterator is done" is a couple
 * of microtasks wide and cannot be widened from outside. This file widens it on
 * purpose: the runtime is wrapped — the real one still drives the turn, records
 * the log and reports the outcome — and the wrapper holds the iterator open
 * after its final event. That is the only state in which the host's ownership
 * rule can be observed directly: end observed, nothing settled yet.
 *
 * If the lease were released when `turn/end` arrives, every assertion below
 * would see a free registry and the test would fail.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "@every-dagent/agent-core";

const control = vi.hoisted(() => ({
  /** Opened once the wrapped stream has produced every event, including turn/end. */
  reachedEnd: undefined as { promise: Promise<void>; open(): void } | undefined,
  /** Held after that, so the iterator has not settled. */
  hold: undefined as { promise: Promise<void>; open(): void } | undefined,
}));

vi.mock("@every-dagent/agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@every-dagent/agent-core")>();
  return {
    ...actual,
    createAgentRuntime: (deps: Parameters<typeof actual.createAgentRuntime>[0]) => {
      const runtime = actual.createAgentRuntime(deps);
      return {
        run: (input: Parameters<typeof runtime.run>[0]) => runtime.run(input),
        stream: (input: Parameters<typeof runtime.stream>[0]) => heldStream(runtime.stream(input)),
      };
    },
  };
});

async function* heldStream(inner: AsyncIterable<RuntimeEvent>): AsyncGenerator<RuntimeEvent> {
  for await (const event of inner) yield event;
  // Every event has been handed over — turn/end included — and the execution is
  // still not over.
  control.reachedEnd?.open();
  if (control.hold !== undefined) await control.hold.promise;
}

const { awaitRunTerminal, connect, createSessionThrough, flush, gate, scriptedModel, testHost, testPlugin, textReply } =
  await import("./helpers/harness.js");

beforeEach(() => {
  control.hold = undefined;
  control.reachedEnd = undefined;
});

describe("turn end versus settled execution", () => {
  it("keeps the registry while the turn has ended but the iterator has not", async () => {
    const reachedEnd = gate();
    const hold = gate();
    control.reachedEnd = reachedEnd;
    control.hold = hold;

    const host = testHost({
      modelClient: scriptedModel([textReply("the answer")]).client,
      plugins: [testPlugin({ id: "alpha", tools: [] })],
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    const session = await createSessionThrough(client);
    const other = await createSessionThrough(client);

    const started = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "sub-end-not-settle",
      text: "finish, but do not settle",
    });
    const runId = started.result?.run.runId as string;

    // The host has consumed the turn's last event; the iterator is still open.
    await reachedEnd.promise;
    await flush();

    // Nothing about the turn's ending has given the registry back.
    const secondRun = await client.call("runs.start", {
      sessionId: other.sessionId,
      submissionId: "sub-too-early",
      text: "not yet",
    });
    expect(secondRun.error?.code).toBe("HOST_BUSY");
    expect((await client.call("plugins.enable", { pluginId: "alpha" })).error?.code).toBe("HOST_BUSY");
    expect((await client.call("plugins.disable", { pluginId: "alpha" })).error?.code).toBe("HOST_BUSY");

    // The run is still live, not terminal, for a reader as well.
    const during = (await client.call("runs.get", { runId })).result?.run;
    expect(during?.live).not.toBeNull();

    // Only a real settle frees the next ownership.
    hold.open();
    const terminal = await awaitRunTerminal(client, runId);
    expect(terminal.status).toBe("completed");

    // The refused attempt never claimed its submission id, so the same one is
    // free to use now that the registry is free again.
    const accepted = await client.call("runs.start", {
      sessionId: other.sessionId,
      submissionId: "sub-too-early",
      text: "not yet",
    });
    expect(accepted.result?.run.status).toBe("accepted");
    await awaitRunTerminal(client, accepted.result?.run.runId as string);
  });
});
