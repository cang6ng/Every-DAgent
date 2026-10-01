/**
 * The second client: a react-free, non-interactive acceptance fixture.
 *
 * It is not a CLI product — it is one scripted walk through the protocol using
 * nothing but the client's public surface: describe, session creation and reads,
 * a run that calls a real tool, a cancelled run, plugin state, disconnect and
 * reconnect. It returns what it observed so the same assertions can be run over
 * every carrier, and it never reaches for host internals: if the client cannot
 * do it, this fixture cannot either.
 *
 * History is read the v2 way, through `sessions.history` pages, because that is
 * the only way a client holds a conversation now: the fixture walks the pages to
 * the start of the session and then reads back what the client recorded, so a
 * page that travelled but never landed is visible here rather than imagined.
 */

import type { CanonicalItem, HostDescription, ProtocolChannel, RunSummary } from "@every-dagent/protocol";

import { createClient, type Client, type ClientSnapshot } from "@every-dagent/client";

import { waitFor } from "../helpers/wait-for.js";

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
  /** The committed history loaded right after the tool run settled. */
  readonly canonicalAfterToolRun: readonly CanonicalItem[];
  /** The committed history after everything: both runs, reconnect included. */
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
    for (const run of Object.values(client.getSnapshot().live)) {
      liveItemCount = Math.max(liveItemCount, run.live.length);
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
      liveItemCount = Math.max(liveItemCount, liveOf(client.getSnapshot(), runId).length);
      return settled(client.getSnapshot(), runId);
    },
    { ...SESSION_POLL, what: "the tool run to settle" },
  );

  const canonicalAfterToolRun = (await client.sessions.history({ sessionId: createdSessionId })).page.items;
  const settledSnapshot = client.getSnapshot();

  // A cancelled run: accepted, then cancelled while the model is still waiting.
  const cancelling = await client.runs.start({
    sessionId: createdSessionId,
    submissionId: `${scenario.submissionPrefix}-cancel`,
    text: scenario.cancelText,
  });
  const cancelResponse = await client.runs.cancel({ runId: cancelling.run.runId });
  await waitFor(() => settled(client.getSnapshot(), cancelling.run.runId), {
    ...SESSION_POLL,
    what: "the cancelled run to settle",
  });

  const cancelled = runIn(client.getSnapshot(), cancelling.run.runId);
  // The terminal correction drops the draft: the run is in the directory as a
  // terminal entry, and the replica's live map no longer holds its timeline.
  const draftGoneAfterTerminal =
    cancelled !== undefined && liveOf(client.getSnapshot(), cancelling.run.runId).length === 0;

  // A read that only answers the caller: the client's own state is untouched by
  // it, and what it answered agrees with the store it did not write.
  const beforeRead = client.getSnapshot();
  const read = await client.sessions.get({ sessionId: createdSessionId });
  const afterRead = client.getSnapshot();
  const storeSummary = sessionSummaryIn(afterRead, createdSessionId);

  client.disconnect();
  const disconnected = client.getSnapshot();

  await client.reconnect();
  const reconnected = client.getSnapshot();
  const canonicalFinal = await readCanonical(client, createdSessionId);
  const toolCalls = canonicalFinal.filter((item) => item.kind === "tool-call");

  return {
    description: readySnapshot.description ?? undefined,
    readyPresentationSessions: sessionIdsOf(readySnapshot),
    createdSessionId,
    createdReturnedToCaller: created.session.sessionId === createdSessionId,
    listedContainsCreated: listed.sessions.items.some((session) => session.sessionId === createdSessionId),
    storeAgreesWithHostList:
      storeAfterCreate.length === listed.sessions.items.length &&
      storeAfterCreate.every((sessionId, index) => listed.sessions.items[index]?.sessionId === sessionId),
    pluginStatusAfterEnable: enabled.plugin.status,
    runStatus: runIn(settledSnapshot, runId)?.status ?? "missing",
    runEndReason: runIn(settledSnapshot, runId)?.endReason ?? "missing",
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
      draftGoneAfterTerminal,
    },
    sessionReadMatchesStore:
      read.session.sessionId === createdSessionId &&
      storeSummary !== undefined &&
      storeSummary.committedSeq === read.session.committedSeq &&
      afterRead.presentation === beforeRead.presentation &&
      afterRead.history === beforeRead.history,
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
  return (snapshot.presentation?.sessions.items ?? []).map((session) => session.sessionId);
}

/** The one session's summary as the client's bounded directory holds it. */
function sessionSummaryIn(snapshot: ClientSnapshot, sessionId: string) {
  return snapshot.presentation?.sessions.items.find((session) => session.sessionId === sessionId);
}

/** The live timeline of one run, as the replica currently holds it. */
function liveOf(snapshot: ClientSnapshot, runId: string) {
  return snapshot.live[runId]?.live ?? [];
}

/**
 * Whether a run's summary is terminal and its draft is gone.
 *
 * A timeline lives in the replica's live map, never on the summary: a settled
 * run is one whose status is terminal *and* whose timeline is no longer held.
 */
function settled(snapshot: ClientSnapshot, runId: string): boolean {
  const run = runIn(snapshot, runId);
  return run !== undefined && run.status !== "accepted" && run.status !== "running" && snapshot.live[runId] === undefined;
}

function runIn(snapshot: ClientSnapshot, runId: string): RunSummary | undefined {
  return snapshot.presentation?.runs.items.find((run) => run.runId === runId);
}

/**
 * Walks a session's history from its fence back to its start, page by page, and
 * returns what the client recorded.
 *
 * The walk is bounded by the page's own `nextCursor`: v2 history is read in
 * bounded windows, so "the whole conversation" is a traversal, not one read.
 * A page that travelled but never landed in the replica's coverage would leave
 * the store holding a conversation nobody read, which is what the check refuses.
 */
async function readCanonical(client: Client, sessionId: string): Promise<readonly CanonicalItem[]> {
  const pages: (readonly CanonicalItem[])[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await client.sessions.history(cursor === undefined ? { sessionId } : { sessionId, cursor });
    pages.unshift(result.page.items);
    const next = result.page.nextCursor;
    if (next === null) break;
    cursor = next;
  }

  const read = pages.flat();
  const loaded = client.getSnapshot().history[sessionId]?.items ?? [];
  if (loaded.length !== read.length || loaded.some((item, index) => item.id !== read[index]?.id)) {
    throw new Error("the client did not record the history it read");
  }
  return loaded;
}
