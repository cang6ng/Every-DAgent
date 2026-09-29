/**
 * Runs: who may start one, what happens while it is alive, and how it ends.
 *
 * Three rules shape everything in this module.
 *
 * Ownership is taken before a run exists and released only after the Runtime's
 * iterator has settled — not when `turn/end` arrives, not when `abort()` is
 * called. The stream's own completion is the only event that means the Core is
 * done, and everything that must not overlap it waits on exactly that.
 *
 * Publication never gates work. The drain is owned by the host, so a run
 * finishes with no subscriber, no client, and no reading browser, or with a
 * connection that dies mid-flight.
 *
 * A fact is only announced once the host knows it can express it. The event is
 * built, checked, and only then applied to host state and sent, so a terminal
 * correction is either fully visible or not visible at all.
 */

import type { AgentRuntime, RuntimeEvent, Session, TurnEndReason } from "@every-dagent/agent-core";
import type {
  LiveToolItem,
  OperationMap,
  SessionSnapshot,
  TerminalRunSnapshot,
} from "@every-dagent/protocol";

import {
  assertEventBuilds,
  publishEvent,
  publishValidatedEvent,
  runEndedEvent,
  runOutputDeltaEvent,
  runToolCallEvent,
  runToolResultEvent,
  runUpdatedEvent,
  type EventBuilder,
} from "./connection.js";
import { protocolError, shuttingDownError } from "./errors.js";
import { ProjectionError, projectDisplayInput, projectSettledTurn } from "./projection.js";
import {
  activeRunSnapshotOf,
  newId,
  operationFailed,
  operationSucceeded,
  runSnapshotOf,
  sessionEntryOf,
  trackTask,
  withActiveRun,
  withCanonical,
  type HostState,
  type OperationOutcome,
  type RunEntry,
} from "./state.js";

type RunResult = OperationMap["runs.start"]["result"];

/**
 * Accepts one submission, or reports why it was refused.
 *
 * The whole admission is one synchronous step, and it is the only place a run
 * begins: the registry token, the run record, the submission record, the
 * session's active-run pointer and the accepted event all land together. A
 * second submission arriving before this one returns finds the records already
 * in place, so "two runs from one submission" is not a race to be survived but
 * a state that cannot be reached.
 */
export function startRun(
  state: HostState,
  params: { readonly sessionId: string; readonly submissionId: string; readonly text: string },
): OperationOutcome<RunResult> {
  // Dedup comes first, and it outranks busy: a resubmitted request that was
  // already accepted returns its original run even while the host is occupied.
  const claimed = state.submissions.get(params.submissionId);
  if (claimed !== undefined) {
    const previous = state.runs.get(claimed);
    if (previous !== undefined) {
      if (previous.sessionId === params.sessionId && previous.text === params.text) {
        return operationSucceeded({ run: runSnapshotOf(previous) });
      }
      return operationFailed(protocolError("SUBMISSION_CONFLICT"));
    }
  }

  if (state.closing) return operationFailed(shuttingDownError());

  const entry = state.sessions.get(params.sessionId);
  if (entry === undefined) return operationFailed(protocolError("SESSION_NOT_FOUND"));
  if (entry.published.status === "blocked") {
    return operationFailed(protocolError("SESSION_UNAVAILABLE"));
  }
  if (entry.published.activeRunId !== null) {
    return operationFailed(protocolError("SESSION_UNAVAILABLE"));
  }

  // Waiting is not an option the contract offers, so the decision is made by
  // execution order: either this call has the registry or it does not.
  const lease = state.gate.tryAcquire("execution");
  if (lease === undefined) return operationFailed(protocolError("HOST_BUSY"));

  const run: RunEntry = {
    runId: newId(),
    submissionId: params.submissionId,
    sessionId: params.sessionId,
    text: params.text,
    controller: new AbortController(),
    lease,
    turnId: null,
    cancelRequested: false,
    stage: "accepted",
    live: [],
    textItemIndex: undefined,
    posTool: undefined,
    nextLiveId: 0,
    observedEnd: undefined,
    faulted: false,
    terminal: undefined,
  };

  const accepted = activeRunSnapshotOf(run);
  const build = runUpdatedEvent(run, accepted);
  const session = withActiveRun(entry.published, run.runId);

  try {
    assertEventBuilds(state, build);
  } catch {
    lease.release();
    return operationFailed(protocolError("INTERNAL_ERROR"));
  }

  state.runs.set(run.runId, run);
  state.runOrder.push(run.runId);
  state.submissions.set(params.submissionId, run.runId);
  entry.published = session;
  publishEvent(state, build);

  // The drain is registered before it can observe anything, and deferred to a
  // microtask so the accepted state — and this operation's response — are in
  // place before the turn produces its first event.
  trackTask(
    state,
    Promise.resolve().then(() => drainRun(state, run)),
  );

  return operationSucceeded({ run: accepted });
}

/**
 * Requests cancellation of one run.
 *
 * The request is recorded and announced, and the signal is then aborted — after
 * the state change, because abort listeners are arbitrary code and this path
 * runs none of it inside a commit. Nothing here waits for the turn to stop: the
 * caller gets the current snapshot, and the run's real outcome arrives when the
 * Core settles.
 */
export function cancelRun(state: HostState, runId: string): OperationOutcome<RunResult> {
  const run = state.runs.get(runId);
  if (run === undefined) return operationFailed(protocolError("RUN_NOT_FOUND"));
  if (run.terminal !== undefined) return operationSucceeded({ run: run.terminal });

  if (!run.cancelRequested) {
    run.cancelRequested = true;
    try {
      publishValidatedEvent(state, runUpdatedEvent(run, activeRunSnapshotOf(run)));
    } catch {
      // The request stands whether or not it could be announced: a terminal
      // state, or a resync, is what a client acts on.
    }
    run.controller.abort();
  }

  return operationSucceeded({ run: runSnapshotOf(run) });
}

/**
 * Consumes the Runtime's stream to its end, whatever happens in between.
 *
 * The loop never breaks and never lets a projection failure escape: leaving
 * early would close the iterator, which is exactly the signal that the
 * execution may still be running. The lease is released in the one place that
 * knows the iterator is done.
 */
async function drainRun(state: HostState, run: RunEntry): Promise<void> {
  try {
    attempt(run, () => {
      if (run.stage === "running") return;
      run.stage = "running";
      publishValidatedEvent(state, runUpdatedEvent(run, activeRunSnapshotOf(run)));
    });

    let completed = false;
    try {
      const stream = runtimeStream(state, run);
      for await (const event of stream) {
        attempt(run, () => observeRuntimeEvent(state, run, event));
      }
      completed = true;
    } catch {
      completed = false;
    }

    finalizeRun(state, run, completed);
  } finally {
    run.lease.release();
  }
}

function runtimeStream(state: HostState, run: RunEntry): AsyncIterable<RuntimeEvent> {
  const session: Session = sessionEntryOf(state, run.sessionId).session;
  const runtime: AgentRuntime = state.runtime;
  return runtime.stream({ session, text: run.text, signal: run.controller.signal });
}

/**
 * Runs one projection step, recording instead of propagating a failure.
 *
 * From the first fault on, this run publishes no further increments: it keeps
 * draining so the execution can settle on its own terms, and then ends as a
 * host failure rather than as whatever the Core happened to be doing.
 */
function attempt(run: RunEntry, act: () => void): void {
  if (run.faulted) return;
  try {
    act();
  } catch {
    run.faulted = true;
  }
}

/** Validates the event, applies the state change, then publishes. In that order. */
function commitLive(state: HostState, build: EventBuilder, apply: () => void): void {
  assertEventBuilds(state, build);
  apply();
  publishEvent(state, build);
}

function observeRuntimeEvent(state: HostState, run: RunEntry, event: RuntimeEvent): void {
  if (event.sessionId !== run.sessionId) {
    throw new ProjectionError("a runtime event carried a foreign session id");
  }
  bindTurnId(state, run, event.turnId);

  switch (event.type) {
    case "assistant/chunk":
      appendLiveText(state, run, event.text);
      return;
    case "tool/call":
      openLiveToolCall(state, run, event);
      return;
    case "tool/result":
      closeLiveToolCall(state, run, event);
      return;
    case "turn/end":
      if (run.observedEnd !== undefined) {
        throw new ProjectionError("the stream reported two turn ends for one run");
      }
      // The reason is recorded, not published and not acted on: a turn end is
      // not a settled execution, and it becomes an outcome only once the
      // iterator has finished and the log agrees with it.
      run.observedEnd = event.reason;
      return;
  }
}

function bindTurnId(state: HostState, run: RunEntry, turnId: string): void {
  if (run.turnId === turnId) return;
  if (run.turnId !== null) {
    throw new ProjectionError("a run observed two different turn ids");
  }
  run.turnId = turnId;
  publishValidatedEvent(state, runUpdatedEvent(run, activeRunSnapshotOf(run)));
}

/**
 * Appends one text chunk to the open text item, or opens one.
 *
 * The delta is checked before the timeline moves, so a value the wire cannot
 * carry never becomes part of the run's published live view.
 */
function appendLiveText(state: HostState, run: RunEntry, text: string): void {
  const index = run.textItemIndex;
  let itemId: string;

  if (index === undefined) {
    itemId = newLiveId(run, "item");
    const item = Object.freeze({ kind: "text" as const, itemId, text });
    const build = runOutputDeltaEvent(run, itemId, text);
    commitLive(state, build, () => {
      run.textItemIndex = run.live.length;
      run.live.push(item);
    });
    return;
  }

  const previous = run.live[index];
  if (previous === undefined || previous.kind !== "text") {
    throw new ProjectionError("the live text item lost its place in the timeline");
  }
  itemId = previous.itemId;
  const build = runOutputDeltaEvent(run, itemId, text);
  commitLive(state, build, () => {
    run.live[index] = Object.freeze({ kind: "text" as const, itemId, text: previous.text + text });
  });
}

/**
 * Opens one tool occurrence.
 *
 * The occurrence — not the call id — is the identity: the Core allows an empty
 * call id and allows the same one to be used again in the next step, so two
 * calls that look alike are still two calls, each with its own item and its own
 * invocation id.
 */
function openLiveToolCall(
  state: HostState,
  run: RunEntry,
  event: Extract<RuntimeEvent, { type: "tool/call" }>,
): void {
  if (run.posTool !== undefined) {
    throw new ProjectionError("a tool call arrived while another call was still open");
  }

  const item: LiveToolItem = Object.freeze({
    kind: "tool" as const,
    itemId: newLiveId(run, "item"),
    invocationId: newLiveId(run, "call"),
    callId: event.callId,
    name: event.name,
    input: projectDisplayInput(event.input),
    result: null,
  });

  const build = runToolCallEvent(run, item);
  commitLive(state, build, () => {
    run.posTool = {
      index: run.live.length,
      invocationId: item.invocationId,
      callId: item.callId,
      name: item.name,
    };
    run.live.push(item);
    // A tool call ends the current text item: the next chunk starts a new one.
    run.textItemIndex = undefined;
  });
}

/**
 * Fills in the open occurrence.
 *
 * `ok: false` is recorded as it is: the Core reports a failed observation and
 * an undispatched call the same way, and the host does not guess which it was.
 */
function closeLiveToolCall(
  state: HostState,
  run: RunEntry,
  event: Extract<RuntimeEvent, { type: "tool/result" }>,
): void {
  const open = run.posTool;
  if (open === undefined) {
    throw new ProjectionError("a tool result arrived with no open call");
  }
  if (open.callId !== event.callId || open.name !== event.name) {
    throw new ProjectionError("a tool result did not match the open call");
  }

  const build = runToolResultEvent(run, open.invocationId, event.ok, event.content);
  commitLive(state, build, () => {
    const previous = run.live[open.index];
    if (previous === undefined || previous.kind !== "tool") {
      throw new ProjectionError("the open tool item lost its place in the timeline");
    }
    run.live[open.index] = Object.freeze({
      ...previous,
      result: Object.freeze({ ok: event.ok, content: event.content }),
    });
    run.posTool = undefined;
  });
}

interface TerminalCommit {
  readonly run: TerminalRunSnapshot;
  readonly session: SessionSnapshot;
  /** The log cursor this commit publishes up to. */
  readonly nextSeq: number;
  readonly build: EventBuilder;
}

function finalizeRun(state: HostState, run: RunEntry, completed: boolean): void {
  if (completed && !run.faulted) {
    const record = coreTerminal(state, run);
    if (record !== undefined && applyTerminal(state, run, record)) return;
  }

  const failure = hostFaultTerminal(state, run);
  if (applyTerminal(state, run, failure)) return;

  // Unreachable: the failure commit is built from state the protocol already
  // accepted, so it cannot fail its own check. It is here so that a future
  // change which breaks that assumption leaves the host's own directories
  // consistent — a settled run and a session that no longer points at it —
  // rather than a run that stays active forever.
  applyTerminalLocally(state, run, failure);
}

/** The Core's own outcome, read from the settled log — or `undefined` if the host cannot vouch for it. */
function coreTerminal(state: HostState, run: RunEntry): TerminalCommit | undefined {
  try {
    const entry = sessionEntryOf(state, run.sessionId);
    const events = entry.session.events().slice(entry.publishedSeq);
    if (events.length === 0) {
      throw new ProjectionError("the run settled without recording a turn");
    }

    const turn = projectSettledTurn(run.sessionId, events, run.text);
    if (run.observedEnd === undefined) {
      throw new ProjectionError("the stream ended without reporting a turn end");
    }
    if (run.observedEnd !== turn.reason) {
      throw new ProjectionError("the stream outcome disagrees with the recorded turn");
    }

    const terminal = terminalSnapshotOf(run, turn.reason);
    const session = withCanonical(entry.published, [...entry.published.canonical, ...turn.items]);
    return {
      run: terminal,
      session,
      nextSeq: entry.publishedSeq + events.length,
      build: runEndedEvent(run, terminal, session),
    };
  } catch {
    return undefined;
  }
}

/**
 * The host's own failure outcome.
 *
 * The previously published canonical is kept exactly as it is and the session
 * is blocked: a turn the host could not validate is not repaired, not
 * completed, and not turned into history.
 */
function hostFaultTerminal(state: HostState, run: RunEntry): TerminalCommit {
  const entry = sessionEntryOf(state, run.sessionId);
  const terminal: TerminalRunSnapshot = Object.freeze({
    runId: run.runId,
    submissionId: run.submissionId,
    sessionId: run.sessionId,
    text: run.text,
    turnId: run.turnId,
    cancelRequested: run.cancelRequested,
    status: "failed" as const,
    endReason: "host_error" as const,
    error: protocolError("INTERNAL_ERROR"),
    live: null,
  });
  const session: SessionSnapshot = Object.freeze({
    ...entry.published,
    status: "blocked" as const,
    activeRunId: null,
  });

  return {
    run: terminal,
    session,
    nextSeq: entry.publishedSeq,
    build: runEndedEvent(run, terminal, session),
  };
}

function terminalSnapshotOf(run: RunEntry, reason: TurnEndReason): TerminalRunSnapshot {
  const base = {
    runId: run.runId,
    submissionId: run.submissionId,
    sessionId: run.sessionId,
    text: run.text,
    turnId: run.turnId,
    cancelRequested: run.cancelRequested,
  };

  switch (reason) {
    case "completed":
      return Object.freeze({
        ...base,
        status: "completed" as const,
        endReason: "completed" as const,
        error: null,
        live: null,
      });
    case "max_steps":
      return Object.freeze({
        ...base,
        status: "limited" as const,
        endReason: "max_steps" as const,
        error: null,
        live: null,
      });
    case "cancelled":
      return Object.freeze({
        ...base,
        status: "cancelled" as const,
        endReason: "cancelled" as const,
        error: null,
        live: null,
      });
    case "error":
      return Object.freeze({
        ...base,
        status: "failed" as const,
        endReason: "error" as const,
        error: protocolError("INTERNAL_ERROR"),
        live: null,
      });
  }
}

/**
 * The terminal correction, as one indivisible step.
 *
 * Everything a reader could ask about moves here and nowhere else: the run
 * becomes terminal with no live timeline, the session loses its active-run
 * pointer and gains the newly settled items, and the single event that carries
 * both is queued. There is no `await` and no call into the channel between
 * these lines, so a read or a snapshot cannot land in the middle of it.
 */
function applyTerminal(state: HostState, run: RunEntry, record: TerminalCommit): boolean {
  try {
    assertEventBuilds(state, record.build);
  } catch {
    return false;
  }

  run.terminal = record.run;
  const entry = sessionEntryOf(state, run.sessionId);
  entry.published = record.session;
  entry.publishedSeq = record.nextSeq;
  publishEvent(state, record.build);
  return true;
}

/** The same commit without an announcement. See the note in `finalizeRun`. */
function applyTerminalLocally(state: HostState, run: RunEntry, record: TerminalCommit): void {
  run.terminal = record.run;
  const entry = sessionEntryOf(state, run.sessionId);
  entry.published = record.session;
  entry.publishedSeq = record.nextSeq;
}

function newLiveId(run: RunEntry, kind: string): string {
  run.nextLiveId += 1;
  return `${run.runId}:${kind}${run.nextLiveId}`;
}
