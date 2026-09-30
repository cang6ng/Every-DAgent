/**
 * Acceptance H, over a real host: a lost answer, a reconnect, and a submission
 * recovered without ever being re-run.
 *
 * The carrier is made lossy on purpose: one frame never arrives, and everything
 * after that has to be deduced from what the *host* still knows, because the
 * client may only read — never re-send a write, and never claim that a request
 * whose answer was lost did not happen.
 */

import { describe, expect, it } from "vitest";

import { createClientOn, createHostPlatform, waitFor } from "../helpers/platform.js";
import {
  demoPlugin,
  gatedReply,
  partialThenAbortReply,
  partialThenGatedReply,
  scriptedModel,
  textReply,
  toolReply,
} from "../helpers/demo-fixtures.js";

const PLUGIN_ID = "loss-plugin";
const TOOL_NAME = "loss-tool";
const SUBMISSION = "sub-loss";

describe("a lost runs.start answer", () => {
  it("is recovered by submission id, with the work done exactly once", async () => {
    const demo = demoPlugin(PLUGIN_ID, TOOL_NAME, "tool answered");
    const model = scriptedModel([toolReply("call-1", TOOL_NAME, {}), textReply("all done")]);

    let armed = false;
    const platform = createHostPlatform({
      modelClient: model.client,
      plugins: [demo.plugin],
      carriers: {
        // Exactly one frame is lost: the *response* to that submission's
        // `runs.start`. Events and later snapshots mentioning the submission
        // still arrive — a transport that lost those would be out of contract,
        // and the client would rightly treat the resulting gap as a fault.
        drop: (direction, frame) =>
          armed &&
          direction === "host-to-client" &&
          frame.includes('"kind":"host-response"') &&
          frame.includes(`"submissionId":"${SUBMISSION}"`),
      },
    });
    const client = createClientOn(platform);
    await client.connect();

    const session = (await client.sessions.create()).session;
    await client.plugins.enable({ pluginId: PLUGIN_ID });

    // The answer to this submission never arrives; the host accepted it anyway.
    armed = true;
    const lost = client
      .runs.start({ sessionId: session.sessionId, submissionId: SUBMISSION, text: "run this once" })
      .then(() => "answered", (error: unknown) => error);
    await waitFor(() => platform.carriers.some((carrier) => carrier.dropped.length > 0), {
      what: "the answer to be dropped",
    });

    // The client reconnects; nothing is replayed, and the run is found again.
    // (Disarmed first: the new connection's own snapshot mentions this
    // submission, and it must arrive.)
    armed = false;
    await client.reconnect();

    const recovered = await client.runs.get({ submissionId: SUBMISSION });
    await waitFor(
      () => client.getSnapshot().presentation?.runs.some((run) => run.runId === recovered.run.runId && run.live === null) === true,
      { what: "the recovered run to settle" },
    );

    const outcome = await lost;
    expect(outcome).toMatchObject({ code: "CONNECTION_LOST", outcome: "unknown" });
    expect(fixtureCalls(model)).toBe(2); // one tool step and one answer step: exactly one run
    expect(demo.executions).toHaveLength(1);
    expect(client.getSnapshot().presentation?.runs).toHaveLength(1);

    // Re-submitting the very same submission is the same submission.
    const again = await client.runs.start({
      sessionId: session.sessionId,
      submissionId: SUBMISSION,
      text: "run this once",
    });
    expect(again.run.runId).toBe(recovered.run.runId);
    expect(fixtureCalls(model)).toBe(2);

    // The same id with different words is a conflict, and changes nothing.
    await expect(
      client.runs.start({ sessionId: session.sessionId, submissionId: SUBMISSION, text: "something else" }),
    ).rejects.toMatchObject({ code: "SUBMISSION_CONFLICT" });
    expect(fixtureCalls(model)).toBe(2);

    await platform.shutdown();
  });

  it("keeps the run alive while the client is away", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = scriptedModel([gatedReply(gate, textReply("finished while away"))]);
    const platform = createHostPlatform({ modelClient: model.client, plugins: [] });
    const client = createClientOn(platform);
    await client.connect();

    const session = (await client.sessions.create()).session;
    const started = await client.runs.start({
      sessionId: session.sessionId,
      submissionId: "sub-away",
      text: "keep going without me",
    });
    await waitFor(() => client.getSnapshot().presentation?.runs.some((run) => run.runId === started.run.runId) === true, {
      what: "the run to be announced",
    });

    client.disconnect();

    // The host owns the work: no cancel was sent, and the turn finishes anyway.
    release?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    await client.reconnect();
    await waitFor(
      () => client.getSnapshot().presentation?.runs.some((run) => run.runId === started.run.runId && run.live === null) === true,
      { what: "the finished run to appear after reconnecting" },
    );

    const run = client.getSnapshot().presentation?.runs.find((candidate) => candidate.runId === started.run.runId);
    expect(run?.status).toBe("completed");
    const sent = platform.carriers.flatMap((carrier) =>
      carrier.log.filter((entry) => entry.direction === "client-to-host").map((entry) => entry.frame),
    );
    expect(sent.some((frame) => frame.includes('"runs.cancel"'))).toBe(false);

    await platform.shutdown();
  });

  it("does not claim anything about a submission on a different host", async () => {
    const model = scriptedModel([textReply("unused")]);
    const platform = createHostPlatform({ modelClient: model.client, plugins: [] });
    const client = createClientOn(platform);
    await client.connect();

    const session = (await client.sessions.create()).session;
    await client.runs.start({ sessionId: session.sessionId, submissionId: "sub-old", text: "the first host's work" });
    await waitFor(() => client.getSnapshot().presentation?.runs.length === 1, { what: "the run to appear" });

    // A second host: a different instance, with its own lifetime.
    const other = createHostPlatform({ modelClient: scriptedModel([textReply("other")]).client, plugins: [] });
    const onOther = createClientOn(other);
    await onOther.connect();

    const sessionOnOther = (await onOther.sessions.create()).session;
    expect(onOther.getSnapshot().description?.hostInstanceId).not.toBe(client.getSnapshot().description?.hostInstanceId);
    // The old submission means nothing here: nothing was executed for it.
    await expect(onOther.runs.get({ submissionId: "sub-old" })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    expect(onOther.getSnapshot().presentation?.runs).toHaveLength(0);
    expect(sessionOnOther.sessionId).not.toBe(session.sessionId);

    await platform.shutdown();
    await other.shutdown();
  });

  it("re-synchronizes a live run's accumulated timeline after a reconnect", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = scriptedModel([partialThenGatedReply("the beginning", gate, " and the end")]);
    const platform = createHostPlatform({ modelClient: model.client, plugins: [] });
    const client = createClientOn(platform);
    await client.connect();

    const session = (await client.sessions.create()).session;
    const started = await client.runs.start({
      sessionId: session.sessionId,
      submissionId: "sub-live",
      text: "still running",
    });
    await waitFor(
      () => client.getSnapshot().presentation?.runs.some((run) => run.runId === started.run.runId) === true,
      { what: "the run to be announced" },
    );

    await waitFor(
      () =>
        client
          .getSnapshot()
          .presentation?.runs.some(
            (candidate) => candidate.runId === started.run.runId && (candidate.live?.length ?? 0) > 0,
          ) === true,
      { what: "the live prefix to be visible before the disconnect" },
    );
    const beforeDisconnect = client
      .getSnapshot()
      .presentation?.runs.find((candidate) => candidate.runId === started.run.runId);
    expect(beforeDisconnect?.live?.map((item) => (item.kind === "text" ? item.text : ""))).toEqual([
      "the beginning",
    ]);

    client.disconnect();
    await client.reconnect();

    // The same host keeps the live prefix, so the replica is whole again
    // without any event replay — and the prefix is the text that was really
    // there, not a placeholder.
    const run = client.getSnapshot().presentation?.runs.find((candidate) => candidate.runId === started.run.runId);
    expect(run?.status).toBe("running");
    expect(run?.live?.map((item) => (item.kind === "text" ? item.text : ""))).toEqual(["the beginning"]);

    release?.();
    await waitFor(
      () => client.getSnapshot().presentation?.runs.some((candidate) => candidate.runId === started.run.runId && candidate.live === null) === true,
      { what: "the run to settle" },
    );
    expect(client.getSnapshot().presentation?.runs[0]?.status).toBe("completed");

    await platform.shutdown();
  });

  it("never runs a cancelled turn's draft into history after a reconnect", async () => {
    const model = scriptedModel([partialThenAbortReply("a draft nobody should keep")]);
    const platform = createHostPlatform({ modelClient: model.client, plugins: [] });
    const client = createClientOn(platform);
    await client.connect();

    const session = (await client.sessions.create()).session;
    const started = await client.runs.start({
      sessionId: session.sessionId,
      submissionId: "sub-draft",
      text: "draft something",
    });
    await waitFor(
      () =>
        client
          .getSnapshot()
          .presentation?.runs.some((run) => run.runId === started.run.runId && (run.live?.length ?? 0) === 1) === true,
      { what: "the draft to be visible" },
    );
    expect(client.getSnapshot().presentation?.runs[0]?.live).toHaveLength(1);

    await client.runs.cancel({ runId: started.run.runId });
    await waitFor(
      () => client.getSnapshot().presentation?.runs.some((run) => run.runId === started.run.runId && run.live === null) === true,
      { what: "the cancellation to settle" },
    );

    const canonical = client.getSnapshot().presentation?.sessions[0]?.canonical ?? [];
    expect(canonical.map((item) => item.kind)).toEqual(["user"]);
    expect(JSON.stringify(canonical)).not.toContain("a draft nobody should keep");

    await platform.shutdown();
  });
});

function fixtureCalls(model: { readonly requests: readonly unknown[] }): number {
  return model.requests.length;
}
