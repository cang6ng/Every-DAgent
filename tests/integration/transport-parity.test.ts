/**
 * One client, two carriers, the same walk.
 *
 * The parity tests run the identical `runClientCli` scenario over the memory
 * carrier and over the web binding, and assert the same facts about both — so a
 * client that only worked when frames crossed inside one process, or only when
 * they crossed a socket, could not pass. It is also acceptance fixture B: a
 * second, react-free client, reaching the host only through the protocol.
 */

import { afterEach, describe, expect, it } from "vitest";

import { createClient } from "@every-dagent/client";
import { connectHttpChannel, startHttpBinding, type HttpBinding } from "@every-dagent/web";

import { createClientOn, createHostPlatform, runSettled, waitFor } from "../helpers/platform.js";
import {
  demoPlugin,
  partialThenAbortReply,
  scriptedModel,
  textReply,
  toolReply,
} from "../helpers/demo-fixtures.js";
import { runClientCli, type ClientCliReport } from "../fixtures/client-cli.js";

const PLUGIN_ID = "cli-plugin";
const TOOL_NAME = "cli-tool";
const TOOL_ANSWER = "tool answered";
const ANSWER = `the tool said: ${TOOL_ANSWER}`;

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

async function scenario() {
  const demo = demoPlugin(PLUGIN_ID, TOOL_NAME, TOOL_ANSWER);
  const model = scriptedModel([
    toolReply("call-1", TOOL_NAME, { value: "from-the-model" }),
    textReply(ANSWER),
    partialThenAbortReply("a draft that must not survive"),
  ]);
  const platform = await createHostPlatform({ modelClient: model.client, plugins: [demo.plugin] });
  return {
    demo,
    model,
    platform,
    cli: (): Promise<ClientCliReport> =>
      runClientCli({
        connect: () => platform.connect(),
        pluginId: PLUGIN_ID,
        toolName: TOOL_NAME,
        toolCallText: "please use the tool",
        answerText: ANSWER,
        cancelText: "start something and cancel it",
        submissionPrefix: "cli",
        client: { name: "cli-fixture", version: "1.0.0" },
      }),
  };
}

/** The web carrier: a real socket, the real binding, the real client channel. */
async function webScenario() {
  const demo = demoPlugin(PLUGIN_ID, TOOL_NAME, TOOL_ANSWER);
  const model = scriptedModel([
    toolReply("call-1", TOOL_NAME, { value: "from-the-model" }),
    textReply(ANSWER),
    partialThenAbortReply("a draft that must not survive"),
  ]);
  const bindingRef: { current: HttpBinding | undefined } = { current: undefined };
  const platform = await createHostPlatform({
    modelClient: model.client,
    plugins: [demo.plugin],
    source: async () => {
      const binding = bindingRef.current;
      if (binding === undefined) throw new Error("the binding is not up yet");
      return connectHttpChannel({ origin: binding.origin });
    },
  });

  return {
    demo,
    model,
    platform,
    start: async (): Promise<HttpBinding> => {
      const binding = await startHttpBinding({ onConnection: (channel) => platform.host.attach(channel) });
      bindingRef.current = binding;
      open.push(binding);
      return binding;
    },
    cli: (): Promise<ClientCliReport> =>
      runClientCli({
        connect: () => platform.connect(),
        pluginId: PLUGIN_ID,
        toolName: TOOL_NAME,
        toolCallText: "please use the tool",
        answerText: ANSWER,
        cancelText: "start something and cancel it",
        submissionPrefix: "web",
        client: { name: "cli-fixture", version: "1.0.0" },
      }),
  };
}

/** Everything both carriers must show, whatever carries the frames. */
function expectSameWalk(report: ClientCliReport): void {
  expect(report.description?.protocolVersion).toBe("2");
  expect(report.description?.capabilities.reverseRequests).toBe(true);
  expect(report.createdReturnedToCaller).toBe(true);
  expect(report.listedContainsCreated).toBe(true);
  expect(report.storeAgreesWithHostList).toBe(true);
  expect(report.pluginStatusAfterEnable).toBe("enabled");
  expect(report.runStatus).toBe("completed");
  expect(report.runEndReason).toBe("completed");
  expect(report.toolCallNames).toEqual([TOOL_NAME]);
  expect(report.toolResultCount).toBe(1);
  expect(report.liveItemCountDuringRun).toBeGreaterThan(0);
  expect(report.cancelOutcome.responseCancelRequested).toBe(true);
  expect(report.cancelOutcome.responseStatus).toBe("running");
  expect(report.cancelOutcome.terminalStatus).toBe("cancelled");
  expect(report.cancelOutcome.draftGoneAfterTerminal).toBe(true);
  expect(report.sessionReadMatchesStore).toBe(true);
  expect(report.afterDisconnect.status).toBe("disconnected");
  expect(report.afterDisconnect.stale).toBe(true);
  expect(report.afterReconnect.status).toBe("ready");
  expect(report.afterReconnect.sessionIds).toEqual([report.createdSessionId]);
  expect(report.canonicalFinal.map((item) => item.kind)).toEqual([
    "user",
    "assistant",
    "tool-call",
    "tool-result",
    "assistant",
    "user",
  ]);
}

describe("the same client on both carriers", () => {
  it("walks the same scenario over the memory carrier", async () => {
    const fixture = await scenario();
    const report = await fixture.cli();

    expectSameWalk(report);
    expect(fixture.demo.executions).toHaveLength(1);
    expect(fixture.model.requests).toHaveLength(3);
    await fixture.platform.shutdown();
  });

  it("walks the same scenario over the web binding", async () => {
    const fixture = await webScenario();
    await fixture.start();
    const report = await fixture.cli();

    expectSameWalk(report);
    expect(fixture.demo.executions).toHaveLength(1);
    expect(fixture.model.requests).toHaveLength(3);
    await fixture.platform.shutdown();
  });
});

describe("a client can move between carriers", () => {
  it("reconnects a single client over a different carrier and finds the same host", async () => {
    const model = scriptedModel([textReply("the answer")]);
    const platform = await createHostPlatform({ modelClient: model.client, plugins: [] });
    const binding = await startHttpBinding({ onConnection: (channel) => platform.host.attach(channel) });
    open.push(binding);

    // One client, whose connector hands out a memory channel first and a real
    // socket second. Nothing in the client core can tell the difference.
    let attempts = 0;
    const client = createClient({
      connect: () => {
        attempts += 1;
        return attempts === 1
          ? platform.connect()
          : connectHttpChannel({ origin: binding.origin });
      },
    });

    await client.connect();
    const firstHost = client.getSnapshot().description?.hostInstanceId;
    const session = (await client.sessions.create()).session;
    const started = await client.runs.start({ sessionId: session.sessionId, submissionId: "sub-carrier", text: "over memory" });
    await waitFor(() => runSettled(client.getSnapshot(), started.run.runId), { what: "the run over memory" });

    await client.reconnect();

    expect(attempts).toBe(2);
    expect(client.getSnapshot().status).toBe("ready");
    expect(client.getSnapshot().description?.hostInstanceId).toBe(firstHost);
    expect(client.getSnapshot().presentation?.sessions.items.map((item) => item.sessionId)).toEqual([session.sessionId]);
    expect(client.getSnapshot().presentation?.runs.items[0]?.status).toBe("completed");

    await platform.shutdown();
  });
});
