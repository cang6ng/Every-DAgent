/**
 * A real client against a real host, over the memory carrier.
 *
 * This is acceptance fixture B — a second, react-free client talking the same
 * protocol — and the memory half of the transport parity: the same
 * `runClientCli` walk is asserted here and again over the web binding, so a
 * client that only worked on one carrier could not pass both.
 */

import { describe, expect, it } from "vitest";

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
    cli: async (): Promise<ClientCliReport> =>
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

describe("the second client over memory", () => {
  it("walks describe, sessions, plugins, a tool run, a cancel and a reconnect", async () => {
    const fixture = await scenario();
    const report = await fixture.cli();

    // Describe: the host's own identity and honest capabilities.
    expect(report.description?.protocolVersion).toBe("2");
    expect(report.description?.capabilities).toMatchObject({
      sessions: true,
      runs: true,
      plugins: true,
      subscriptions: true,
      reverseRequests: true,
    });
    expect(report.readyPresentationSessions).toEqual([]);

    // Sessions: the create answered its caller and never wrote to the store.
    expect(report.createdReturnedToCaller).toBe(true);
    expect(report.listedContainsCreated).toBe(true);
    expect(report.storeAgreesWithHostList).toBe(true);

    // Plugins: enabled through the protocol, reflected back as state.
    expect(report.pluginStatusAfterEnable).toBe("enabled");

    // The run: a real tool call, a real result, an answer built from it.
    expect(report.runStatus).toBe("completed");
    expect(report.runEndReason).toBe("completed");
    expect(report.toolCallNames).toEqual([TOOL_NAME]);
    expect(report.toolResultCount).toBe(1);
    expect(report.liveItemCountDuringRun).toBeGreaterThan(0);
    expect(fixture.demo.executions).toHaveLength(1);
    expect(fixture.demo.executions[0]?.input).toEqual({ value: "from-the-model" });

    expect(report.canonicalAfterToolRun.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool-call",
      "tool-result",
      "assistant",
    ]);
    // Both submissions are published history; the cancelled draft is not.
    expect(report.userCountFinal).toBe(2);
    expect(report.assistantTextsFinal).toContain(ANSWER);
    expect(report.assistantTextsFinal).not.toContain("a draft that must not survive");

    // The cancel: the response is a request, and only the terminal is a stop.
    expect(report.cancelOutcome.responseCancelRequested).toBe(true);
    expect(report.cancelOutcome.responseStatus).toBe("running");
    expect(report.cancelOutcome.terminalStatus).toBe("cancelled");
    expect(report.cancelOutcome.terminalEndReason).toBe("cancelled");
    expect(report.cancelOutcome.draftGoneAfterTerminal).toBe(true);


    // A read answers the caller and matches the store it did not write.
    expect(report.sessionReadMatchesStore).toBe(true);

    // Disconnect keeps the replica and stops claiming anything about it.
    expect(report.afterDisconnect.status).toBe("disconnected");
    expect(report.afterDisconnect.stale).toBe(true);
    expect(report.afterDisconnect.presentationSessions).toBe(1);

    // Reconnect re-synchronizes the same host's lifetime from a full snapshot.
    expect(report.afterReconnect.status).toBe("ready");
    expect(report.afterReconnect.sessionIds).toEqual([report.createdSessionId]);
    expect(report.afterReconnect.canonicalLength).toBe(report.canonicalFinal.length);
    expect(report.canonicalFinal.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool-call",
      "tool-result",
      "assistant",
      "user",
    ]);

    await fixture.platform.shutdown();
  });

  it("does not retry a write and does not need a second submission", async () => {
    const fixture = await scenario();
    const client = createClientOn(fixture.platform);
    await client.connect();

    const created = await client.sessions.create();
    await client.plugins.enable({ pluginId: PLUGIN_ID });
    const started = await client.runs.start({
      sessionId: created.session.sessionId,
      submissionId: "sub-once",
      text: "please use the tool",
    });
    await waitFor(() => runSettled(client.getSnapshot(), started.run.runId), { what: "the run to settle" });

    // The same payload under the same submission id is the *same* submission:
    // the host answers with the run it already has, and nothing runs twice.
    const again = await client.runs.start({
      sessionId: created.session.sessionId,
      submissionId: "sub-once",
      text: "please use the tool",
    });
    const bySubmission = await client.runs.get({ submissionId: "sub-once" });

    expect(again.run.runId).toBe(started.run.runId);
    expect(bySubmission.run.runId).toBe(started.run.runId);
    expect(fixture.demo.executions).toHaveLength(1);
    expect(fixture.model.requests).toHaveLength(2);

    await fixture.platform.shutdown();
  });

  it("describes a settled run to a client that arrives afterwards", async () => {
    const fixture = await scenario();
    const first = createClientOn(fixture.platform);
    await first.connect();
    await first.plugins.enable({ pluginId: PLUGIN_ID });
    const created = await first.sessions.create();
    const started = await first.runs.start({
      sessionId: created.session.sessionId,
      submissionId: "sub-settled",
      text: "please use the tool",
    });
    await waitFor(() => runSettled(first.getSnapshot(), started.run.runId), { what: "the run to settle" });

    // The host now holds a terminal run, and the session has stopped pointing
    // at it. A client joining here reads that state as a snapshot: the window
    // must carry the committed, ended run — never a live-looking entry beside
    // a session that says nothing is running.
    const second = createClientOn(fixture.platform);
    await second.connect();
    expect(second.getSnapshot().status).toBe("ready");

    const runs = second.getSnapshot().presentation?.runs.items ?? [];
    expect(runs.map((run) => run.runId)).toEqual([started.run.runId]);
    expect(runs[0]).toMatchObject({ status: "completed", endReason: "completed" });
    expect(runs[0]?.endedAt).not.toBeNull();
    expect(second.getSnapshot().presentation?.sessions.items[0]?.activeRunId).toBeNull();
    expect(second.getSnapshot().live).toEqual({});

    await fixture.platform.shutdown();
  });

  it("shows plugin state changes as events, not as response echoes", async () => {
    const fixture = await scenario();
    const client = createClientOn(fixture.platform);
    await client.connect();

    const seen: string[] = [];
    client.subscribe(() => {
      const plugin = client
        .getSnapshot()
        .presentation?.plugins.find((candidate) => candidate.id === PLUGIN_ID);
      if (plugin !== undefined) seen.push(plugin.status);
    });

    await client.plugins.enable({ pluginId: PLUGIN_ID });

    expect(seen).toContain("enabled");

    await fixture.platform.shutdown();
  });
});
