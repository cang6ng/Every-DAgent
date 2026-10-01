/**
 * Runs: who may start one, what happens while it is alive, and how it ends.
 *
 * Four rules shape everything in this module.
 *
 * Durable before live, always. A run is committed as accepted before it is
 * announced, its start marker is committed before the Runtime is handed
 * anything to execute, and its terminal is committed before any client is told
 * the outcome. Each of those is a single synchronous transaction, so there is
 * no window in which the host has said something it has not recorded.
 *
 * Ownership is taken before a run exists and released only after the Runtime's
 * iterator has settled — not when `turn/end` arrives, not when `abort()` is
 * called. The stream's own completion is the only event that means the Core is
 * done, and everything that must not overlap it waits on exactly that.
 *
 * A window, not a session. Each run loads the bounded suffix of committed turns
 * it needs and releases it when it settles; the rest of the log stays in
 * storage. That is why a long conversation costs the same as a short one to
 * continue, and why nothing here can accidentally read all of history.
 *
 * Publication never gates work. The drain is owned by the host, so a run
 * finishes with no subscriber, no client, and no reading browser, or with a
 * connection that dies mid-flight.
 */

import { restoreSessionWindow } from "@every-dagent/agent-core";
import type { AgentRuntime, RuntimeEvent, Session, TurnEndReason } from "@every-dagent/agent-core";
import type {
  LiveToolItem,
  OperationMap,
  ProtocolError,
  SessionSummary,
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
  sessionUpdatedEvent,
  type EventBuilder,
} from "./connection.js";
import {
  limitExceededError,
  protocolError,
  shuttingDownError,
  storageUnavailableError,
  storedProtocolError,
} from "./errors.js";
import { sessionSummaryOf } from "./history.js";
import { ProjectionError, projectDisplayInput, projectSettledTurn } from "./projection.js";
import {
  encodeStoredData,
  RecordTooLargeError,
  submissionHash,
  toSessionEvent,
  type CommitTurnResult,
  type StoredRecord,
} from "./repository.js";
import {
  activeRunSnapshotOf,
  newId,
  operationFailed,
  operationSucceeded,
  runSnapshotOf,
  runSnapshotOfRecord,
  terminalSnapshotOfRecord,
  trackTask,
  type HostState,
  type OperationOutcome,
  type RunEntry,
  type TerminatedRun,
} from "./state.js";

type RunResult = OperationMap["runs.start"]["result"];

/** How many turns and bytes one execution window may load. Not a history cap — a per-run read bound. */
const WINDOW_MAX_TURNS = 16;
const WINDOW_MAX_BYTES = 256 * 1024;

/** How much live timeline one run may publish before the view is marked truncated. */
const MAX_LIVE_ITEMS = 200;
const MAX_LIVE_BYTES = 128 * 1024;

/**
 * Accepts one submission, or reports why it was refused.
 *
 * The durable admission is one transaction and it is the only place a run
 * begins: the submission identity, the accepted run, the session's active-run
 * pointer and its revision all land together, or none of them do. A second
 * submission arriving before this one returns finds the records already in
 * place, so "two runs from one submission" is not a race to be survived but a
 * state that cannot be reached.
 *
 * The dedup read comes first, before the execution lease is taken, because a
 * resubmitted request that was already accepted has to answer with its original
 * run even while this host is busy with something else.
 */
export function startRun(
  state: HostState,
  params: { readonly sessionId: string; readonly submissionId: string; readonly text: string },
): OperationOutcome<RunResult> {
  const textBytes = Buffer.byteLength(params.text, "utf8");
  if (textBytes > state.limits.maxInputBytes) {
    // Refused before admission, so nothing is recorded that could not be
    // answered later: the input bound is checked while it is still a request.
    return operationFailed(limitExceededError());
  }
  if (state.closing) return operationFailed(shuttingDownError());

  const inputHash = submissionHash(params.sessionId, params.text);
  const known = state.repository.getSubmission(params.submissionId);
  if (known !== undefined) {
    if (known.state === "retired") return operationFailed(protocolError("SUBMISSION_RETIRED"));
    if (known.sessionId !== params.sessionId || known.inputHash !== inputHash) {
      return operationFailed(protocolError("SUBMISSION_CONFLICT"));
    }
    const previous = known.runId === null ? undefined : state.repository.getRun(known.runId);
    if (previous !== undefined) return operationSucceeded({ run: runSnapshotOfRecord(previous, storedError(previous.errorCode)) });
    return operationFailed(protocolError("SUBMISSION_CONFLICT"));
  }

  if (state.storageFault) return operationFailed(storageUnavailableError());

  // Waiting is not an option the contract offers, so the decision is made by
  // execution order: either this call has the registry or it does not. A ready
  // session that already has a run is exactly this case — the run holding it
  // still owns the token — so the honest answer is HOST_BUSY, not a claim that
  // the session cannot be used.
  const lease = state.gate.tryAcquire("execution");
  if (lease === undefined) return operationFailed(protocolError("HOST_BUSY"));

  const runId = newId();
  const acceptedAt = Date.now();

  let admission;
  try {
    admission = state.repository.admitRun({
      runId,
      submissionId: params.submissionId,
      sessionId: params.sessionId,
      text: params.text,
      inputHash,
      hostInstanceId: state.hostInstanceId,
      acceptedAt,
    });
  } catch {
    markStorageFault(state);
    lease.release();
    return operationFailed(storageUnavailableError());
  }

  switch (admission.kind) {
    case "conflict":
      lease.release();
      return operationFailed(protocolError("SUBMISSION_CONFLICT"));
    case "retired":
      lease.release();
      return operationFailed(protocolError("SUBMISSION_RETIRED"));
    case "session-not-found":
      lease.release();
      return operationFailed(protocolError("SESSION_NOT_FOUND"));
    case "session-blocked":
      lease.release();
      return operationFailed(protocolError("SESSION_UNAVAILABLE"));
    case "session-busy":
      lease.release();
      return operationFailed(protocolError("HOST_BUSY"));
    case "existing":
      // Another connection admitted this submission between the read above and
      // this transaction. Its run is the answer, and this call executes nothing.
      lease.release();
      return operationSucceeded({
        run: runSnapshotOfRecord(admission.run, storedError(admission.run.errorCode)),
      });
    case "admitted":
      break;
  }

  const run: RunEntry = {
    runId,
    submissionId: params.submissionId,
    sessionId: params.sessionId,
    text: params.text,
    controller: new AbortController(),
    lease,
    acceptedAt,
    startedAt: null,
    turnId: null,
    cancelRequested: false,
    stage: "accepted",
    live: [],
    liveBytes: 0,
    liveTruncated: false,
    textItemIndex: undefined,
    posTool: undefined,
    nextLiveId: 0,
    observedEnd: undefined,
    faulted: false,
    window: undefined,
    terminal: undefined,
  };

  const accepted = activeRunSnapshotOf(run);
  const build = runUpdatedEvent(run, accepted);
  try {
    assertEventBuilds(state, build);
  } catch {
    // The run is durable and will be reconciled at the next start; this host
    // simply cannot describe it, so it may not execute it either.
    lease.release();
    return operationFailed(protocolError("INTERNAL_ERROR"));
  }

  // The run's completion handle is registered before anything that could call
  // out of the host. Publishing an accepted event can close an over-full
  // connection synchronously, and a shutdown that is already waiting must
  // already be able to see this run — otherwise it would report a clean
  // shutdown while a turn is about to start.
  const task = Promise.resolve().then(() => drainRun(state, run));
  trackTask(state, task);

  state.runs.set(run.runId, run);
  publishEvent(state, build);
  return operationSucceeded({ run: accepted });
}

/**
 * Requests cancellation of one run.
 *
 * The order is deliberate. The intent is recorded durably first, the signal is
 * aborted second — outside any state transaction, because abort listeners are
 * arbitrary code — and only then is the change expressed as an event. Nothing
 * waits for the turn to stop: the caller gets the current snapshot, and the
 * run's real outcome arrives when the Core settles.
 *
 * A store that cannot record the intent is reported as a failure rather than
 * dressed up as a durable request — but it never stops the abort. Stopping work
 * is the one thing a broken store must not prevent.
 */
export function cancelRun(state: HostState, runId: string): OperationOutcome<RunResult> {
  const run = state.runs.get(runId);
  if (run !== undefined) {
    if (run.terminal !== undefined) return operationSucceeded({ run: run.terminal.snapshot });
    if (run.cancelRequested) return operationSucceeded({ run: runSnapshotOf(run) });

    run.cancelRequested = true;
    let durable = true;
    try {
      state.repository.requestCancel(runId, Date.now());
    } catch {
      markStorageFault(state);
      durable = false;
    }

    run.controller.abort();
    try {
      publishValidatedEvent(state, runUpdatedEvent(run, activeRunSnapshotOf(run)));
    } catch {
      run.faulted = true;
    }

    return durable
      ? operationSucceeded({ run: runSnapshotOf(run) })
      : operationFailed(storageUnavailableError());
  }

  const record = state.repository.getRun(runId);
  if (record === undefined) return operationFailed(protocolError("RUN_NOT_FOUND"));
  if (record.status === "accepted" || record.status === "running") {
    // Reconciliation runs before this host is ready, so an unfinished run with
    // no live entry is not a state this host can act on.
    return operationFailed(protocolError("HOST_BUSY"));
  }
  // A committed terminal is never re-opened, and cancelling one executes nothing.
  return operationSucceeded({ run: runSnapshotOfRecord(record, storedError(record.errorCode)) });
}

/**
 * Reads one run: the live one if this host is running it, otherwise the durable
 * record. Never an execution.
 */
export function readRun(state: HostState, params: { readonly runId?: string; readonly submissionId?: string }): OperationOutcome<RunResult> {
  if (params.runId !== undefined) {
    const live = state.runs.get(params.runId);
    if (live !== undefined) return operationSucceeded({ run: runSnapshotOf(live) });
    const record = state.repository.getRun(params.runId);
    if (record === undefined) return operationFailed(protocolError("RUN_NOT_FOUND"));
    return operationSucceeded({ run: runSnapshotOfRecord(record, storedError(record.errorCode)) });
  }

  const submissionId = params.submissionId;
  if (submissionId === undefined) return operationFailed(protocolError("INVALID_REQUEST"));
  const known = state.repository.getSubmission(submissionId);
  if (known === undefined) return operationFailed(protocolError("RUN_NOT_FOUND"));
  if (known.state === "retired") return operationFailed(protocolError("SUBMISSION_RETIRED"));
  if (known.runId === null) return operationFailed(protocolError("RUN_NOT_FOUND"));
  const live = state.runs.get(known.runId);
  if (live !== undefined) return operationSucceeded({ run: runSnapshotOf(live) });
  const record = state.repository.getRun(known.runId);
  if (record === undefined) return operationFailed(protocolError("RUN_NOT_FOUND"));
  return operationSucceeded({ run: runSnapshotOfRecord(record, storedError(record.errorCode)) });
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
    if (!beginRun(state, run)) return;

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
    run.window = undefined;
    run.lease.release();
  }
}

/**
 * The durable start marker, taken before the Runtime exists.
 *
 * Everything the run will do waits on this: a run whose start was never
 * committed may not call a model or a tool, because the record would then
 * disagree with what actually happened. A store that cannot record the start
 * stops the run here, and the accepted record stays behind for the next start
 * to reconcile as `not-started`.
 */
function beginRun(state: HostState, run: RunEntry): boolean {
  try {
    const record = state.repository.markRunStarted(run.runId, state.hostInstanceId, Date.now());
    run.startedAt = record.startedAt ?? Date.now();
    run.stage = "running";
  } catch {
    markStorageFault(state);
    failRun(state, run);
    return false;
  }

  attempt(run, () => {
    publishValidatedEvent(state, runUpdatedEvent(run, activeRunSnapshotOf(run)));
  });

  const window = loadWindow(state, run);
  if (window === undefined) {
    run.faulted = true;
    failRun(state, run);
    return false;
  }
  run.window = window;
  return true;
}

/**
 * The bounded suffix of committed turns this run continues.
 *
 * The window is a read of storage, not a restore of the session: a long
 * conversation costs the same here as a short one, and the part that is not
 * loaded is never presented as if it were.
 */
function loadWindow(state: HostState, run: RunEntry): RunEntry["window"] {
  try {
    const read = state.repository.readTurnWindow(run.sessionId, WINDOW_MAX_TURNS, WINDOW_MAX_BYTES);
    const session: Session = restoreSessionWindow(run.sessionId, {
      baseSeq: read.baseSeq,
      nextSeq: read.nextSeq,
      events: read.records.map(toSessionEvent),
    });
    return { session, baseSeq: read.baseSeq, loadedSeq: read.records.length };
  } catch {
    return undefined;
  }
}

function runtimeStream(state: HostState, run: RunEntry): AsyncIterable<RuntimeEvent> {
  const window = run.window;
  if (window === undefined) throw new ProjectionError("the run has no loaded window");
  const runtime: AgentRuntime = state.runtime;
  return runtime.stream({ session: window.session, text: run.text, signal: run.controller.signal });
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
      // iterator has finished and the committed log agrees with it.
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

/** Whether the live timeline is still being published, and still within its bounds. */
function liveHasRoom(run: RunEntry, cost: number): boolean {
  if (run.liveTruncated) return false;
  if (run.live.length >= MAX_LIVE_ITEMS || run.liveBytes + cost > MAX_LIVE_BYTES) {
    // The run keeps going; only the view stops growing, and it says so.
    run.liveTruncated = true;
    return false;
  }
  return true;
}

/**
 * Appends one text chunk to the open text item, or opens one.
 *
 * The delta is checked before the timeline moves, so a value the wire cannot
 * carry never becomes part of the run's published live view.
 */
function appendLiveText(state: HostState, run: RunEntry, text: string): void {
  if (!liveHasRoom(run, Buffer.byteLength(text, "utf8"))) return;

  const index = run.textItemIndex;
  let itemId: string;

  if (index === undefined) {
    itemId = newLiveId(run, "item");
    const item = Object.freeze({ kind: "text" as const, itemId, text });
    const build = runOutputDeltaEvent(run, itemId, text);
    commitLive(state, build, () => {
      run.textItemIndex = run.live.length;
      run.live.push(item);
      run.liveBytes += Buffer.byteLength(text, "utf8");
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
    run.liveBytes += Buffer.byteLength(text, "utf8");
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
  if (!liveHasRoom(run, 256)) return;

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
    run.liveBytes += 256;
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
  if (run.liveTruncated) return;

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

/** The committed suffix one settled run is about to add. */
interface TerminalBatch {
  readonly turnId: string;
  readonly reason: TurnEndReason;
  readonly turnStartSeq: number;
  readonly records: readonly StoredRecord[];
}

function finalizeRun(state: HostState, run: RunEntry, completed: boolean): void {
  if (completed && !run.faulted) {
    const batch = coreTerminal(state, run);
    if (batch !== undefined && commitTerminal(state, run, batch)) return;
  }
  failRun(state, run);
}

/**
 * The Core's own outcome, read from the settled window — or `undefined` if the
 * host cannot vouch for it.
 *
 * This is where a run stops being tentative. The events the turn appended are
 * the only source: not the live timeline, not the stream's own end event. A
 * segment that is incomplete, misnumbered, or about a different turn than the
 * one this run bound is refused, and the run ends as a host failure instead of
 * becoming a plausible but wrong history.
 */
function coreTerminal(state: HostState, run: RunEntry): TerminalBatch | undefined {
  try {
    const window = run.window;
    if (window === undefined) throw new ProjectionError("the run never loaded a window");
    const events = window.session.events().slice(window.loadedSeq);
    if (events.length === 0) {
      throw new ProjectionError("the run settled without recording a turn");
    }
    if (run.observedEnd === undefined) {
      throw new ProjectionError("the stream ended without reporting a turn end");
    }
    if (run.turnId === null) {
      throw new ProjectionError("the run recorded a turn it never bound");
    }

    const turnStartSeq = window.baseSeq + window.loadedSeq;
    const turn = projectSettledTurn({
      sessionId: run.sessionId,
      events,
      expectedText: run.text,
      expectedTurnId: run.turnId,
      startSeq: turnStartSeq,
    });
    if (run.observedEnd !== turn.reason) {
      throw new ProjectionError("the stream outcome disagrees with the recorded turn");
    }

    const records: StoredRecord[] = events.map((event) =>
      Object.freeze({
        seq: event.seq,
        turnId: event.turnId,
        type: event.type,
        time: event.time,
        data: encodeStoredData(event),
      }),
    );
    return { turnId: run.turnId, reason: turn.reason, turnStartSeq, records };
  } catch {
    return undefined;
  }
}

/**
 * The terminal commit: the turn's events, the run's outcome and the session's
 * new summary, in one transaction.
 *
 * Nothing is published before this returns. A commit that fails leaves the
 * durable record exactly as it was — an unfinished run the next start will
 * reconcile — and this host then says what it honestly can, which is not the
 * same as claiming the outcome was recorded.
 */
function commitTerminal(state: HostState, run: RunEntry, batch: TerminalBatch): boolean {
  let result: CommitTurnResult;
  try {
    result = state.repository.commitTurn({
      runId: run.runId,
      sessionId: run.sessionId,
      turnId: batch.turnId,
      reason: batch.reason,
      turnStartSeq: batch.turnStartSeq,
      records: batch.records,
      endedAt: Date.now(),
    });
  } catch (error) {
    if (error instanceof RecordTooLargeError) {
      // A settled turn the store cannot keep whole. Truncating it would make a
      // different conversation, so the turn is refused and the session is
      // blocked with the old canonical untouched.
      markSessionBlocked(state, run.sessionId);
      return false;
    }
    markStorageFault(state);
    return false;
  }

  const snapshot = terminalSnapshotOfRecord(result.run, null);
  const summary = sessionSummaryOf(result.session);
  applyTerminal(state, run, { snapshot, summary, revisions: result.revisions });
  return true;
}

/**
 * The host's own failure outcome.
 *
 * The previously committed canonical is kept exactly as it is and the session
 * is blocked: a turn the host could not validate or could not keep whole is not
 * repaired, not completed, and not turned into history. When the store cannot
 * record even this, the in-memory outcome is published and the durable record
 * deliberately stays unfinished — the next start will reconcile it to
 * `interrupted`, which is what the store actually knows.
 */
function failRun(state: HostState, run: RunEntry): void {
  const at = Date.now();
  const failure = protocolError("INTERNAL_ERROR");

  if (!state.storageFault) {
    try {
      const result = state.repository.failRun({
        runId: run.runId,
        sessionId: run.sessionId,
        blockedReason: "host-fault",
        errorCode: failure.code,
        endedAt: at,
        turnId: run.turnId,
      });
      applyTerminal(state, run, {
        snapshot: terminalSnapshotOfRecord(result.run, failure),
        summary: sessionSummaryOf(result.session),
        revisions: result.revisions,
      });
      return;
    } catch {
      markStorageFault(state);
    }
  }

  const summary = readSummary(state, run.sessionId);
  if (summary === null) {
    // Even the session cannot be read. The run is marked terminal for this
    // host's own readers and nothing is published, because there is no honest
    // session summary to publish it with.
    run.terminal = {
      snapshot: localFailureSnapshot(run, failure),
      summary: localBlockedSummary(run.sessionId),
      revisions: state.repository.revisions,
    };
    return;
  }
  applyTerminal(state, run, {
    snapshot: localFailureSnapshot(run, failure),
    summary: Object.freeze({ ...summary, status: "blocked" as const, blockedReason: "host-fault" as const, activeRunId: null }),
    revisions: state.repository.revisions,
  });
}

function localFailureSnapshot(run: RunEntry, error: ProtocolError): TerminalRunSnapshot {
  return Object.freeze({
    runId: run.runId,
    submissionId: run.submissionId,
    sessionId: run.sessionId,
    text: run.text,
    turnId: run.turnId,
    cancelRequested: run.cancelRequested,
    acceptedAt: run.acceptedAt,
    startedAt: run.startedAt,
    endedAt: Date.now(),
    status: "failed" as const,
    endReason: "host_error" as const,
    error,
    executionKnowledge: null,
    live: null,
  });
}

function localBlockedSummary(sessionId: string): SessionSummary {
  // Only reached when the session row itself cannot be read; the fields are the
  // minimum a blocked session has to state, and none of them is invented.
  return Object.freeze({
    sessionId,
    generation: 1,
    title: "会话",
    createdAt: 0,
    updatedAt: 0,
    status: "blocked" as const,
    blockedReason: "host-fault" as const,
    metadataRevision: 0,
    historyRevision: 0,
    committedSeq: 0,
    activeRunId: null,
  });
}

function readSummary(state: HostState, sessionId: string): SessionSummary | null {
  try {
    const record = state.repository.getSession(sessionId);
    return record === undefined ? null : sessionSummaryOf(record);
  } catch {
    return null;
  }
}

/**
 * The terminal correction, as one indivisible step.
 *
 * Everything a reader could ask about moves here and nowhere else: the run
 * becomes terminal with no live timeline, the session's summary is replaced
 * with the one the commit produced, and the single event that carries both is
 * queued. There is no `await` and no call into the channel between these lines,
 * so a read or a snapshot cannot land in the middle of it.
 */
function applyTerminal(state: HostState, run: RunEntry, record: TerminatedRun): void {
  const build = runEndedEvent(run, record.snapshot, record.summary, record.revisions);
  try {
    assertEventBuilds(state, build);
  } catch {
    applyTerminalLocally(state, run, record);
    return;
  }

  run.terminal = record;
  publishEvent(state, build);
}

/** The same commit without an announcement. */
function applyTerminalLocally(state: HostState, run: RunEntry, record: TerminatedRun): void {
  run.terminal = record;
}

function newLiveId(run: RunEntry, kind: string): string {
  run.nextLiveId += 1;
  return `${run.runId}:${kind}${run.nextLiveId}`;
}

function storedError(code: string | null): ProtocolError | null {
  return code === null ? null : storedProtocolError(code);
}

/** Marks the host unable to confirm writes, and says so once. */
export function markStorageFault(state: HostState): void {
  state.storageFault = true;
}

/** Blocks one session without a run outcome: the store refused a record it could not keep whole. */
function markSessionBlocked(state: HostState, sessionId: string): void {
  try {
    const summary = readSummary(state, sessionId);
    if (summary === null) return;
    const blocked = Object.freeze({
      ...summary,
      status: "blocked" as const,
      blockedReason: "host-fault" as const,
      activeRunId: null,
    });
    publishEvent(state, sessionUpdatedEvent(blocked, state.repository.revisions));
  } catch {
    // A session that cannot be read cannot be announced; the run's own failure
    // still reports what happened.
  }
}
