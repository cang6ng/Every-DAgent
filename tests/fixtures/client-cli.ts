/**
 * The second client: a react-free, non-interactive acceptance fixture.
 *
 * It is not a CLI product — it is one scripted walk through the protocol using
 * nothing but the client's public surface: describe, session creation and reads,
 * a run that calls a real tool, a cancelled run, plugin state, disconnect and
 * reconnect. It returns what it observed so the same assertions can be run over
 * every carrier, and it never reaches for host internals: if the client cannot
 * do it, this fixture cannot either.
 */

import type { CanonicalItem, HostDescription, ProtocolChannel } from "@every-dagent/protocol";

import { createClient, type Client, type ClientSnapshot } from "@every-dagent/client";

import { waitFor } from "../helpers/platform.js";

export interface ClientCliScenario {
  readonly connect: () => Promise<ProtocolChannel>;
  readonly pluginId: string;
  /** The tool the scenario's model script calls. */
  readonly toolName: string;
  /** A submission whose scripted answer calls the tool and then answers. */
  readonly toolCallText: string;
  /** The assistant text the scripted answer produces. */
  readonly answerText: string;
  /** A submission whose scripted answer waits for the turn to be cancelled. */
  readonly cancelText: string;
  readonly submissionPrefix: string;
  readonly client?: { readonly name: string; readonly version: string };
}

export interface ClientCliReport {
  readonly description: HostDescription | undefined;
  readonly readyPresentationSessions: readonly string[];
  readonly createdSessionId: string;
  readonly createdReturnedToCaller: boolean;
  readonly listedContainsCreated: boolean;
  /**
   * The replica agrees with the host's own directory after the create — and it
   * got there through the published event, not through the response (which is a
   * unit-level property, asserted where a host that publishes nothing stands in).
   */
  readonly storeAgreesWithHostList: boolean;
  readonly pluginStatusAfterEnable: string;
  readonly runStatus: string;
  readonly runEndReason: string;
  /** The published history captured right after the tool run settled. */
  readonly canonicalAfterToolRun: readonly CanonicalItem[];
  /** The published history after everything: both runs, reconnect included. */
  readonly canonicalFinal: readonly CanonicalItem[];
  readonly userCountFinal: number;
  readonly assistantTextsFinal: readonly string[];
  readonly toolCallNames: readonly string[];
  readonly toolResultCount: number;
  readonly liveItemCountDuringRun: number;
  readonly cancelOutcome: {
    /** What the cancel *response* said: a request, never a stop confirmation. */
    readonly responseStatus: string;
    readonly responseCancelRequested: boolean;
    /** What the terminal publication said, once the core really settled. */
    readonly terminalStatus: string;
    readonly terminalEndReason: string;
    readonly draftGoneAfterTerminal: boolean;
  };
  readonly sessionReadMatchesStore: boolean;
  readonly afterDisconnect: {
    readonly status: string;
    readonly stale: boolean;
    readonly presentationSessions: number;
  };
  readonly afterReconnect: {
    readonly status: string;
    readonly sessionIds: readonly string[];
    readonly canonicalLength: number;
  };
}

const SESSION_POLL = { timeoutMs: 5000 };

export async function runClientCli(scenario: ClientCliScenario): Promise<ClientCliReport> {
  const client: Client = createClient({
    connect: scenario.connect,
    ...(scenario.client === undefined ? {} : { client: scenario.client }),
  });

  await client.connect();
  const readySnapshot = client.getSnapshot();

  // Live presentation is observed through the subscription, not by polling: a
  // run on a fast carrier can begin and end between two polls.
  let liveItemCount = 0;
  client.subscribe(() => {
    for (const run of client.getSnapshot().presentation?.runs ?? []) {
      liveItemCount = Math.max(liveItemCount, run.live?.length ?? 0);
    }
  });

  // Sessions: a create whose result goes to the caller, never into the store.
  const created = await client.sessions.create();
  const createdSessionId = created.session.sessionId;
  const listed = await client.sessions.list();
  const storeAfterCreate = sessionIdsOf(client.getSnapshot());

  // Plugins: enable the scenario's plugin through the protocol.
  const plugins = await client.plugins.list();
  if (!plugins.plugins.some((plugin) => plugin.id === scenario.pluginId)) {
    throw new Error(`the host does not know the plugin ${scenario.pluginId}`);
  }
  const enabled = await client.plugins.enable({ pluginId: scenario.pluginId });

  // A run whose scripted answer calls a tool and then answers.
  const started = await client.runs.start({
    sessionId: createdSessionId,
    submissionId: `${scenario.submissionPrefix}-tool`,
    text: scenario.toolCallText,
  });
  const runId = started.run.runId;

  await waitFor(
    () => {
      const run = runIn(client.getSnapshot(), runId);
      liveItemCount = Math.max(liveItemCount, run?.live?.length ?? 0);
      return run?.live === null;
    },
    { ...SESSION_POLL, what: "the tool run to settle" },
  );

  const settled = client.getSnapshot();
  const canonicalAfterToolRun = canonicalOf(settled, createdSessionId);

  // A cancelled run: accepted, then cancelled while the model is still waiting.
  const cancelling = await client.runs.start({
    sessionId: createdSessionId,
    submissionId: `${scenario.submissionPrefix}-cancel`,
    text: scenario.cancelText,
  });
  const cancelRequestedOnAccept = cancelling.run.cancelRequested;
  const cancelResponse = await client.runs.cancel({ runId: cancelling.run.runId });
  await waitFor(
    () => {
      const run = runIn(client.getSnapshot(), cancelling.run.runId);
      return run !== undefined && run.live === null;
    },
    { ...SESSION_POLL, what: "the cancelled run to settle" },
  );

  const cancelled = runIn(client.getSnapshot(), cancelling.run.runId);

  // A read that only answers the caller: the store is untouched by it.
  const read = await client.sessions.get({ sessionId: createdSessionId });
  const storeCanonical = canonicalOf(client.getSnapshot(), createdSessionId);

  client.disconnect();
  const disconnected = client.getSnapshot();

  await client.reconnect();
  const reconnected = client.getSnapshot();
  const canonicalFinal = canonicalOf(reconnected, createdSessionId);
  const toolCalls = canonicalFinal.filter((item) => item.kind === "tool-call");

  return {
    description: readySnapshot.description ?? undefined,
    readyPresentationSessions: sessionIdsOf(readySnapshot),
    createdSessionId,
    createdReturnedToCaller: created.session.sessionId === createdSessionId,
    listedContainsCreated: listed.sessions.some((session) => session.sessionId === createdSessionId),
    storeAgreesWithHostList:
      storeAfterCreate.length === listed.sessions.length &&
      storeAfterCreate.every((sessionId, index) => listed.sessions[index]?.sessionId === sessionId),
    pluginStatusAfterEnable: enabled.plugin.status,
    runStatus: runIn(settled, runId)?.status ?? "missing",
    runEndReason: runIn(settled, runId)?.endReason ?? "missing",
    canonicalAfterToolRun,
    canonicalFinal,
    userCountFinal: canonicalFinal.filter((item) => item.kind === "user").length,
    assistantTextsFinal: canonicalFinal.flatMap((item) => (item.kind === "assistant" ? [item.text] : [])),
    toolCallNames: toolCalls.flatMap((item) => (item.kind === "tool-call" ? [item.name] : [])),
    toolResultCount: canonicalFinal.filter((item) => item.kind === "tool-result").length,
    liveItemCountDuringRun: liveItemCount,
    cancelOutcome: {
      responseStatus: cancelResponse.run.status,
      responseCancelRequested: cancelResponse.run.cancelRequested,
      terminalStatus: cancelled?.status ?? "missing",
      terminalEndReason: cancelled?.endReason ?? "missing",
      draftGoneAfterTerminal: cancelled?.live === null,
    },
    sessionReadMatchesStore: read.session.canonical.length === storeCanonical.length,
    afterDisconnect: {
      status: disconnected.status,
      stale: disconnected.stale,
      presentationSessions: sessionIdsOf(disconnected).length,
    },
    afterReconnect: {
      status: reconnected.status,
      sessionIds: sessionIdsOf(reconnected),
      canonicalLength: canonicalFinal.length,
    },
  };
}

function sessionIdsOf(snapshot: ClientSnapshot): readonly string[] {
  return (snapshot.presentation?.sessions ?? []).map((session) => session.sessionId);
}

function canonicalOf(snapshot: ClientSnapshot, sessionId: string): readonly CanonicalItem[] {
  return snapshot.presentation?.sessions.find((session) => session.sessionId === sessionId)?.canonical ?? [];
}

function runIn(snapshot: ClientSnapshot, runId: string) {
  return snapshot.presentation?.runs.find((run) => run.runId === runId);
}
