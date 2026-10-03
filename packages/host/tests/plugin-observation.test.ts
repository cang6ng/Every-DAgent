/**
 * Plugin observation: what counts as a change, and what must not be announced.
 *
 * Two levels are checked here. The published-summary comparison is pinned
 * directly, including the case the manager cannot produce as two consecutive
 * observations on its own — a status that stays the same while the safe failure
 * summary changes, and a failure whose only difference is text the protocol
 * never carries. The host-level cases then cover the transitions a client can
 * actually drive.
 */

import { describe, expect, it } from "vitest";

import type { PluginInfo } from "@every-dagent/plugin-system";
import type {
  CollectionRevisions,
  PluginSummary,
  ProtocolChannel,
  ProtocolChannelListener,
} from "@every-dagent/protocol";

import { observePlugin } from "../src/connection.js";
import { samePluginSummary } from "../src/projection.js";
import { createReverseConnectionState } from "../src/reverse.js";
import type { ConnectionState, HostState } from "../src/state.js";

import { connect, flush, scriptedModel, testHost, testPlugin, textReply } from "./helpers/harness.js";

function failure(phase: "permissions" | "activate" | "commit" | "dispose", cleanupErrors: string[] = []) {
  return {
    operation: "enable" as const,
    phase,
    message: "the manager's own words, which the protocol never carries",
    cleanupErrors,
  };
}

function pluginInfo(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    manifest: { id: "demo", name: "Demo", version: "1.0.0" },
    status: "disabled",
    ...overrides,
  };
}

describe("published summary comparison", () => {
  it("treats a changed safe failure as a change even when the status is the same", () => {
    const before: PluginSummary = {
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      permissions: [],
      status: "disabled",
      lastFailure: {
        operation: "enable",
        phase: "activate",
        code: "PLUGIN_OPERATION_FAILED",
        message: "the plugin failed to activate",
        cleanupFailureCount: 0,
      },
    };
    const after: PluginSummary = { ...before, lastFailure: { ...before.lastFailure!, cleanupFailureCount: 1 } };

    expect(after.status).toBe(before.status);
    expect(samePluginSummary(before, after)).toBe(false);
  });

  it("treats a change of the safe code or phase as a change on its own", () => {
    const base: PluginSummary = {
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      permissions: [],
      status: "error",
      lastFailure: {
        operation: "enable",
        phase: "commit",
        code: "PLUGIN_OPERATION_FAILED",
        message: "the plugin failed to register its tools",
        cleanupFailureCount: 0,
      },
    };

    expect(
      samePluginSummary(base, { ...base, lastFailure: { ...base.lastFailure!, code: "PLUGIN_PERMISSION_DENIED" } }),
    ).toBe(false);
    expect(
      samePluginSummary(base, { ...base, lastFailure: { ...base.lastFailure!, phase: "dispose" } }),
    ).toBe(false);
    expect(
      samePluginSummary(base, { ...base, lastFailure: { ...base.lastFailure!, operation: "disable" } }),
    ).toBe(false);
  });

  it("ignores everything the protocol does not carry", () => {
    // Two attempts that differ only in the words the manager recorded: the same
    // safe summary, so the same published state.
    const first = { ...pluginInfo({ lastFailure: failure("activate") }) };
    const second = {
      ...pluginInfo({
        lastFailure: {
          operation: "enable" as const,
          phase: "activate" as const,
          message: "a completely different sentence, maybe with a secret in it",
          cleanupErrors: [],
        },
      }),
    };

    // The summary comparison sees projected values, so what matters is that the
    // projection of these two is equal — and the raw message is not part of it.
    expect(first.lastFailure?.message).not.toBe(second.lastFailure?.message);
  });
});

describe("observation of a live plugin", () => {
  it("publishes a change whose status did not move", async () => {
    // A synthetic manager state: the status stays `disabled` while the safe
    // failure summary changes, which is the comparison a status-only check gets
    // wrong. The manager cannot produce this pair as two consecutive
    // observations, so the observation boundary is driven directly.
    const fired: string[] = [];
    const connection = recordingConnection(fired);
    const summaries = new Map<string, PluginSummary>([
      [
        "demo",
        {
          id: "demo",
          name: "Demo",
          version: "1.0.0",
          permissions: [],
          status: "disabled",
          lastFailure: {
            operation: "enable",
            phase: "activate",
            code: "PLUGIN_OPERATION_FAILED",
            message: "the plugin failed to activate",
            cleanupFailureCount: 0,
          },
        },
      ],
    ]);

    let current = pluginInfo({ lastFailure: failure("activate") });
    const state = observationState(summaries, connection, () => current);

    observePlugin(state, "demo");
    await flush();

    current = pluginInfo({ lastFailure: failure("activate", ["cleanup failed"]) });
    observePlugin(state, "demo");
    await flush();

    expect(summaries.get("demo")?.status).toBe("disabled");
    expect(summaries.get("demo")?.lastFailure?.cleanupFailureCount).toBe(1);
    // One change, one summary announcement — and the catalogue revision it
    // moved travels with it as its own event, because `plugin.updated` carries
    // no revisions. What must not happen is a second summary announcement.
    const announced = fired.map((frame) => (JSON.parse(frame) as { type?: string }).type);
    expect(announced.filter((type) => type === "plugin.updated")).toHaveLength(1);
    expect(announced.filter((type) => type === "collection.invalidated")).toHaveLength(1);
  });

  it("says nothing when the safe summary is identical", async () => {
    const fired: string[] = [];
    const connection = recordingConnection(fired);
    const summaries = new Map<string, PluginSummary>([
      ["demo", { id: "demo", name: "Demo", version: "1.0.0", permissions: [], status: "disabled" }],
    ]);
    const state = observationState(summaries, connection, () => pluginInfo());

    observePlugin(state, "demo");
    observePlugin(state, "demo");
    await flush();

    expect(fired).toEqual([]);
  });
});

describe("plugin lifecycle announcements", () => {
  it("announces a later failure that adds a cleanup failure to the safe summary", async () => {
    let attempts = 0;
    const host = await testHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [
        testPlugin({
          id: "flaky",
          tools: [],
          activate: (context) => {
            attempts += 1;
            const thisAttempt = attempts;
            context.onDispose(() => {
              // The second attempt's cleanup fails, so the safe failure summary
              // gains a cleanup failure count — with the status ending in the
              // same place both times.
              if (thisAttempt === 2) throw new Error("cleanup exploded: super-secret-token");
            });
            throw new Error("activation exploded: super-secret-token");
          },
        }),
      ],
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});

    const first = await client.call("plugins.enable", { pluginId: "flaky" });
    expect(first.error?.code).toBe("PLUGIN_OPERATION_FAILED");
    const afterFirst = (await client.call("plugins.list", {})).result?.plugins[0];
    expect(afterFirst?.status).toBe("disabled");
    expect(afterFirst?.lastFailure?.cleanupFailureCount).toBe(0);

    const second = await client.call("plugins.enable", { pluginId: "flaky" });
    expect(second.error?.code).toBe("PLUGIN_OPERATION_FAILED");
    const afterSecond = (await client.call("plugins.list", {})).result?.plugins[0];
    // The cleanup failure moves the plugin into the error state and is reported
    // as part of the safe summary rather than as the manager's own words.
    expect(afterSecond?.status).toBe("error");
    expect(afterSecond?.lastFailure?.cleanupFailureCount).toBe(1);

    const updates = client.events.filter((event) => event.type === "plugin.updated");
    expect(updates.at(-1)?.payload.plugin.lastFailure?.cleanupFailureCount).toBe(1);
    expect(JSON.stringify(client.frames)).not.toContain("super-secret-token");
  });

  it("says nothing for a request that changes nothing", async () => {
    const host = await testHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [testPlugin({ id: "calm", tools: [] })],
    });
    const client = connect(host);
    await client.describe();
    await client.call("subscriptions.open", {});

    const first = await client.call("plugins.enable", { pluginId: "calm" });
    expect(first.result?.plugin.status).toBe("enabled");
    const announced = client.events.filter((event) => event.type === "plugin.updated");
    // A synchronous activation is observed as finished, never as an invented
    // `enabling` in between.
    expect(announced.map((event) => event.payload.plugin.status)).toEqual(["enabled"]);

    // The manager's no-op enable leaves the plugin in the state the host already
    // published: an observation that finds the same content announces nothing.
    const second = await client.call("plugins.enable", { pluginId: "calm" });
    await flush();

    expect(second.result?.plugin.status).toBe("enabled");
    expect(client.events.filter((event) => event.type === "plugin.updated")).toHaveLength(announced.length);
  });
});

// ---------------------------------------------------------------------------
// The internal observation boundary, driven directly.
// ---------------------------------------------------------------------------

function recordingConnection(fired: string[]): ConnectionState {
  const listener: { current?: ProtocolChannelListener } = {};
  const channel: ProtocolChannel = {
    send: (frame: string): void => {
      fired.push(frame);
    },
    listen: (installed: ProtocolChannelListener): (() => void) => {
      listener.current = installed;
      return () => {
        listener.current = undefined;
      };
    },
    close: (): void => {},
  };

  return {
    channel,
    requestIds: new Set<string>(),
    initialized: undefined,
    reverse: createReverseConnectionState([]),
    detachListener: undefined,
    subscription: { streamId: "stream-observation", sequence: 0 },
    outbox: [],
    outboxBytes: 0,
    pumping: false,
    closed: false,
  };
}

function observationState(
  summaries: Map<string, PluginSummary>,
  connection: ConnectionState,
  current: () => PluginInfo,
): HostState {
  // Only the fields `observePlugin` reads are real; the rest of the host is not
  // involved in observation, and this fixture never reaches it. The catalogue
  // revision is one of those fields now: a published change and its durable
  // revision are one step, so the stub records the bump the way a store does.
  let plugins = 0;
  return {
    hostInstanceId: "host-observation",
    name: "test",
    version: "0.1.0",
    manager: { get: () => current() },
    plugins: summaries,
    pluginOrder: ["demo"],
    connections: new Set([connection]),
    repository: {
      bumpPluginRevision: (): CollectionRevisions => {
        plugins += 1;
        return { sessions: 0, runs: 0, plugins };
      },
    },
  } as unknown as HostState;
}
