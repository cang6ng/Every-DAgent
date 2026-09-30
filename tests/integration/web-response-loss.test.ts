/**
 * Acceptance H over the web binding.
 *
 * The same scenarios the memory carrier proves, except the frames really travel
 * over HTTP and a streamed response — and the one frame that is lost is dropped
 * at the client's edge, by a wrapper the test owns. The binding itself is
 * untouched: this is a lossy network, not a lossy implementation.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { ProtocolChannel, ProtocolChannelListener } from "@every-dagent/protocol";
import { connectHttpChannel, startHttpBinding, type HttpBinding } from "@every-dagent/web";

import { createClient } from "@every-dagent/client";

import { createHostPlatform, waitFor } from "../helpers/platform.js";
import { demoPlugin, scriptedModel, textReply, toolReply } from "../helpers/demo-fixtures.js";

const PLUGIN_ID = "web-loss-plugin";
const TOOL_NAME = "web-loss-tool";
const SUBMISSION = "sub-web-loss";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

/**
 * A channel whose downstream drops the first frame a predicate selects.
 *
 * Everything else still crosses the real transport; this is the delivery that
 * never happens, applied where a lossy network would apply it.
 */
function dropping(
  source: () => Promise<ProtocolChannel>,
  drop: (frame: string) => boolean,
  sent: string[],
): () => Promise<ProtocolChannel> {
  return async (): Promise<ProtocolChannel> => {
    const inner = await source();
    return {
      send: (frame: string): void => {
        sent.push(frame);
        inner.send(frame);
      },
      listen: (listener: ProtocolChannelListener): (() => void) =>
        inner.listen({
          onFrame: (frame: string): void => {
            // The predicate decides, including whether it has already had its
            // one loss: a reconnected channel is a new channel, but the *loss*
            // this test is about happened once.
            if (drop(frame)) return;
            listener.onFrame(frame);
          },
          onClose: (): void => listener.onClose(),
        }),
      close: (): void => inner.close(),
    };
  };
}

async function webPlatform(drop?: (frame: string) => boolean): Promise<{
  readonly platform: ReturnType<typeof createHostPlatform>;
  readonly binding: HttpBinding;
  readonly demo: ReturnType<typeof demoPlugin>;
  readonly client: ReturnType<typeof createClient>;
  readonly sent: readonly string[];
}> {
  const demo = demoPlugin(PLUGIN_ID, TOOL_NAME, "tool answered");
  const model = scriptedModel([
    toolReply("call-1", TOOL_NAME, {}),
    textReply("all done"),
    textReply("unused"),
    textReply("unused again"),
  ]);

  let binding: HttpBinding | undefined;
  const platform = createHostPlatform({
    modelClient: model.client,
    plugins: [demo.plugin],
    source: async () => {
      if (binding === undefined) throw new Error("the binding is not up yet");
      const channel = await connectHttpChannel({ origin: binding.origin });
      return channel;
    },
  });

  binding = await startHttpBinding({ onConnection: (channel) => platform.host.attach(channel) });
  open.push(binding);

  const sent: string[] = [];
  const connector = (): Promise<ProtocolChannel> => platform.connect();
  const client = createClient({
    connect: drop === undefined ? connector : dropping(connector, drop, sent),
  });

  return { platform, binding, demo, client, sent };
}

describe("a lost runs.start answer over the web binding", () => {
  it("is recovered by submission id, with the work done exactly once", async () => {
    // The response to this submission's start never reaches the client; every
    // other frame crosses normally.
    let dropped = false;
    const fixture = await webPlatform((frame) => {
      if (dropped) return false;
      // Exactly the response to that submission's `runs.start`: a snapshot that
      // happens to mention the run is not the frame whose loss this test is
      // about, and dropping it would test a stalled bootstrap instead.
      const isTheStartAnswer =
        frame.includes('"kind":"host-response"') &&
        frame.includes('"result":{"run":') &&
        frame.includes(`"submissionId":"${SUBMISSION}"`);
      if (isTheStartAnswer) dropped = true;
      return isTheStartAnswer;
    });
    const { client, platform, sent } = fixture;
    let observerHasRun = false;

    await client.connect();
    const session = (await client.sessions.create()).session;
    await client.plugins.enable({ pluginId: PLUGIN_ID });

    const lost = client
      .runs.start({ sessionId: session.sessionId, submissionId: SUBMISSION, text: "run this once" })
      .then(() => "answered", (error: unknown) => error);

    // A second connection asks the host directly: the request arrived and was
    // accepted, even though the client that sent it heard nothing back.
    const observer = createClient({ connect: () => platform.connect() });
    await observer.connect();
    for (let attempt = 0; attempt < 200 && !observerHasRun; attempt += 1) {
      observerHasRun = await observer
        .runs.get({ submissionId: SUBMISSION })
        .then(() => true)
        .catch(() => false);
      if (!observerHasRun) {
        await new Promise((resolve) => {
          setTimeout(resolve, 2);
        });
      }
    }
    expect(observerHasRun).toBe(true);

    await client.reconnect();

    const recovered = await client.runs.get({ submissionId: SUBMISSION });
    await waitFor(
      () =>
        client
          .getSnapshot()
          .presentation?.runs.some((run) => run.runId === recovered.run.runId && run.live === null) === true,
      { what: "the recovered run to settle" },
    );

    // Exactly one start left this client, and it was not sent again for the
    // answer it never heard.
    expect(sent.filter((frame) => frame.includes('"runs.start"'))).toHaveLength(1);

    const outcome = await lost;
    expect(outcome).toMatchObject({ code: "CONNECTION_LOST", outcome: "unknown" });
    expect(fixture.demo.executions).toHaveLength(1);
    expect(client.getSnapshot().presentation?.runs).toHaveLength(1);

    const again = await client.runs.start({
      sessionId: session.sessionId,
      submissionId: SUBMISSION,
      text: "run this once",
    });
    expect(again.run.runId).toBe(recovered.run.runId);
    expect(fixture.demo.executions).toHaveLength(1);

    await expect(
      client.runs.start({ sessionId: session.sessionId, submissionId: SUBMISSION, text: "different words" }),
    ).rejects.toMatchObject({ code: "SUBMISSION_CONFLICT" });
    expect(fixture.demo.executions).toHaveLength(1);

    await platform.shutdown();
  }, 30000);

  it("keeps the run alive while the client is away, and the outcome is unknown", async () => {
    const fixture = await webPlatform();
    const { client, platform } = fixture;
    await client.connect();

    const session = (await client.sessions.create()).session;
    const started = await client.runs.start({
      sessionId: session.sessionId,
      submissionId: "sub-web-away",
      text: "keep going without me",
    });
    await waitFor(
      () => client.getSnapshot().presentation?.runs.some((run) => run.runId === started.run.runId) === true,
      { what: "the run to be announced" },
    );

    client.disconnect();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    await client.reconnect();
    await waitFor(
      () =>
        client
          .getSnapshot()
          .presentation?.runs.some((run) => run.runId === started.run.runId && run.live === null) === true,
      { what: "the finished run to appear after reconnecting" },
    );

    expect(
      client.getSnapshot().presentation?.runs.find((run) => run.runId === started.run.runId)?.status,
    ).toBe("completed");
    await platform.shutdown();
  });

  it("does not carry a submission's outcome onto a different host", async () => {
    const first = await webPlatform();
    await first.client.connect();
    const session = (await first.client.sessions.create()).session;
    await first.client.runs.start({
      sessionId: session.sessionId,
      submissionId: "sub-web-old",
      text: "the first host's work",
    });
    await waitFor(() => first.client.getSnapshot().presentation?.runs.length === 1, { what: "the run" });

    const second = await webPlatform();
    await second.client.connect();

    expect(second.client.getSnapshot().description?.hostInstanceId).not.toBe(
      first.client.getSnapshot().description?.hostInstanceId,
    );
    await expect(second.client.runs.get({ submissionId: "sub-web-old" })).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
    });
    expect(second.client.getSnapshot().presentation?.runs).toHaveLength(0);

    await first.platform.shutdown();
    await second.platform.shutdown();
  });
});
