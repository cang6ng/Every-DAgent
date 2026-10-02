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
import type { LiveToolItem, OperationMap, ProtocolError } from "@every-dagent/protocol";

import {
  assertEventBuilds,
  closeConnection,
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
  assertStoredRange,
  CommitOutcomeUnknownError,
  encodedBytes,
  encodeStoredData,
  StoreUntrustedError,
  submissionHash,
  toSessionEvent,
  userRecordFits,
  type CommitTurnInput,
  type CommitTurnResult,
  type RunRecord,
  type SessionRecord,
  type StoredRecord,
} from "./repository.js";
import {
  activeRunSnapshotOf,
  newId,
  operationFailed,
  operationSucceeded,
  retireRun,
  runSnapshotOf,
  runSnapshotOfRecord,
  snapshotFrameFits,
  snapshotOfProspectiveRun,
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

/** What one live item's own envelope costs on top of its encoded content. */
const LIVE_ITEM_OVERHEAD = 192;

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
  if (!userRecordFits(params.text, state.limits.maxRecordBytes)) {
    // The raw bound is not the durable bound. A 16 KiB input of control
    // characters escapes to far more than one record may hold, and that is
    // knowable now — before a submission, a run, a model call or a tool. An
    // input whose user fact could never be stored is refused as a request.
    return operationFailed(limitExceededError());
  }
  if (state.closing) return operationFailed(shuttingDownError());

  const inputHash = submissionHash(params.sessionId, params.text);
  let known;
  try {
    known = state.repository.getSubmission(params.submissionId);
  } catch (error) {
    if (error instanceof StoreUntrustedError) return operationFailed(storageUnavailableError());
    return operationFailed(protocolError("INTERNAL_ERROR"));
  }
  if (known !== undefined) {
    if (known.state === "retired") return operationFailed(protocolError("SUBMISSION_RETIRED"));
    if (known.sessionId !== params.sessionId || known.inputHash !== inputHash) {
      return operationFailed(protocolError("SUBMISSION_CONFLICT"));
    }
    const previous = known.runId === null ? undefined : state.repository.getRun(known.runId);
    if (previous !== undefined) {
      // A resubmission is answered with its original run — and only when that
      // run is the fact it claims. A terminal that disagrees with its own
      // history is not a dedup answer but corruption: the session is stopped,
      // and this request is refused instead of being served a repaired record.
      if (!servesRun(state, previous)) return operationFailed(refuseCorruptRun(state, previous));
      return operationSucceeded({ run: runSnapshotOfRecord(previous, storedError(previous.errorCode)) });
    }
    return operationFailed(protocolError("SUBMISSION_CONFLICT"));
  }

  if (state.storageFault) return operationFailed(storageUnavailableError());

  const runId = newId();
  const acceptedAt = Date.now();

  // The safe answer has to exist before the input is accepted. The cut a
  // subscriber would receive is composed exactly as this admission would leave
  // it — this session, this run, this input and this submission identity — and
  // held to one frame; a request whose accepted run could never be published is
  // refused as a request, while nothing durable has happened yet.
  let sessionRecord;
  try {
    sessionRecord = state.repository.getSession(params.sessionId);
  } catch (error) {
    if (error instanceof StoreUntrustedError) return operationFailed(storageUnavailableError());
    return operationFailed(protocolError("INTERNAL_ERROR"));
  }
  // Only a session that could really take this run is judged this way; a
  // blocked or busy one has its own, already-durable answer.
  if (sessionRecord !== undefined && sessionRecord.status === "ready" && sessionRecord.activeRunId === null) {
    const prospective = snapshotOfProspectiveRun(state, "prepare:stream", sessionRecord, {
      runId,
      submissionId: params.submissionId,
      text: params.text,
      acceptedAt,
    });
    if (!snapshotFrameFits(state, prospective)) return operationFailed(limitExceededError());
  }

  // Waiting is not an option the contract offers, so the decision is made by
  // execution order: either this call has the registry or it does not. A ready
  // session that already has a run is exactly this case — the run holding it
  // still owns the token — so the honest answer is HOST_BUSY, not a claim that
  // the session cannot be used.
  const lease = state.gate.tryAcquire("execution");
  if (lease === undefined) return operationFailed(protocolError("HOST_BUSY"));

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
  } catch (error) {
    // The admission's own evidence already decided this: a lost receipt whose
    // batch landed returns `admitted` above, so reaching here means the batch
    // either provably did not land or could not be judged. Either way nothing
    // may execute on it, and nothing is announced.
    if (error instanceof CommitOutcomeUnknownError) markStorageFault(state);
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
      // this transaction. Its run is the answer, and this call executes nothing
      // — once the run has been held to the same validation every other read of
      // a durable run is held to.
      lease.release();
      if (!servesRun(state, admission.run)) return operationFailed(refuseCorruptRun(state, admission.run));
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
    cancelDurable: false,
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
 * Two facts are deliberately kept apart, because they are not the same fact:
 * `cancelRequested` is that *this host* asked the execution to stop, and
 * `cancelDurable` is that storage confirmed the intent. A store that cannot
 * record the intent never stops the abort — stopping work is the one thing a
 * broken store must not prevent — but it also never turns into a success
 * message: a repeated request re-tries the durable write and answers from what
 * storage now says, never from the in-memory flag alone.
 */
export function cancelRun(state: HostState, runId: string): OperationOutcome<RunResult> {
  const run = state.runs.get(runId);
  if (run !== undefined) {
    if (run.terminal !== undefined) return operationSucceeded({ run: run.terminal.snapshot });
    if (run.cancelRequested && run.cancelDurable) return operationSucceeded({ run: runSnapshotOf(run) });

    const first = !run.cancelRequested;
    run.cancelRequested = true;

    if (!state.storageFault) {
      try {
        const record = state.repository.requestCancel(runId, Date.now());
        run.cancelDurable = record.cancelRequested;
        if (record.status !== "accepted" && record.status !== "running") {
          // The store already holds this run's outcome — it is the durable
          // terminal that is the answer, and cancelling executes nothing. The
          // terminal is held to the same validation as any other read of one:
          // a cancel never launders a record the host would refuse elsewhere.
          if (!servesRun(state, record)) return operationFailed(refuseCorruptRun(state, record));
          return operationSucceeded({ run: runSnapshotOfRecord(record, storedError(record.errorCode)) });
        }
      } catch (error) {
        if (error instanceof CommitOutcomeUnknownError) markStorageFault(state);
      }
    }

    // The abort is asked for whatever storage said, and it is asked for once:
    // a repeat merely re-checks the durable intent.
    if (first) {
      run.controller.abort();
      try {
        publishValidatedEvent(state, runUpdatedEvent(run, activeRunSnapshotOf(run)));
      } catch {
        run.faulted = true;
      }
    }

    return run.cancelDurable
      ? operationSucceeded({ run: runSnapshotOf(run) })
      : operationFailed(storageUnavailableError());
  }

  let record: RunRecord | undefined;
  try {
    record = state.repository.getRun(runId);
  } catch (error) {
    return operationFailed(error instanceof StoreUntrustedError ? storageUnavailableError() : protocolError("INTERNAL_ERROR"));
  }
  if (record === undefined) return operationFailed(protocolError("RUN_NOT_FOUND"));
  if (record.status === "accepted" || record.status === "running") {
    // Reconciliation runs before this host is ready, so an unfinished run with
    // no live entry is not a state this host can act on.
    return operationFailed(protocolError("HOST_BUSY"));
  }
  // A committed terminal is never re-opened, and cancelling one executes
  // nothing — once the record has been held to the same validation every other
  // read of a durable terminal is held to.
  if (!servesRun(state, record)) return operationFailed(refuseCorruptRun(state, record));
  return operationSucceeded({ run: runSnapshotOfRecord(record, storedError(record.errorCode)) });
}

/**
 * Reads one run: the live one if this host is running it, otherwise the durable
 * record. Never an execution.
 *
 * A durable terminal is only served when it agrees with the history it claims:
 * the run's recorded range has to be the turn the store's own index holds. A
 * record that disagrees is not a run this host can describe, and describing it
 * anyway would hand a reader a terminal pointing at somebody else's turn.
 */
export function readRun(state: HostState, params: { readonly runId?: string; readonly submissionId?: string }): OperationOutcome<RunResult> {
  if (params.runId !== undefined) {
    const live = state.runs.get(params.runId);
    if (live !== undefined) return operationSucceeded({ run: runSnapshotOf(live) });
    let record: RunRecord | undefined;
    try {
      record = state.repository.getRun(params.runId);
    } catch (error) {
      return operationFailed(error instanceof StoreUntrustedError ? storageUnavailableError() : protocolError("INTERNAL_ERROR"));
    }
    if (record === undefined) return operationFailed(protocolError("RUN_NOT_FOUND"));
    // The record and the history it claims disagree: this host will not
    // describe the run, and it will not execute this session again either.
    if (!servesRun(state, record)) return operationFailed(refuseCorruptRun(state, record));
    return operationSucceeded({ run: runSnapshotOfRecord(record, storedError(record.errorCode)) });
  }

  const submissionId = params.submissionId;
  if (submissionId === undefined) return operationFailed(protocolError("INVALID_REQUEST"));
  let known;
  let record: RunRecord | undefined;
  try {
    known = state.repository.getSubmission(submissionId);
    if (known === undefined) return operationFailed(protocolError("RUN_NOT_FOUND"));
    if (known.state === "retired") return operationFailed(protocolError("SUBMISSION_RETIRED"));
    if (known.runId === null) return operationFailed(protocolError("RUN_NOT_FOUND"));
    const live = state.runs.get(known.runId);
    if (live !== undefined) return operationSucceeded({ run: runSnapshotOf(live) });
    record = state.repository.getRun(known.runId);
  } catch (error) {
    return operationFailed(error instanceof StoreUntrustedError ? storageUnavailableError() : protocolError("INTERNAL_ERROR"));
  }
  if (record === undefined) return operationFailed(protocolError("RUN_NOT_FOUND"));
  if (!servesRun(state, record)) return operationFailed(refuseCorruptRun(state, record));
  return operationSucceeded({ run: runSnapshotOfRecord(record, storedError(record.errorCode)) });
}

/**
 * Whether one durable run record may be served as the fact it claims.
 *
 * The one authority every public path asks before a terminal run leaves this
 * host: the dedup answer, the run and submission reads, the cancel answer and
 * the published cut all call it, so no path can be the one that serves a record
 * the others would refuse. An unfinished run is this host's own admission and
 * carries no history to disagree with; a terminal one is only what it says if
 * the repository's own commit evidence says so too.
 */
export function servesRun(state: HostState, record: RunRecord): boolean {
  if (record.status === "accepted" || record.status === "running") return true;
  try {
    return state.repository.verifyRunHistory(record);
  } catch {
    return false;
  }
}

/**
 * The refusal one corrupt terminal run produces, and its one consequence.
 *
 * The session is stopped durably — it must not execute against a history the
 * host cannot read — and the caller is told the host could not answer, never
 * handed the damaged payload. The refusal is INTERNAL_ERROR, an existing frozen
 * answer: a corrupted record is not a client's mistake, and it is not evidence
 * that anything is unavailable either. Other sessions are untouched.
 */
export function refuseCorruptRun(state: HostState, record: RunRecord): ProtocolError {
  blockCorruptedSession(state, record.sessionId);
  return protocolError("INTERNAL_ERROR");
}

/**
 * Blocks a session whose durable canonical cannot be read as the fact it claims.
 *
 * It is the one safe response to corruption found while reading: the host will
 * not execute against a history it cannot trust, so the session stops accepting
 * runs — durably, so a restart cannot un-block it — while staying readable,
 * renameable and deletable. Nothing is repaired, discarded or rewritten here,
 * and no other session is affected: a corrupt conversation is not a reason to
 * stop the host.
 */
export function blockCorruptedSession(state: HostState, sessionId: string): void {
  let record: SessionRecord | undefined;
  try {
    record = state.repository.blockCorruptSession(sessionId, Date.now());
  } catch {
    // A store that cannot record the block says so to every later read; the
    // refusal to answer is what matters here.
    return;
  }
  if (record === undefined || record.status !== "blocked") return;

  try {
    const build = sessionUpdatedEvent(sessionSummaryOf(record), state.repository.revisions);
    assertEventBuilds(state, build);
    publishEvent(state, build);
  } catch {
    // A subscriber that cannot be told changes nothing about the durable block.
  }
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
 * disagree with what actually happened. A marker whose receipt was lost but
 * whose row is present is committed — the write layer proves it by reading it
 * back — and the run proceeds; a marker that could not be confirmed stops the
 * run without executing anything.
 */
function beginRun(state: HostState, run: RunEntry): boolean {
  try {
    const record = state.repository.markRunStarted(run.runId, state.hostInstanceId, Date.now());
    run.startedAt = record.startedAt ?? Date.now();
    run.stage = "running";
  } catch (error) {
    if (error instanceof CommitOutcomeUnknownError) markStorageFault(state);
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
 * loaded is never presented as if it were. What is loaded is checked before it
 * becomes a model context — positions, turn closure and tool pairing — because
 * a window that cannot be proven to be a whole suffix of committed history is
 * exactly the history a model must never be handed.
 */
function loadWindow(state: HostState, run: RunEntry): RunEntry["window"] {
  try {
    const read = state.repository.readTurnWindow(run.sessionId, WINDOW_MAX_TURNS, WINDOW_MAX_BYTES);
    assertStoredRange(read.records, { partialPrefix: false, baseSeq: read.baseSeq });
    const session: Session = restoreSessionWindow(run.sessionId, {
      baseSeq: read.baseSeq,
      nextSeq: read.nextSeq,
      events: read.records.map(toSessionEvent),
    });
    return { session, baseSeq: read.baseSeq, loadedSeq: read.records.length };
  } catch {
    // Either the store could not be read or what it holds cannot be read as the
    // fact it claims to be — a corrupt record is refused exactly like a
    // missing one. The run does not execute against a history it cannot trust,
    // and the ordinary host-fault path blocks the session.
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

/**
 * Whether the live timeline is still being published, and still within its
 * bounds.
 *
 * `cost` is the *encoded* cost of what is about to be shown — the JSON the
 * frame will actually carry, escaping included — because that number, and not
 * the length of the text behind it, is what a reader pays for. The bound is a
 * display bound only: reaching it stops the view from growing and says so.
 */
function liveHasRoom(state: HostState, run: RunEntry, cost: number): boolean {
  if (run.liveTruncated) return false;
  if (run.live.length >= MAX_LIVE_ITEMS || run.liveBytes + cost > MAX_LIVE_BYTES) {
    // The run keeps going; only the view stops growing, and it says so — now,
    // rather than at the next increment, which may never come.
    run.liveTruncated = true;
    attempt(run, () => {
      publishValidatedEvent(state, runUpdatedEvent(run, activeRunSnapshotOf(run)));
    });
    return false;
  }
  return true;
}

/** One live item's real cost as published: its encoded content plus its envelope. */
function liveItemCost(item: LiveToolItem | { readonly kind: "text"; readonly itemId: string; readonly text: string }): number {
  return encodedBytes(item) + LIVE_ITEM_OVERHEAD;
}

/**
 * Appends one text chunk to the open text item, or opens one.
 *
 * The delta is checked before the timeline moves, so a value the wire cannot
 * carry never becomes part of the run's published live view.
 */
function appendLiveText(state: HostState, run: RunEntry, text: string): void {
  const escaped = Math.max(0, encodedBytes(text) - 2);
  if (!liveHasRoom(state, run, escaped)) return;

  const index = run.textItemIndex;
  let itemId: string;

  if (index === undefined) {
    itemId = newLiveId(run, "item");
    const item = Object.freeze({ kind: "text" as const, itemId, text });
    const build = runOutputDeltaEvent(run, itemId, text);
    commitLive(state, build, () => {
      run.textItemIndex = run.live.length;
      run.live.push(item);
      run.liveBytes += liveItemCost(item);
    });
    return;
  }

  const previous = run.live[index];
  if (previous === undefined || previous.kind !== "text") {
    throw new ProjectionError("the live text item lost its place in the timeline");
  }
  itemId = previous.itemId;
  const build = runOutputDeltaEvent(run, itemId, text);
  const grown = Object.freeze({ kind: "text" as const, itemId, text: previous.text + text });
  commitLive(state, build, () => {
    run.live[index] = grown;
    run.liveBytes += liveItemCost(grown) - liveItemCost(previous);
  });
}

/**
 * Opens one tool occurrence.
 *
 * The occurrence — not the call id — is the identity: the Core allows an empty
 * call id and allows the same one to be used again in the next step, so two
 * calls that look alike are still two calls, each with its own item and its own
 * invocation id.
 *
 * The bookkeeping and the presentation are separated on purpose. A call whose
 * display does not fit the live budget is still a call: it is tracked so its
 * result can be matched against it, and so the run's canonical outcome never
 * depends on how much of the timeline a reader happened to be shown. Only the
 * *showing* is bounded; nothing about execution is.
 */
function openLiveToolCall(
  state: HostState,
  run: RunEntry,
  event: Extract<RuntimeEvent, { type: "tool/call" }>,
): void {
  if (run.posTool !== undefined) {
    throw new ProjectionError("a tool call arrived while another call was still open");
  }

  // The occurrence is established first, unconditionally: pairing is execution
  // bookkeeping, and it must hold whether or not the item is ever published.
  const invocationId = newLiveId(run, "call");
  const item: LiveToolItem = Object.freeze({
    kind: "tool" as const,
    itemId: newLiveId(run, "item"),
    invocationId,
    callId: event.callId,
    name: event.name,
    input: projectDisplayInput(event.input),
    result: null,
  });
  const slot = {
    index: undefined as number | undefined,
    invocationId,
    itemId: item.itemId,
    callId: event.callId,
    name: event.name,
  };

  if (!liveHasRoom(state, run, liveItemCost(item))) {
    run.posTool = slot;
    run.textItemIndex = undefined;
    return;
  }

  const build = runToolCallEvent(run, item);
  commitLive(state, build, () => {
    run.posTool = { ...slot, index: run.live.length };
    run.live.push(item);
    run.liveBytes += liveItemCost(item);
    // A tool call ends the current text item: the next chunk starts a new one.
    run.textItemIndex = undefined;
  });
}

/**
 * Fills in the open occurrence.
 *
 * `ok: false` is recorded as it is: the Core reports a failed observation and
 * an undispatched call the same way, and the host does not guess which it was.
 * The occurrence is matched on every path — including the truncated one — and
 * is always closed by the result that answers it, so a bounded view can never
 * leave the run's own bookkeeping stuck.
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
  if (open.index === undefined) {
    // The call was never shown, so there is nothing to fill in; the result was
    // still matched, which is what the canonical turn needs.
    run.posTool = undefined;
    return;
  }

  const index = open.index;
  const previous = run.live[index];
  if (previous === undefined || previous.kind !== "tool") {
    throw new ProjectionError("the open tool item lost its place in the timeline");
  }

  const filled = Object.freeze({
    ...previous,
    result: Object.freeze({ ok: event.ok, content: event.content }),
  });
  // The result is the largest thing an occurrence ever carries, so it is what
  // the live budget is really spent on — measured as the item will encode, not
  // estimated from the call.
  if (!liveHasRoom(state, run, liveItemCost(filled) - liveItemCost(previous))) {
    // The view stops here: the call stays visible without its result, and the
    // run says the timeline was truncated rather than showing half of one.
    run.posTool = undefined;
    return;
  }

  const build = runToolResultEvent(run, open.invocationId, event.ok, event.content);
  commitLive(state, build, () => {
    run.live[index] = filled;
    run.liveBytes += liveItemCost(filled) - liveItemCost(previous);
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

/** The terminal batch, as one value: what is committed is what is retried. */
function terminalInput(run: RunEntry, batch: TerminalBatch): CommitTurnInput {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    turnId: batch.turnId,
    reason: batch.reason,
    turnStartSeq: batch.turnStartSeq,
    records: batch.records,
    endedAt: Date.now(),
  };
}

/**
 * The terminal commit: the turn's events, the run's outcome and the session's
 * new summary, in one transaction.
 *
 * Nothing is published before this returns, and what it returns is only ever
 * one of two things: the batch is durably committed (possibly proven so after
 * a lost receipt, in which case the *verified* records are what is published),
 * or the store could not be made to say. A definitive failure — a refusal the
 * store proved, like a record it cannot keep whole — is retried once as the
 * same storage batch, and never by re-running anything: the Runtime has already
 * settled, the model is not called again, and no tool is dispatched twice. What
 * this function never does is publish a completed or failed terminal the store
 * does not hold.
 */
function commitTerminal(state: HostState, run: RunEntry, batch: TerminalBatch): boolean {
  let result: CommitTurnResult | undefined;

  for (let attempt = 1; attempt <= 2 && result === undefined; attempt++) {
    try {
      result = state.repository.commitTurn(terminalInput(run, batch));
    } catch (error) {
      if (error instanceof CommitOutcomeUnknownError) {
        // The batch may or may not be recorded, and nothing the host could say
        // would be true. The run stays unfinished for this host's own readers —
        // exactly the state a restart reconciles to `interrupted` — and every
        // later write is refused until the store can be trusted again. The live
        // entry goes with it: an executing run with a timeline is this host's
        // memory, and letting that memory stand in for an outcome storage never
        // confirmed is what this branch exists to prevent.
        markStorageFault(state);
        retireRun(state, run);
        return false;
      }
      if (attempt === 2) {
        // Two definitive refusals. The store has proven the batch is not
        // there; the honest record of what happened is a host failure, and
        // `failRun` writes one — or leaves the run unfinished when it cannot.
        return false;
      }
    }
  }
  if (result === undefined) return false;

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
 * repaired, not completed, and not turned into history. The failure is recorded
 * durably, because a terminal a client sees must be a terminal the store holds.
 *
 * When the store cannot record it — or cannot be trusted to say whether it did
 * — nothing is published at all. A fabricated in-memory `failed` would be a
 * claim storage is entitled to contradict, and the honest statement is the one
 * the durable record makes: an unfinished run, which the next start reconciles
 * to `interrupted`. Refusing to invent that outcome is the whole point of the
 * rule — and the live entry is released with it, so that statement is what
 * queries actually get: the durable record, not a timeline of a turn that was
 * never kept. Every later write reports the store as unavailable.
 */
function failRun(state: HostState, run: RunEntry): void {
  const failure = protocolError("INTERNAL_ERROR");

  if (!state.storageFault) {
    try {
      const result = state.repository.failRun({
        runId: run.runId,
        sessionId: run.sessionId,
        blockedReason: "host-fault",
        errorCode: failure.code,
        endedAt: Date.now(),
        turnId: run.turnId,
      });
      applyTerminal(state, run, {
        snapshot: terminalSnapshotOfRecord(result.run, failure),
        summary: sessionSummaryOf(result.session),
        revisions: result.revisions,
      });
      return;
    } catch (error) {
      if (error instanceof CommitOutcomeUnknownError) markStorageFault(state);
    }
  }

  // Nothing durable holds this run's outcome, so this host cannot describe one.
  // What it can do is stop describing the execution it was watching: the entry
  // leaves the live map, and the run is answered from the record — unfinished,
  // and honestly without a timeline.
  retireRun(state, run);
}

/**
 * The terminal correction, as one indivisible step.
 *
 * Everything a reader could ask about moves here and nowhere else: the run
 * becomes terminal with no live timeline, the session's summary is replaced
 * with the one the commit produced, and the single event that carries both is
 * queued. There is no `await` and no call into the channel between these lines,
 * so a read or a snapshot cannot land in the middle of it.
 *
 * The last thing it does is release the entry: a durable terminal is the
 * repository's fact, and from here on the run is answered from there.
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
  retireRun(state, run);
}

/** The same commit without an announcement. */
function applyTerminalLocally(state: HostState, run: RunEntry, record: TerminatedRun): void {
  run.terminal = record;
  retireRun(state, run);
}

function newLiveId(run: RunEntry, kind: string): string {
  run.nextLiveId += 1;
  return `${run.runId}:${kind}${run.nextLiveId}`;
}

function storedError(code: string | null): ProtocolError | null {
  return code === null ? null : storedProtocolError(code);
}

/**
 * Marks the host unable to confirm writes, and stops claiming a live
 * presentation.
 *
 * From this moment the host cannot say what storage holds for the work it was
 * executing, and it cannot reconcile that — only a restart can, from durable
 * facts. What it must not do is keep telling connected clients that the state
 * they are reading is current: the run's terminal may or may not have landed,
 * and a presentation that still says "running, live" is a claim nobody can
 * back. So every connection is ended, which is the one transport-level signal
 * the contract has for "this side no longer knows" — the client marks the
 * presentation it keeps as stale, its pending work as unknown, and reads
 * answer STORAGE_UNAVAILABLE until a restart reconciles the facts.
 *
 * Nothing durable is written here and nothing is invented: the run is left
 * unfinished in the store exactly as it is, for the next start to reconcile to
 * `interrupted`. The call is idempotent — the fault is a state, and the
 * second report of it closes nothing that is not already gone.
 */
export function markStorageFault(state: HostState): void {
  if (state.storageFault) return;
  state.storageFault = true;
  for (const connection of [...state.connections]) closeConnection(state, connection);
}
