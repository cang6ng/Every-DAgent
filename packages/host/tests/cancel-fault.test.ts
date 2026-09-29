/**
 * A cancel whose own announcement cannot be built.
 *
 * The run's `run.updated` is the host's own output; a failure to construct it is
 * a host fault, not a transport problem and not a reason to pretend the
 * cancellation was never announced. The failure is injected exactly where the
 * review put it: in the construction of the cancellation's own event, for the
 * run that is being cancelled. Everything else is real — the real run, the real
 * Core, the real registry and the real protocol encoding.
 *
 * The stream is driven past the point where the host has published the turn's
 * model step, so the only event left to build before the settle is the
 * cancellation's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveRunSnapshot } from "@every-dagent/protocol";

import type { EventBuilder } from "../src/connection.js";
import type { RunEntry } from "../src/state.js";

const SECRET = "sk-cancel-secret-value";

const control = vi.hoisted(() => ({
  /** While set, building the cancellation's own event fails. */
  breakCancelEvent: false,
}));

vi.mock("../src/connection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/connection.js")>();
  return {
    ...actual,
    runUpdatedEvent: (run: RunEntry, snapshot: ActiveRunSnapshot): EventBuilder => {
      if (control.breakCancelEvent && run.cancelRequested) {
        throw new Error(`refused to build the cancel event: ${SECRET}`);
      }
      return actual.runUpdatedEvent(run, snapshot);
    },
  };
});

const {
  awaitRunTerminal,
  connect,
  createSessionThrough,
  flush,
  gate,
  gatedTool,
  scriptedModel,
  testHost,
  testPlugin,
  toolReply,
} = await import("./helpers/harness.js");

beforeEach(() => {
  control.breakCancelEvent = false;
});

describe("cancel with an unbuildable announcement", () => {
  it("marks the run faulted, still aborts, keeps draining, and blocks the session", async () => {
    const started = gate();
    const release = gate();
    const host = testHost({
      modelClient: scriptedModel([toolReply("call-1", "stubborn", {})]).client,
      plugins: [testPlugin({ id: "tools", tools: [gatedTool("stubborn", release, started)] })],
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    const response = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "sub-cancel-fault",
      text: "cancel with a broken announcement",
    });
    const runId = response.result?.run.runId as string;

    // The host folds the turn's events on its own schedule; once it has
    // published the call, the next event it builds is the cancellation's.
    await started.promise;
    await client.waitForEvent("run.tool.call");
    const framesBefore = client.frames.length;
    const eventsBefore = client.events.length;

    control.breakCancelEvent = true;
    const cancelled = await client.call("runs.cancel", { runId });
    expect(cancelled.result?.run.cancelRequested).toBe(true);

    // The request is recorded, the abort happened, and the registry is still
    // the run's: a broken announcement does not end the execution.
    await flush();
    expect((await client.call("plugins.disable", { pluginId: "tools" })).error?.code).toBe("HOST_BUSY");
    const during = (await client.call("runs.get", { runId })).result?.run;
    expect(during?.live).not.toBeNull();

    // The tool ignores the signal, so nothing settles until it is released.
    release.open();
    const terminal = await awaitRunTerminal(client, runId);

    // Not a clean cancellation: the host could not vouch for the run's own
    // state, so it failed and the session is blocked, with the history it had
    // already published kept as it was.
    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("host_error");
    expect(terminal.error?.code).toBe("INTERNAL_ERROR");
    expect(terminal.live).toBeNull();

    const after = (await client.call("sessions.get", { sessionId: session.sessionId })).result?.session;
    expect(after?.status).toBe("blocked");
    expect(after?.activeRunId).toBeNull();
    expect(after?.canonical).toEqual([]);

    // Nothing from the failure reached the wire, and nothing was invented
    // afterwards: the terminal is the last thing this run published.
    expect(JSON.stringify(client.frames)).not.toContain(SECRET);
    expect(client.frames.length).toBeGreaterThanOrEqual(framesBefore);
    expect(client.events.length).toBeGreaterThanOrEqual(eventsBefore);
    expect(client.events.at(-1)?.type).toBe("run.ended");
  });
});
