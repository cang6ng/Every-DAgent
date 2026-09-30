/**
 * Acceptance A: a second runtime plugin, over both carriers.
 *
 * The calculator is not the platform. This proves it with a plugin that has
 * nothing to do with it: registered at composition, listed while disabled,
 * enabled over the protocol, called by a real model, answered by a real tool,
 * and — once disabled — actually gone: the next request is built without its
 * schema and its tool no longer executes. Nothing here modifies the Core, the
 * protocol, the client or the shell; the only additions are a fixture plugin
 * and a host composition that registers it.
 */

import type { ProtocolChannel } from "@every-dagent/protocol";
import { connectHttpChannel, startHttpBinding, type HttpBinding } from "@every-dagent/web";
import { createClient } from "@every-dagent/client";
import { createCalculatorPlugin } from "@every-dagent/plugin-calculator";
import { afterEach, describe, expect, it } from "vitest";

import { textStatsPlugin } from "../fixtures/text-stats-plugin.js";
import { createHostPlatform, waitFor } from "../helpers/platform.js";
import { scriptedModel, textReply, toolReply, type ModelReply } from "../helpers/demo-fixtures.js";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

async function platformFor(carrier: "memory" | "web", replies: readonly ModelReply[]) {
  const model = scriptedModel(replies);
  const textStats = textStatsPlugin();
  let binding: HttpBinding | undefined;
  const platform = createHostPlatform({
    modelClient: model.client,
    plugins: [createCalculatorPlugin(), textStats.plugin],
    ...(carrier === "web" ? { source: (): Promise<ProtocolChannel> => connectHttpChannel({ origin: binding?.origin ?? "" }) } : {}),
  });
  if (carrier === "web") {
    binding = await startHttpBinding({ onConnection: (channel) => platform.host.attach(channel) });
    open.push({ close: () => binding?.close() ?? Promise.resolve() });
  }
  open.push({ close: () => platform.shutdown() });
  return { platform, model, textStats };
}

describe.each(["memory", "web"] as const)("a second plugin over the %s carrier", (carrier) => {
  it("lists, enables, executes and takes its tool away again", async () => {
    const replies: readonly ModelReply[] = [
      toolReply("call-1", "text-stats", { text: "hello world" }),
      textReply("统计完成"),
      toolReply("call-2", "text-stats", { text: "should not run" }),
      textReply("工具已经不在了"),
    ];
    const { platform, model, textStats } = await platformFor(carrier, replies);
    const client = createClient({ connect: () => platform.connect() });
    await client.connect();

    // Both plugins are listed, both disabled, with no renderer anywhere in sight.
    await waitFor(() => (client.getSnapshot().presentation?.plugins.length ?? 0) === 2, { what: "the plugin directory" });
    const listed = client.getSnapshot().presentation?.plugins ?? [];
    expect(listed.map((plugin) => plugin.id).sort()).toEqual(["calculator", "text-stats"]);
    expect(listed.every((plugin) => plugin.status === "disabled")).toBe(true);
    expect(listed.find((plugin) => plugin.id === "text-stats")?.description).toContain("characters");

    const { session } = await client.sessions.create();

    // Enable the second plugin over the protocol.
    await client.plugins.enable({ pluginId: "text-stats" });
    await waitFor(
      () => client.getSnapshot().presentation?.plugins.find((plugin) => plugin.id === "text-stats")?.status === "enabled",
      { what: "the plugin to be enabled" },
    );

    // The model asks for its tool; the real tool runs and is recorded.
    await client.runs.start({ sessionId: session.sessionId, submissionId: "sub-1", text: "统计一下" });
    await waitFor(
      () => client.getSnapshot().presentation?.sessions[0]?.canonical.some((item) => item.kind === "tool-result") === true,
      { what: "the tool result" },
    );

    const canonical = client.getSnapshot().presentation?.sessions[0]?.canonical ?? [];
    const call = canonical.find((item) => item.kind === "tool-call");
    const result = canonical.find((item) => item.kind === "tool-result");
    expect(call).toMatchObject({ kind: "tool-call", name: "text-stats", input: { kind: "json", value: { text: "hello world" } } });
    expect(result).toMatchObject({ kind: "tool-result", name: "text-stats", ok: true });
    expect(textStats.executions).toEqual([{ text: "hello world" }]);
    // The second request was built with the tool in it: enabling really changed
    // what the model is offered.
    expect(model.requests[1]?.tools.map((tool) => tool.name)).toContain("text-stats");

    // Disable it: the tool leaves the registry, and the next request proves it.
    await client.plugins.disable({ pluginId: "text-stats" });
    await waitFor(
      () => client.getSnapshot().presentation?.plugins.find((plugin) => plugin.id === "text-stats")?.status === "disabled",
      { what: "the plugin to be disabled" },
    );

    await client.runs.start({ sessionId: session.sessionId, submissionId: "sub-2", text: "再统计一次" });
    await waitFor(() => model.requests.length >= 4, { what: "the second run's requests" });
    // The request that would decide to call the tool no longer offers it.
    expect(model.requests[2]?.tools.map((tool) => tool.name)).not.toContain("text-stats");

    await waitFor(
      () =>
        (client.getSnapshot().presentation?.sessions[0]?.canonical.filter((item) => item.kind === "tool-result").length ?? 0) === 2,
      { what: "the second tool result" },
    );
    const results = (client.getSnapshot().presentation?.sessions[0]?.canonical ?? []).filter(
      (item) => item.kind === "tool-result",
    );
    // The call failed as an unknown tool, and the fixture never ran again.
    expect(results[1]).toMatchObject({ kind: "tool-result", name: "text-stats", ok: false });
    expect(textStats.executions).toEqual([{ text: "hello world" }]);

    client.disconnect();
  });
});
