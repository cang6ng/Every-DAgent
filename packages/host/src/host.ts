/**
 * The composition root: one host, owning its sessions, its runs, its registry
 * and its connections.
 *
 * The host builds everything it needs and hands out nothing. Composition — the
 * model client, the plugins, the grants — comes in; a channel goes in and only
 * ever causes protocol messages to come out. There is no second entry point
 * that could reach around the gate, and no registry, session or manager object
 * leaves this package.
 *
 * Shutdown is a sequence, not a signal: stop accepting work, drop the readers,
 * ask the run to stop, wait for everything already accepted to actually settle,
 * and only then release the plugins. A task that never settles keeps shutdown
 * pending — the alternative would be reporting a release that did not happen.
 */

import {
  createAgentLoop,
  createAgentRuntime,
  createDefaultContextBuilder,
  createToolRegistry,
} from "@every-dagent/agent-core";
import type { ContextBuilder, ModelClient } from "@every-dagent/agent-core";
import { createPluginManager } from "@every-dagent/plugin-system";
import type { Plugin, PluginPermission, PluginStorage } from "@every-dagent/plugin-system";
import type { OperationMap, ProtocolChannel } from "@every-dagent/protocol";
import { PROTOCOL_VERSION, validateMessage } from "@every-dagent/protocol";

import { closeConnection, createConnection, observePlugin } from "./connection.js";
import { handleFrame } from "./dispatch.js";
import { projectPluginInfo } from "./projection.js";
import { createRegistryGate } from "./registry-gate.js";
import { captureHostSnapshot, newId, type HostState } from "./state.js";

const HOST_NAME = "every-dagent-host";
const HOST_VERSION = "0.1.0";

/**
 * What the composition injects.
 *
 * Types come from the packages that own them, not from the protocol: the wire
 * contract never learns what a `ModelClient` or a `Plugin` is.
 */
export interface HostOptions {
  /** Required so a host always has a way to think; the adapter is the caller's choice. */
  readonly modelClient: ModelClient;
  /** Defaults to the Core's own builder; pass one to add a system prompt. */
  readonly contextBuilder?: ContextBuilder;
  /** Trusted plugins, registered once and disabled until a client enables them. */
  readonly plugins: readonly Plugin[];
  readonly grants?: Readonly<Record<string, readonly PluginPermission[]>>;
  readonly storage?: (pluginId: string) => PluginStorage;
}

export interface Host {
  /**
   * Takes one logical connection. The returned disposer ends it — and only it:
   * a client going away never cancels a run.
   */
  attach(channel: ProtocolChannel): () => void;
  /** Resolves when every accepted operation has settled and the plugins are released. */
  shutdown(): Promise<void>;
}

export function createHost(options: HostOptions): Host {
  const registry = createToolRegistry();
  const manager = createPluginManager({
    tools: registry,
    ...(options.grants === undefined ? {} : { grants: options.grants }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  });
  const contextBuilder = options.contextBuilder ?? createDefaultContextBuilder();
  const loop = createAgentLoop({
    modelClient: options.modelClient,
    tools: registry,
    contextBuilder,
  });

  const state: HostState = {
    hostInstanceId: newId(),
    name: HOST_NAME,
    version: HOST_VERSION,
    runtime: createAgentRuntime({ loop }),
    registry,
    manager,
    gate: createRegistryGate(),
    plugins: new Map(),
    pluginOrder: [],
    sessions: new Map(),
    sessionOrder: [],
    runs: new Map(),
    runOrder: [],
    submissions: new Map(),
    connections: new Set(),
    pending: new Set(),
    closing: false,
    shutdown: undefined,
  };

  // Registration is configuration, and configuration mistakes stop the host
  // from existing: a host that cannot list a plugin it was given has no honest
  // way to announce itself as ready.
  for (const plugin of options.plugins) manager.register(plugin);
  for (const info of manager.list()) {
    state.plugins.set(info.manifest.id, projectPluginInfo(info));
    state.pluginOrder.push(info.manifest.id);
  }

  assertSelfDescription(state);

  return {
    attach: (channel: ProtocolChannel): (() => void) => attach(state, channel),
    shutdown: (): Promise<void> => shutdownHost(state),
  };
}

/**
 * Checks at construction that the host can describe the state it starts in.
 *
 * A cheap, honest gate: if the plugin summaries or the empty catalogues could
 * not be published as a snapshot, the host would fail on the first client
 * instead of failing here, where the composition can still see why.
 */
function assertSelfDescription(state: HostState): void {
  const result: OperationMap["subscriptions.open"]["result"] = {
    snapshot: captureHostSnapshot(state, "prepare:stream"),
  };
  const validated = validateMessage(
    { kind: "host-response", method: "subscriptions.open" },
    {
      kind: "host-response",
      protocolVersion: PROTOCOL_VERSION,
      hostInstanceId: state.hostInstanceId,
      requestId: "prepare",
      result,
    },
  );
  if (!validated.success) {
    throw new Error("the host could not describe the state it was configured with");
  }
}

function attach(state: HostState, channel: ProtocolChannel): () => void {
  if (state.closing) {
    throw new Error("the host is shutting down and accepts no new connections");
  }

  const connection = createConnection(channel);
  state.connections.add(connection);

  const detachListener = channel.listen({
    // Dispatching from a microtask keeps a synchronous transport from
    // re-entering a host transaction through `send`, and keeps one slow
    // operation from holding up the frame behind it.
    onFrame: (frame: string): void => {
      queueMicrotask(() => {
        handleFrame(state, connection, frame);
      });
    },
    onClose: (): void => {
      closeConnection(state, connection);
    },
  });

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    closeConnection(state, connection);
    detachListener();
  };
}

function shutdownHost(state: HostState): Promise<void> {
  if (state.shutdown !== undefined) return state.shutdown;

  state.shutdown = (async (): Promise<void> => {
    // Everything from here to the first await is synchronous: no operation
    // admitted after this line can exist, and no operation admitted before it
    // can be missed.
    state.closing = true;
    for (const connection of [...state.connections]) closeConnection(state, connection);

    // A request, not a stop. The run keeps the registry until its stream
    // settles, and the wait below is what makes shutdown honest.
    for (const run of state.runs.values()) {
      if (run.terminal === undefined) run.controller.abort();
    }

    // Every accepted task, including the ones registered while this loop's own
    // awaits were running, and including tasks that never finish: those keep
    // shutdown pending rather than letting it claim a release that did not
    // happen.
    while (state.pending.size > 0) {
      await Promise.all([...state.pending]);
    }
    await state.gate.idle();

    const unreleased = await releasePlugins(state);
    if (unreleased.length > 0) {
      throw new Error(`the host could not release: ${unreleased.join(", ")}`);
    }
  })();

  return state.shutdown;
}

/**
 * Disables every plugin this host enabled, one at a time.
 *
 * A plugin already in the manager's error state is not retried, because the
 * manager offers no way out of it and forcing one would be the host inventing
 * a lifecycle the plugin system does not have. It is reported instead, and the
 * remaining plugins are still released.
 */
async function releasePlugins(state: HostState): Promise<string[]> {
  const unreleased: string[] = [];

  for (const pluginId of state.pluginOrder) {
    const info = state.manager.get(pluginId);
    if (info === undefined) continue;
    if (info.status === "error") {
      unreleased.push(pluginId);
      continue;
    }
    if (info.status !== "enabled") continue;

    try {
      await state.manager.disable(pluginId);
    } catch {
      unreleased.push(pluginId);
      continue;
    }

    try {
      observePlugin(state, pluginId);
    } catch {
      // The release itself succeeded; no subscriber is left to tell.
    }
  }

  return unreleased;
}
