/**
 * The composition root: one host, owning its storage, its sessions, its runs,
 * its registry and its connections.
 *
 * The host builds everything it needs and hands out nothing. Configuration
 * comes in as trusted defaults and a persisted desired value; a trusted
 * composition turns those into the execution the host will run; the plugins and
 * the grants come in the same way. There is no second entry point that could
 * reach around this one — no pre-built model client, no pre-built context
 * builder — because either would be a way to run something the persisted
 * configuration never approved.
 *
 * Startup is an asynchronous sequence with an owner, not a checklist. Storage
 * is opened and its schema checked first, because nothing may run against a
 * store this build does not understand. Then the desired configuration is read
 * — initialized once from the trusted defaults if the store has never held one
 * — and every value that will become effective is validated *now*, whatever its
 * history: a stored setting is trusted because it passed this check, never
 * because it was once accepted. Only then does the trusted composition build
 * execution, and only after that is the previous instance's unfinished work
 * reconciled. A host that cannot finish the sequence rejects here — it does not
 * come up in a degraded mode, and a durable store that fails never turns into
 * an in-memory one.
 *
 * Shutdown is the same sequence backwards, in the order the resources were
 * taken: stop accepting work, drop the readers, ask the run to stop, wait for
 * everything already accepted to settle, release the plugins, dispose the
 * execution the composition built, and close the store last, after every
 * execution that could still write to it has ended. A startup that fails
 * halfway runs the same tail in the same order, so a composition never outlives
 * the store it was built against.
 */

import {
  createAgentLoop,
  createAgentRuntime,
  createDefaultContextBuilder,
  createToolRegistry,
  LOOP_RESOURCE_LIMITS,
  validateLoopResourceLimits,
} from "@every-dagent/agent-core";
import { createPluginManager } from "@every-dagent/plugin-system";
import type { Plugin, PluginPermission, PluginStorage } from "@every-dagent/plugin-system";
import type { OperationMap, ProtocolChannel } from "@every-dagent/protocol";
import { PROTOCOL_VERSION, validateMessage } from "@every-dagent/protocol";

import type { BootstrapSettings, ComposedExecution, TrustedComposition } from "./composition.js";
import { loadConfiguration } from "./configuration.js";
import { closeConnection, createConnection, observePlugin } from "./connection.js";
import { handleFrame } from "./dispatch.js";
import { guardedModelClient, openTurnOf } from "./guard.js";
import type { StepTurnIdentity } from "./guard.js";
import { HOST_LIMITS } from "./limits.js";
import { projectPluginInfo } from "./projection.js";
import { openRepository } from "./repository.js";
import type { Repository } from "./repository.js";
import { createReverseTrigger } from "./reverse.js";
import type { ReverseProfile, ReverseTrigger } from "./reverse.js";
import { createRegistryGate } from "./registry-gate.js";
import {
  captureHostSnapshot,
  newId,
  pluginSummaryOf,
  PREPARED_REQUEST_ID,
  snapshotFrameFits,
  snapshotOfHeaviestState,
  type ConnectionState,
  type HostState,
} from "./state.js";
import { encodeFrame } from "@every-dagent/protocol";

const HOST_NAME = "every-dagent-host";
const HOST_VERSION = "0.3.0";

/**
 * Where the host's durable truth lives.
 *
 * There is no default that pretends to be durable: a composition that wants a
 * store that survives the process has to name one, and the host reports what it
 * actually got through `host.describe`.
 */
export type PersistenceOptions =
  | { readonly kind: "ephemeral" }
  | { readonly kind: "sqlite"; readonly location: string };

/**
 * What the trusted caller injects.
 *
 * Types come from the packages that own them, not from the protocol: the wire
 * contract never learns what a `ModelClient`, a `Plugin` or a `TrustedComposition`
 * is. There is deliberately no `modelClient` or `contextBuilder` here: a
 * pre-built execution would be a way to run something the persisted settings
 * never approved, and the host would have no seam left to apply a restart to.
 */
export interface HostOptions {
  /**
   * The non-secret defaults a store with no configuration is initialized with,
   * exactly once. They are validated before they are persisted, and never
   * written again once a desired value exists.
   */
  readonly bootstrap: BootstrapSettings;
  /**
   * The trusted composition: what validates a model profile and what turns the
   * effective settings into an executable `ModelClient`. Credentials are
   * resolved inside it; the host never holds one.
   */
  readonly composition: TrustedComposition;
  /** Trusted plugins, registered once and disabled until a client enables them. */
  readonly plugins: readonly Plugin[];
  readonly grants?: Readonly<Record<string, readonly PluginPermission[]>>;
  readonly storage?: (pluginId: string) => PluginStorage;
  /**
   * Where sessions, runs and history are kept. Defaults to `ephemeral`, which
   * keeps them for this process's lifetime and says so; a `sqlite` location
   * that cannot be opened stops the host from existing rather than falling back.
   */
  readonly persistence?: PersistenceOptions;
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

/**
 * Composition the package index deliberately does not export.
 *
 * The only entry here is the test-only reverse catalog: production passes none,
 * so nothing can be sent, and a profile is the single way to make a method real.
 * Everything else about a host is reached through `createHost`.
 */
export interface HostInternals {
  /** Test-only reverse profiles; the production catalog is empty. */
  readonly reverseProfiles?: readonly ReverseProfile[];
  /** Test-only observer: hands out each connection's reverse trigger as it is attached. */
  readonly onAttach?: (attached: AttachedConnection) => void;
  /** Test-only: observes the repository the host actually opened. */
  readonly onRepository?: (repository: Repository) => void;
  /** Test-only: observes the host's own live state, so a test can ask what it holds. */
  readonly onState?: (state: HostState) => void;
}

/** One attached connection, seen by tests: the channel, the trigger, the disposer. */
export interface AttachedConnection {
  readonly channel: ProtocolChannel;
  readonly reverse: ReverseTrigger;
  readonly detach: () => void;
}

export interface ComposedHost {
  readonly host: Host;
  /** The repository this host is serving, for tests that inspect durable facts directly. */
  readonly repository: Repository;
  /** Attaches like `Host.attach` and hands back the connection's own trigger. */
  attach(channel: ProtocolChannel): AttachedConnection;
}

export async function createHost(options: HostOptions): Promise<Host> {
  return (await composeHost(options, {})).host;
}

/** The real composition: `createHost` is this with no internals. */
export async function composeHost(options: HostOptions, internals: HostInternals): Promise<ComposedHost> {
  const persistence = options?.persistence ?? { kind: "ephemeral" };
  const repository = openRepository({
    location: persistence.kind === "sqlite" ? persistence.location : ":memory:",
    limits: { maxRecordBytes: HOST_LIMITS.maxRecordBytes },
  });

  let state: HostState | undefined;
  let execution: ComposedExecution | undefined;

  try {
    const hostInstanceId = newId();

    // The desired configuration first, and never rewritten: a store that holds
    // one is read and validated; a store that holds none is initialized once
    // from the trusted defaults, in one transaction that leaves nothing behind
    // if it cannot finish.
    const loaded = loadConfiguration({
      repository,
      bootstrap: options.bootstrap,
      composition: options.composition,
      at: Date.now(),
    });

    // Execution is built from the effective values, by the composition that
    // vetted them. From the moment this returns, everything it took belongs to
    // this host — including on the failure paths below.
    execution = await options.composition.compose({
      host: loaded.host,
      model: loaded.model,
      revisions: loaded.revisions,
    });

    // The loop's own profile: the approved resource bounds, tightened by the
    // effective settings. `validateLoopResourceLimits` is the one reader, so a
    // number that could not drive the loop is refused before the loop exists.
    const loopLimits = validateLoopResourceLimits({
      ...LOOP_RESOURCE_LIMITS,
      maxSteps: loaded.host.loop.maxSteps,
      maxModelAttempts: loaded.host.loop.maxModelAttempts,
    });

    const registry = createToolRegistry();
    const manager = createPluginManager({
      tools: registry,
      ...(options.grants === undefined ? {} : { grants: options.grants }),
      ...(options.storage === undefined ? {} : { storage: options.storage }),
    });
    // The composition's own builder wins when it provides one; otherwise the
    // Core's default builder applies the effective system prompt. An empty
    // prompt is the same as none: it is what a store that was never configured
    // with one holds.
    const contextBuilder =
      execution.contextBuilder ?? createDefaultContextBuilder(systemPromptOf(loaded.host.systemPrompt));
    const loop = createAgentLoop({
      // The composition's client, with the durable step guard in front of it:
      // a step that cannot be owned as JSON, or whose records could never be
      // stored at the turn's own identity, is refused before it can declare a
      // tool call — so nothing executes that could not be kept.
      modelClient: guardedModelClient(execution.modelClient, {
        maxRecordBytes: HOST_LIMITS.maxRecordBytes,
        turnOf: (): StepTurnIdentity | undefined => (state === undefined ? undefined : currentStepTurn(state)),
      }),
      tools: registry,
      contextBuilder,
      limits: loopLimits,
    });
    const reverseProfiles = internals.reverseProfiles ?? [];

    // Reconciliation is part of coming up, not something that happens later: a
    // previous instance's unfinished runs are settled here, before any frame
    // can be accepted, so no client ever sees a run this host cannot explain.
    repository.reconcileInterrupted(hostInstanceId, Date.now());

    const hostState: HostState = {
      hostInstanceId,
      name: HOST_NAME,
      version: HOST_VERSION,
      runtime: createAgentRuntime({ loop }),
      registry,
      manager,
      gate: createRegistryGate(),
      repository,
      limits: HOST_LIMITS,
      configuration: {
        effective: loaded.effective,
        host: loaded.host,
        revisions: loaded.revisions,
      },
      disposeComposition: execution.dispose,
      plugins: new Map(),
      pluginOrder: [],
      runs: new Map(),
      connections: new Set(),
      pending: new Set(),
      storageFault: false,
      closing: false,
      shutdown: undefined,
    };
    state = hostState;

    // Registration is configuration, and configuration mistakes stop the host
    // from existing: a host that cannot list a plugin it was given has no honest
    // way to announce itself as ready.
    for (const plugin of options.plugins) manager.register(plugin);
    for (const info of manager.list()) {
      hostState.plugins.set(info.manifest.id, projectPluginInfo(info));
      hostState.pluginOrder.push(info.manifest.id);
    }

    assertSelfDescription(hostState);

    internals.onRepository?.(repository);
    internals.onState?.(hostState);

    const attach = (channel: ProtocolChannel): AttachedConnection => {
      const connection = attachConnection(hostState, channel, internals.reverseProfiles ?? []);
      const attached: AttachedConnection = {
        channel,
        reverse: createReverseTrigger(hostState, connection),
        detach: (): void => {
          detachConnection(hostState, connection);
        },
      };
      internals.onAttach?.(attached);
      return attached;
    };

    return {
      repository,
      host: {
        attach: (channel: ProtocolChannel): (() => void) => attach(channel).detach,
        shutdown: (): Promise<void> => shutdownHost(hostState),
      },
      attach,
    };
  } catch (error) {
    // Whatever exists is released in the order it was taken — plugins settled,
    // plugins released, execution disposed, store closed last — so a failure
    // during startup cannot leave a composition holding a store the host has
    // given up on.
    await releaseStartup(state, execution, repository);
    throw error;
  }
}

/**
 * Releases whatever a failed startup had already taken, in the order the
 * resources were acquired.
 *
 * The order is the contract, not a detail: a plugin lifecycle that is still
 * settling must be waited for before its tools are released, the execution the
 * composition built outlives neither, and the store is closed last because
 * everything above it may still be writing. Nothing here throws — the failure
 * being cleaned up after is the fact worth reporting.
 */
async function releaseStartup(
  state: HostState | undefined,
  execution: ComposedExecution | undefined,
  repository: Repository,
): Promise<void> {
  if (state !== undefined) {
    try {
      while (state.pending.size > 0) await Promise.all([...state.pending]);
      await state.gate.idle();
    } catch {
      // Nothing was running; there is nothing left to settle.
    }
    try {
      await releasePlugins(state);
    } catch {
      // A plugin that could not be released is reported by the failed startup
      // itself; the store still has to be closed.
    }
  }

  if (execution?.dispose !== undefined) {
    try {
      await execution.dispose();
    } catch {
      // The composition owns its own cleanup; a failing disposer does not stop
      // the store from being released.
    }
  }

  repository.close();
}

/** The system prompt the default builder applies, or `undefined` for none. */
function systemPromptOf(systemPrompt: string): string | undefined {
  return systemPrompt === "" ? undefined : systemPrompt;
}

/**
 * The turn the host is executing right now, for the step guard.
 *
 * The host runs at most one execution at a time and the window it loaded is the
 * Core's own log, so the turn open in that log is the turn the step being
 * streamed belongs to. It is read from the log — not from the host's observed
 * state — because observation is asynchronous: what the guard needs is the
 * identity the commit will really use, not a race to catch up with the stream.
 */
function currentStepTurn(state: HostState): StepTurnIdentity | undefined {
  for (const run of state.runs.values()) {
    if (run.terminal !== undefined || run.window === undefined) continue;
    const turnId = openTurnOf(run.window.session);
    if (turnId !== undefined) return { turnId };
  }
  return undefined;
}

/**
 * Checks at construction that the host can describe the state it starts in —
 * and every state a legal run can leave behind.
 *
 * The check is the real thing, not a schema-shaped approximation: the snapshot
 * a subscriber would receive is composed and encoded with the protocol's own
 * encoder, so the frame limit that decides whether a client can ever subscribe
 * is decided *here*, while the composition can still see why. A finite static
 * configuration that could not travel is refused at startup instead of
 * producing a host whose every subscribe fails.
 *
 * Describing the state *now* is not enough on its own: a host that starts empty
 * and accepts a maximal input afterwards would be a host no client can
 * re-subscribe to. So the heaviest state a legal run can force — the static
 * catalogue plus one session and the executing run it owns, at the store's own
 * input bound — is composed the same way and held to the same frame. A
 * configuration that leaves no room for any run is refused here, which is the
 * only point at which the composition can still see the problem.
 */
function assertSelfDescription(state: HostState): void {
  const result: OperationMap["subscriptions.open"]["result"] = {
    snapshot: captureHostSnapshot(state, "prepare:stream", PREPARED_REQUEST_ID),
  };
  const validated = validateMessage(
    { kind: "host-response", method: "subscriptions.open" },
    {
      kind: "host-response",
      protocolVersion: PROTOCOL_VERSION,
      hostInstanceId: state.hostInstanceId,
      requestId: PREPARED_REQUEST_ID,
      result,
    },
  );
  if (!validated.success) {
    throw new Error("the host could not describe the state it was configured with");
  }
  const encoded = encodeFrame(
    { kind: "host-response", method: "subscriptions.open" },
    {
      kind: "host-response",
      protocolVersion: PROTOCOL_VERSION,
      hostInstanceId: state.hostInstanceId,
      requestId: PREPARED_REQUEST_ID,
      result,
    },
  );
  if (!encoded.success) {
    throw new Error("the state this host was configured with cannot be published inside one frame");
  }

  // The catalogue is static configuration and travels on its own response, so
  // it is checked the same way, with the same encoder and the same reserved
  // request id — the cost a real subscriber's id may legally reach.
  const catalogue: OperationMap["plugins.list"]["result"] = {
    plugins: state.pluginOrder.map((pluginId) => pluginSummaryOf(state, pluginId)),
  };
  const catalogueFrame = encodeFrame(
    { kind: "host-response", method: "plugins.list" },
    {
      kind: "host-response",
      protocolVersion: PROTOCOL_VERSION,
      hostInstanceId: state.hostInstanceId,
      requestId: PREPARED_REQUEST_ID,
      result: catalogue,
    },
  );
  if (!catalogueFrame.success) {
    throw new Error("the plugin catalogue this host was configured with cannot be published inside one frame");
  }

  // And the configuration has to leave room for what a legal run adds to it:
  // one session and the run it owns, at the largest input the store accepts.
  if (!snapshotFrameFits(state, snapshotOfHeaviestState(state, "prepare:stream"))) {
    throw new Error("the configuration this host was given leaves no room for a legal run inside one frame");
  }
}

/**
 * Takes one logical connection and installs its listener.
 *
 * Dispatching from a microtask keeps a synchronous transport from re-entering a
 * host transaction through `send`, and keeps one slow operation from holding up
 * the frame behind it.
 */
function attachConnection(
  state: HostState,
  channel: ProtocolChannel,
  reverseProfiles: readonly ReverseProfile[],
): ConnectionState {
  if (state.closing) {
    throw new Error("the host is shutting down and accepts no new connections");
  }

  const connection = createConnection(channel, reverseProfiles);
  state.connections.add(connection);
  const detach = channel.listen({
    onFrame: (frame: string): void => {
      queueMicrotask(() => {
        handleFrame(state, connection, frame);
      });
    },
    onClose: (): void => {
      closeConnection(state, connection);
    },
  });

  // A channel that closes while being listened to has already ended this
  // connection; the disposer it just handed back still has to be used.
  if (connection.closed) {
    try {
      detach();
    } catch {
      // Same as everywhere else: a channel that cannot remove a listener is gone.
    }
  } else {
    connection.detachListener = detach;
  }

  return connection;
}

/**
 * Detaches one connection the way the host's own close path does.
 *
 * There is deliberately one path, not two: `closed` says the connection is over,
 * and the listener bookkeeping is handled where the connection actually ends.
 */
function detachConnection(state: HostState, connection: ConnectionState): void {
  closeConnection(state, connection);
}

/**
 * Starts the one shutdown this host will ever run.
 *
 * The completion handle is installed *before* anything the host does not
 * control. Closing a connection and aborting a run both run foreign code
 * synchronously — a transport's close handler, an abort listener — and any of
 * it may call back in here. A caller that arrives during that window must find
 * the shutdown already in progress and share its outcome, not start a second
 * cleanup that would release plugins the first one is still waiting for.
 */
function shutdownHost(state: HostState): Promise<void> {
  const running = state.shutdown;
  if (running !== undefined) return running;

  // 1. No new work, decided synchronously and before any external call.
  state.closing = true;

  // 2. One shared completion, installed synchronously. From here on every
  //    caller — reentrant or later — gets exactly this promise.
  let settle!: { resolve: () => void; reject: (error: unknown) => void };
  const completion = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  state.shutdown = completion;

  // 3. One executor. Its rejection is delivered to every caller through the
  //    shared promise, so a failed cleanup is reported the same way to all of
  //    them rather than being swallowed or duplicated.
  void executeShutdown(state).then(settle.resolve, settle.reject);

  return completion;
}

async function executeShutdown(state: HostState): Promise<void> {
  // The readers go first: a client that is going away is not the work.
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

  // The execution the composition built goes with the plugins: a provider
  // client that outlived the store it was configured from would be a live
  // socket nobody owns.
  if (state.disposeComposition !== undefined) {
    try {
      await state.disposeComposition();
    } catch {
      unreleased.push("composition");
    }
  }

  // The store is released last, and it is released even when a plugin could not
  // be: an execution that is over must not leave the file locked, and the
  // plugin failure is reported rather than swallowed by the order.
  state.repository.close();

  if (unreleased.length > 0) {
    throw new Error(`the host could not release: ${unreleased.join(", ")}`);
  }
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
