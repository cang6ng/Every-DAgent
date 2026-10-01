/**
 * The durable repository: the one place a fact becomes a fact.
 *
 * Everything above this module works with values it can still be wrong about.
 * What crosses this boundary is a transaction: a set of writes that either all
 * happened or none did, checked and committed while no `await` can run, because
 * every call here is synchronous. That is not an accident of the API — it is
 * the property the whole layer rests on. A transaction that could be suspended
 * halfway would be one a model call, a tool or a client could interleave with,
 * and the atomicity the business boundaries promise would be a hope.
 *
 * Three rules shape the implementation.
 *
 * Reads are bounded. A directory page, a run page and a history page each take
 * a bound and return at most that much; there is deliberately no "load
 * everything" call, because a repository that offers one is a repository that
 * will be asked for it, and a long conversation must never be loaded whole just
 * to answer a question about its newest turn.
 *
 * Facts are never rewritten. Sequences are not renumbered, identities are not
 * reused, and a deleted session's id is retired rather than recycled. The one
 * thing this module does to a stored fact is refuse to read it when it is not
 * shaped the way a committed fact must be.
 *
 * Ephemeral is the same code as durable, with the database in memory.
 * `retention` reports which one the caller got, and a durable backend that
 * cannot be opened throws instead of quietly handing back an in-memory one.
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { SessionEvent } from "@every-dagent/agent-core";
import type {
  BlockedReason,
  CanonicalItem,
  CollectionRevisions,
  DisplayInput,
  EndReason,
  ExecutionKnowledge,
  JsonValue,
  RunStatus,
} from "@every-dagent/protocol";
import { validateJsonValue } from "@every-dagent/protocol";

/** What one write's own evidence proves about a batch whose receipt was lost. */
type WriteVerdict<T> =
  | { readonly kind: "committed"; readonly value: T }
  | { readonly kind: "absent" }
  | { readonly kind: "indeterminate" };

/** The schema generation this build writes and reads. */
export const SCHEMA_VERSION = 1;

/** A committed session event, in the shape the store keeps it. */
export interface StoredRecord {
  readonly seq: number;
  readonly turnId: string;
  readonly type: SessionEvent["type"];
  readonly time: number;
  /** The encoded payload, exactly as it will be written. */
  readonly data: string;
}

/** One session's durable row. */
export interface SessionRecord {
  readonly sessionId: string;
  readonly generation: number;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadataRevision: number;
  readonly historyRevision: number;
  readonly committedSeq: number;
  readonly status: "ready" | "blocked";
  readonly blockedReason: BlockedReason | null;
  readonly activeRunId: string | null;
}

/** One run's durable row. */
export interface RunRecord {
  readonly runId: string;
  readonly submissionId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly acceptedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly hostInstanceId: string;
  readonly status: RunStatus;
  readonly endReason: EndReason | null;
  readonly errorCode: string | null;
  readonly executionKnowledge: ExecutionKnowledge | null;
  readonly turnId: string | null;
  readonly cancelRequested: boolean;
}

/**
 * One spent submission identity.
 *
 * `inputHash` is a hash, never the input: a deleted session's tombstone has to
 * be enough to refuse a replay and not enough to leak what was said.
 */
export interface SubmissionRecord {
  readonly submissionId: string;
  readonly sessionId: string;
  readonly inputHash: string;
  readonly runId: string | null;
  readonly state: "active" | "retired";
}

/** A keyset position in the session directory. */
export interface SessionCursorKey {
  readonly updatedAt: number;
  readonly sessionId: string;
}

/** A keyset position in a session's run list. */
export interface RunCursorKey {
  readonly acceptedAt: number;
  readonly runId: string;
}

export interface SessionPage {
  readonly records: readonly SessionRecord[];
  readonly hasMore: boolean;
}

export interface RunPage {
  readonly records: readonly RunRecord[];
  readonly hasMore: boolean;
}

/**
 * A bounded recent-run window, with the truth about what it left out.
 *
 * `hasMore` is answered by the read that produced the window — a row it fetched
 * and did not return, or a row it refused to fetch because the byte budget was
 * spent — never inferred from the count it happens to hold.
 */
export interface RecentRunPage {
  readonly records: readonly RunRecord[];
  readonly hasMore: boolean;
}

/** A contiguous committed event range, read for one history page. */
export interface HistoryRead {
  readonly records: readonly StoredRecord[];
  readonly fromSeq: number;
  readonly toSeq: number;
}

/** A bounded suffix of whole turns, for one execution window. */
export interface TurnWindowRead {
  readonly records: readonly StoredRecord[];
  readonly baseSeq: number;
  readonly nextSeq: number;
}

export interface CreateSessionInput {
  readonly sessionId: string;
  readonly title: string;
  readonly createdAt: number;
}

export interface AdmitInput {
  readonly runId: string;
  readonly submissionId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly inputHash: string;
  readonly hostInstanceId: string;
  readonly acceptedAt: number;
}

/**
 * What admission decided.
 *
 * `existing` is a promise kept across restarts: the same submission and the
 * same input identity return the run that was accepted before, without
 * starting anything. `conflict` is the submission being reused for different
 * work, and `retired` is the submission's session having been deleted — both
 * are refusals, never a new execution.
 */
export type AdmitOutcome =
  | { readonly kind: "admitted"; readonly run: RunRecord; readonly session: SessionRecord }
  | { readonly kind: "existing"; readonly run: RunRecord }
  | { readonly kind: "conflict" }
  | { readonly kind: "retired" }
  | { readonly kind: "session-not-found" }
  | { readonly kind: "session-blocked" }
  | { readonly kind: "session-busy" };

export interface CommitTurnInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly reason: string;
  readonly turnStartSeq: number;
  readonly records: readonly StoredRecord[];
  readonly endedAt: number;
}

export interface CommitTurnResult {
  readonly session: SessionRecord;
  readonly run: RunRecord;
  readonly revisions: CollectionRevisions;
}

export interface HostFaultInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly blockedReason: BlockedReason;
  readonly errorCode: string;
  readonly endedAt: number;
  readonly turnId: string | null;
}

export interface ReconcileResult {
  readonly interrupted: number;
  readonly revisions: CollectionRevisions;
}

export interface RenameInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly title: string;
  readonly at: number;
}

export interface DeleteInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly at: number;
}

export type RenameOutcome =
  | { readonly kind: "renamed"; readonly session: SessionRecord }
  | { readonly kind: "not-found" }
  | { readonly kind: "revision-conflict"; readonly session: SessionRecord };

export type DeleteOutcome =
  | { readonly kind: "deleted"; readonly generation: number }
  | { readonly kind: "not-found" }
  | { readonly kind: "revision-conflict"; readonly session: SessionRecord }
  | { readonly kind: "busy" };

/** A committed record the store would have to truncate to keep. */
export class RecordTooLargeError extends Error {
  constructor(detail: string) {
    super(`the record cannot be stored whole: ${detail}`);
    this.name = "RecordTooLargeError";
  }
}

/**
 * A stored fact that is not the shape its type promises.
 *
 * Corruption is never repaired into a legal value: a payload that does not hold
 * what a committed record of its type must hold is refused at the point it would
 * be read, so it can never become a model context or a published item.
 */
export class CorruptRecordError extends Error {
  constructor(detail: string) {
    super(`the stored fact is not what its type promises: ${detail}`);
    this.name = "CorruptRecordError";
  }
}

/** The storage could not be opened, or its schema is not one this build knows. */
export class StorageOpenError extends Error {
  constructor(detail: string) {
    super(`the durable store cannot be opened: ${detail}`);
    this.name = "StorageOpenError";
  }
}

/**
 * A write whose COMMIT receipt was lost without the durable outcome being
 * provable.
 *
 * It is deliberately not a failure: a lost receipt is a failure to *know*, and
 * a caller that treated it as "nothing happened" would publish a state the
 * store may already disagree with. A write that can prove its batch landed
 * returns the committed result instead; a write that can prove it did not
 * rethrows its own error. Only the genuinely undecidable case arrives here.
 */
export class CommitOutcomeUnknownError extends Error {
  constructor(detail: string) {
    super(`the commit outcome could not be determined: ${detail}`);
    this.name = "CommitOutcomeUnknownError";
  }
}

export interface RepositoryLimits {
  /** The most one encoded durable record may occupy, envelope included. */
  readonly maxRecordBytes: number;
}

export interface Repository {
  readonly storageId: string;
  readonly retention: "durable" | "ephemeral";
  readonly schemaVersion: number;
  readonly revisions: CollectionRevisions;
  close(): void;

  // Reads.
  getSession(sessionId: string): SessionRecord | undefined;
  getDeletedSession(sessionId: string): number | undefined;
  listSessions(limit: number, after: SessionCursorKey | null): SessionPage;
  getRun(runId: string): RunRecord | undefined;
  getSubmission(submissionId: string): SubmissionRecord | undefined;
  listRunsBySession(sessionId: string, limit: number, after: RunCursorKey | null): RunPage;
  listRecentRuns(limit: number, maxBytes: number): RecentRunPage;
  listUnfinishedRuns(): readonly RunRecord[];
  readHistory(sessionId: string, beforeSeq: number, maxEvents: number): HistoryRead;
  readTurnWindow(sessionId: string, maxTurns: number, maxBytes: number): TurnWindowRead;
  /**
   * Whether a run's recorded committed range is the turn the index holds.
   *
   * A terminal run and the history it claims to have produced are two rows that
   * became true in one transaction; a reader that finds them disagreeing is
   * reading a store this build did not write, and refuses the fact rather than
   * serving a run whose history is somebody else's.
   */
  verifyRunHistory(run: RunRecord): boolean;
  /**
   * The durable evidence for one terminal batch.
   *
   * `committed` means every part of the batch — the events of the range, the
   * turn index, the run terminal and the session's new high-water — is present
   * and agrees; `absent` means the store proves the batch never landed; anything
   * else is `indeterminate`, which is exactly as much as the store knows.
   */
  verifyTurnCommit(input: CommitTurnInput): "committed" | "absent" | "indeterminate";

  // Writes. Each one is a transaction.
  createSession(input: CreateSessionInput): SessionRecord;
  admitRun(input: AdmitInput): AdmitOutcome;
  markRunStarted(runId: string, hostInstanceId: string, at: number): RunRecord;
  commitTurn(input: CommitTurnInput): CommitTurnResult;
  failRun(input: HostFaultInput): CommitTurnResult;
  requestCancel(runId: string, at: number): RunRecord;
  renameSession(input: RenameInput): RenameOutcome;
  deleteSession(input: DeleteInput): DeleteOutcome;
  reconcileInterrupted(hostInstanceId: string, at: number): ReconcileResult;
  /**
   * Advances the plugin catalogue's revision.
   *
   * The plugin catalogue has no durable rows here — plugins are registered by
   * the composition, not by the store — but its revision is a published fact a
   * client pages by, so a lifecycle change still has to move it.
   */
  bumpPluginRevision(): CollectionRevisions;
}

// ---------------------------------------------------------------------------
// Stored payloads.
// ---------------------------------------------------------------------------

/**
 * Encodes one event's payload for storage.
 *
 * Every field a settled turn produced is kept; two fields the store cannot keep
 * verbatim are rewritten here, and both rewrites are the point:
 *
 * - a tool call's input may carry a value JSON cannot represent. That value is
 *   stored as the display projection the commit already computed — a deep JSON
 *   snapshot when there is one, and an explicit `unavailable` otherwise, so an
 *   unrepresentable input is never confused with a real `null`. Managed
 *   execution does not let such a call settle, so this branch exists for
 *   records a different profile wrote, and for display.
 * - a `turn/end` error is Core-visible text that may quote a provider's own
 *   words — headers, bodies, URLs, an authorization header. A durable record may
 *   carry a fixed classification but never that text, so the field is kept as a
 *   presence marker and its content is dropped.
 */
export function encodeStoredData(event: SessionEvent): string {
  return JSON.stringify(payloadOf(event));
}

/** The fixed marker a stored error turn carries: the fact, never the words. */
export const STORED_ERROR_MARKER = "the turn ended in an error";

/** The display projection recorded alongside a tool call's input. */
function displayOf(input: unknown): DisplayInput {
  const validated = validateJsonValue(input);
  return validated.success
    ? { kind: "json", value: validated.output }
    : { kind: "unavailable", reason: "not-json-safe" };
}

function payloadOf(event: SessionEvent): JsonValue {
  switch (event.type) {
    case "turn/start":
      return {};
    case "message/user":
      return { text: event.data.text };
    case "message/assistant":
      return {
        text: event.data.text,
        toolCalls: event.data.toolCalls.map((call) => ({
          callId: call.callId,
          name: call.name,
          input: displayOf(call.input) as unknown as JsonValue,
        })),
      };
    case "tool/call":
      return {
        callId: event.data.callId,
        name: event.data.name,
        input: displayOf(event.data.input) as unknown as JsonValue,
      };
    case "tool/result":
      return {
        callId: event.data.callId,
        name: event.data.name,
        ok: event.data.ok,
        content: event.data.content,
      };
    case "turn/end":
      // The Core's own message never travels into storage; whether the turn
      // failed is a fact the reason already carries.
      return event.data.error === undefined
        ? { reason: event.data.reason }
        : { reason: event.data.reason, error: STORED_ERROR_MARKER };
  }
}

/** The display input a stored payload carries, for the item that projects it. */
export function storedDisplay(data: string): DisplayInput | undefined {
  const parsed = parsePayload(data);
  if (parsed === undefined) return undefined;
  const input = parsed["input"];
  return isDisplayInput(input) ? input : undefined;
}

/** A stored tool call, as the canonical projection needs it: ids plus display. */
export interface StoredToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: DisplayInput;
}

export function storedToolCalls(data: string): readonly StoredToolCall[] | undefined {
  const parsed = parsePayload(data);
  if (parsed === undefined) return undefined;
  const calls = parsed["toolCalls"];
  if (!Array.isArray(calls)) return undefined;
  const out: StoredToolCall[] = [];
  for (const call of calls) {
    if (typeof call !== "object" || call === null || Array.isArray(call)) return undefined;
    const record = call as Record<string, unknown>;
    const callId = record["callId"];
    const name = record["name"];
    const input = record["input"];
    if (typeof callId !== "string" || typeof name !== "string" || !isDisplayInput(input)) return undefined;
    out.push({ callId, name, input });
  }
  return out;
}

function isDisplayInput(value: unknown): value is DisplayInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const kind = (value as Record<string, unknown>)["kind"];
  return kind === "json" || kind === "unavailable";
}

export function parsePayload(data: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Strict validation of stored facts.
// ---------------------------------------------------------------------------

/**
 * One stored record, parsed and proven to be the shape its type promises.
 *
 * This is the read-side of the durable contract. A record is either exactly
 * what a committed fact of its type must be, or it is refused: nothing here
 * substitutes `""` for a missing text, `[]` for a missing call list or "error"
 * for an unknown reason, because a repaired record is a *different* fact
 * presented as the original one. Every field is checked for its exact type, so
 * a payload that survived storage but not its own schema never becomes history,
 * a published item or a model context.
 */
export function parseStoredRecord(record: StoredRecord): Record<string, unknown> {
  const parsed = parsePayload(record.data);
  if (parsed === undefined) throw new CorruptRecordError(`a ${record.type} record does not hold a JSON object`);
  if (!Number.isSafeInteger(record.seq) || record.seq < 0) throw new CorruptRecordError("a record has no legal sequence");
  if (typeof record.turnId !== "string" || record.turnId.length === 0) {
    throw new CorruptRecordError("a record has no turn id");
  }
  if (typeof record.time !== "number" || !Number.isFinite(record.time)) {
    throw new CorruptRecordError("a record has no legal time");
  }

  switch (record.type) {
    case "turn/start":
      return parsed;
    case "message/user":
      requireString(parsed, "text");
      return parsed;
    case "message/assistant": {
      requireString(parsed, "text");
      const calls = parsed["toolCalls"];
      if (!Array.isArray(calls)) throw new CorruptRecordError("an assistant record has no tool call list");
      for (const call of calls) {
        if (typeof call !== "object" || call === null || Array.isArray(call)) {
          throw new CorruptRecordError("an assistant record declares a call that is not an object");
        }
        const entry = call as Record<string, unknown>;
        if (typeof entry["callId"] !== "string" || typeof entry["name"] !== "string" || !isDisplayInput(entry["input"])) {
          throw new CorruptRecordError("an assistant record declares a call without its identity or input");
        }
      }
      return parsed;
    }
    case "tool/call":
      requireString(parsed, "callId");
      requireString(parsed, "name");
      if (!isDisplayInput(parsed["input"])) throw new CorruptRecordError("a tool call record has no display input");
      return parsed;
    case "tool/result":
      requireString(parsed, "callId");
      requireString(parsed, "name");
      if (typeof parsed["ok"] !== "boolean") throw new CorruptRecordError("a tool result record has no outcome");
      requireString(parsed, "content");
      return parsed;
    case "turn/end": {
      const reason = parsed["reason"];
      if (reason !== "completed" && reason !== "max_steps" && reason !== "cancelled" && reason !== "error") {
        throw new CorruptRecordError("a turn end record carries a reason the Core cannot produce");
      }
      if (parsed["error"] !== undefined && typeof parsed["error"] !== "string") {
        throw new CorruptRecordError("a turn end record carries an error that is not text");
      }
      return parsed;
    }
    default:
      throw new CorruptRecordError(`a record carries an unknown event type`);
  }
}

function requireString(parsed: Record<string, unknown>, key: string): string {
  const value = parsed[key];
  if (typeof value !== "string") throw new CorruptRecordError(`a stored field "${key}" is not text`);
  return value;
}

/** One stored record, rebuilt as the Core event the window continues from. */
export function toSessionEvent(record: StoredRecord): SessionEvent {
  const parsed = parseStoredRecord(record);
  const base = { turnId: record.turnId, seq: record.seq, time: record.time };

  switch (record.type) {
    case "turn/start":
      return Object.freeze({ ...base, type: "turn/start" as const, data: Object.freeze({}) });
    case "message/user":
      return Object.freeze({
        ...base,
        type: "message/user" as const,
        data: Object.freeze({ text: parsed["text"] as string }),
      });
    case "message/assistant": {
      const calls = storedToolCalls(record.data);
      if (calls === undefined) throw new CorruptRecordError("an assistant record's calls cannot be read back");
      return Object.freeze({
        ...base,
        type: "message/assistant" as const,
        data: Object.freeze({
          text: parsed["text"] as string,
          toolCalls: Object.freeze(
            calls.map((call) => ({ callId: call.callId, name: call.name, input: restoredInput(call.input) })),
          ),
        }),
      });
    }
    case "tool/call": {
      const display = storedDisplay(record.data);
      if (display === undefined) throw new CorruptRecordError("a tool call record's input cannot be read back");
      return Object.freeze({
        ...base,
        type: "tool/call" as const,
        data: Object.freeze({
          callId: parsed["callId"] as string,
          name: parsed["name"] as string,
          input: restoredInput(display),
        }),
      });
    }
    case "tool/result":
      return Object.freeze({
        ...base,
        type: "tool/result" as const,
        data: Object.freeze({
          callId: parsed["callId"] as string,
          name: parsed["name"] as string,
          ok: parsed["ok"] as boolean,
          content: parsed["content"] as string,
        }),
      });
    case "turn/end": {
      const error = parsed["error"];
      return Object.freeze({
        ...base,
        type: "turn/end" as const,
        data: Object.freeze({
          reason: parsed["reason"] as "completed" | "max_steps" | "cancelled" | "error",
          ...(typeof error === "string" ? { error } : {}),
        }),
      });
    }
  }
}

/** A Core tool-call input restored from its display projection. */
export function restoredInput(display: DisplayInput): unknown {
  return display.kind === "json" ? display.value : null;
}

/**
 * One contiguous stored range, checked as a sequence rather than a pile.
 *
 * The rules are the ones a committed log cannot break: positions run unbroken,
 * a turn's events all carry that turn's id, turns do not nest or stay open past
 * the range, and every recorded tool call is the one an assistant record
 * declared, answered once, in order. `partialPrefix` is how a *page* is allowed
 * to begin mid-turn — a page is explicitly a fragment — while a window that will
 * be executed against is required to be whole turns.
 */
export function assertStoredRange(
  records: readonly StoredRecord[],
  options: { readonly partialPrefix: boolean; readonly baseSeq: number },
): void {
  /**
   * Where the range stands relative to the turns around it.
   *
   * `unknown` is a page that began in the middle of a turn: the events before
   * its first `turn/start` belong to a turn whose start is outside the range,
   * so their ids and their pairing cannot be checked here — but nothing inside
   * the range is repaired on their account either. `open` is a turn whose start
   * *is* in the range, and everything until its end must belong to it. `closed`
   * is between turns, where only a `turn/start` may appear.
   */
  let phase: "unknown" | "open" | "closed" = options.partialPrefix ? "unknown" : "closed";
  /**
   * Whether this range has seen enough to hold its tool calls to account.
   *
   * A page that begins inside a turn does not know what declared the occurrence
   * it walked in on, so it cannot judge it. The moment the range holds a
   * `turn/start` or an assistant record, it does — and from there on every call
   * must be one the range saw declared, every declaration must be recorded, and
   * every result must answer the call before it.
   */
  let declarable = false;
  let openTurn: string | undefined;
  let declared = 0;
  let awaitingResult = false;
  let openCall: { readonly callId: string; readonly name: string } | undefined;

  const resolveBeforeTurnEnd = (seq: number): void => {
    if (awaitingResult) throw new CorruptRecordError(`turn end at seq ${seq} leaves a tool call unanswered`);
    if (declared > 0) throw new CorruptRecordError(`turn end at seq ${seq} leaves declared tool calls unrecorded`);
  };

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record === undefined) throw new CorruptRecordError("the stored range has a hole");
    if (record.seq !== options.baseSeq + index) throw new CorruptRecordError("the stored range is not contiguous");
    // Every record's payload, whatever its type, is checked for exactly what a
    // committed fact of that type must hold — including the two types that
    // project to no item at all.
    parseStoredRecord(record);

    if (record.type === "turn/start") {
      if (phase === "open") {
        throw new CorruptRecordError(`turn "${openTurn}" is still open at seq ${record.seq}`);
      }
      openTurn = record.turnId;
      phase = "open";
      declarable = true;
      continue;
    }

    if (record.type === "turn/end") {
      if (phase === "closed") throw new CorruptRecordError(`turn end at seq ${record.seq} has no open turn`);
      if (phase === "open" && record.turnId !== openTurn) {
        throw new CorruptRecordError(`turn end at seq ${record.seq} closes turn "${record.turnId}", not the open turn`);
      }
      resolveBeforeTurnEnd(record.seq);
      openTurn = undefined;
      phase = "closed";
      declarable = false;
      continue;
    }

    // Everything else is inside a turn, and which turn that is has to be known
    // whenever the range contains that turn's start.
    if (phase === "closed") throw new CorruptRecordError(`${record.type} at seq ${record.seq} has no open turn`);
    if (phase === "open" && record.turnId !== openTurn) {
      throw new CorruptRecordError(`seq ${record.seq} belongs to turn "${record.turnId}", not the open turn`);
    }

    switch (record.type) {
      case "message/assistant": {
        if (awaitingResult) throw new CorruptRecordError("an assistant record interrupts an unanswered tool call");
        if (declared > 0) throw new CorruptRecordError("an assistant record interrupts tool calls it never recorded");
        const calls = storedToolCalls(record.data);
        if (calls === undefined) throw new CorruptRecordError("an assistant record's calls cannot be read back");
        declared += calls.length;
        declarable = true;
        break;
      }
      case "tool/call": {
        if (awaitingResult) throw new CorruptRecordError("a tool call interrupts an unanswered tool call");
        const parsed = parseStoredRecord(record);
        if (declarable) {
          if (declared <= 0) {
            throw new CorruptRecordError(`a tool call at seq ${record.seq} was never declared by an assistant record`);
          }
          declared -= 1;
        }
        openCall = { callId: parsed["callId"] as string, name: parsed["name"] as string };
        awaitingResult = true;
        break;
      }
      case "tool/result": {
        if (!awaitingResult || openCall === undefined) {
          if (declarable || phase !== "unknown") {
            throw new CorruptRecordError(`a tool result at seq ${record.seq} answers no call`);
          }
          break;
        }
        const parsed = parseStoredRecord(record);
        if (parsed["callId"] !== openCall.callId || parsed["name"] !== openCall.name) {
          throw new CorruptRecordError(`a tool result at seq ${record.seq} answers a different call`);
        }
        awaitingResult = false;
        openCall = undefined;
        break;
      }
      default:
        break;
    }
  }

  // A range that claims to be whole turns may not end inside one, and may not
  // end owing anything.
  if (!options.partialPrefix) {
    if (phase === "open") throw new CorruptRecordError(`the range ends inside turn "${openTurn}"`);
    resolveBeforeTurnEnd(options.baseSeq + records.length);
  }
}

/** The one invocation id a tool call at this log position owns. */
export function invocationOf(sessionId: string, seq: number): string {
  return `${sessionId}:${seq}:call`;
}

// ---------------------------------------------------------------------------
// Storage backend.
// ---------------------------------------------------------------------------

/** Where the database lives, and how big one record may be. */
export interface RepositoryOptions {
  /** A file path, or `":memory:"` for an ephemeral store. */
  readonly location: string;
  readonly limits: RepositoryLimits;
}

interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
}

/**
 * The schema, as an ordered list of migrations.
 *
 * Each migration runs inside one transaction and either completes or leaves
 * the database exactly as it was. A database whose recorded version is not one
 * this list can reach is refused rather than guessed at: opening an unknown
 * schema would mean writing facts into a layout this build does not understand.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE sessions (
         session_id TEXT PRIMARY KEY,
         generation INTEGER NOT NULL,
         title TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         metadata_revision INTEGER NOT NULL,
         history_revision INTEGER NOT NULL,
         committed_seq INTEGER NOT NULL,
         status TEXT NOT NULL,
         blocked_reason TEXT,
         active_run_id TEXT
       )`,
      `CREATE TABLE deleted_sessions (
         session_id TEXT PRIMARY KEY,
         generation INTEGER NOT NULL,
         deleted_at INTEGER NOT NULL
       )`,
      `CREATE TABLE session_events (
         session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
         seq INTEGER NOT NULL,
         turn_id TEXT NOT NULL,
         type TEXT NOT NULL,
         time INTEGER NOT NULL,
         data TEXT NOT NULL,
         PRIMARY KEY (session_id, seq)
       )`,
      `CREATE TABLE turns (
         session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
         turn_id TEXT NOT NULL,
         start_seq INTEGER NOT NULL,
         end_seq INTEGER NOT NULL,
         reason TEXT NOT NULL,
         PRIMARY KEY (session_id, turn_id)
       )`,
      `CREATE INDEX turns_by_start ON turns (session_id, start_seq DESC)`,
      `CREATE TABLE runs (
         run_id TEXT PRIMARY KEY,
         submission_id TEXT NOT NULL,
         session_id TEXT NOT NULL,
         text TEXT NOT NULL,
         accepted_at INTEGER NOT NULL,
         started_at INTEGER,
         ended_at INTEGER,
         host_instance_id TEXT NOT NULL,
         status TEXT NOT NULL,
         end_reason TEXT,
         error_code TEXT,
         execution_knowledge TEXT,
         turn_id TEXT,
         cancel_requested INTEGER NOT NULL,
         committed_from_seq INTEGER,
         committed_to_seq INTEGER
       )`,
      `CREATE INDEX runs_by_session ON runs (session_id, accepted_at DESC, run_id DESC)`,
      `CREATE INDEX runs_by_submission ON runs (submission_id)`,
      `CREATE INDEX runs_by_status ON runs (status)`,
      `CREATE INDEX runs_by_accepted ON runs (accepted_at DESC, run_id DESC)`,
      `CREATE TABLE submissions (
         submission_id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         input_hash TEXT NOT NULL,
         run_id TEXT,
         state TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
      `CREATE TABLE collections (name TEXT PRIMARY KEY, revision INTEGER NOT NULL)`,
      `INSERT INTO collections (name, revision) VALUES ('sessions', 0), ('runs', 0), ('plugins', 0)`,
    ],
  },
];

/**
 * Opens a repository, or throws without leaving anything half-built.
 *
 * The order is the contract: take exclusive ownership of the file, then check
 * and migrate the schema, and only then report a storage identity. A second
 * host pointed at the same file cannot take the lock, so it fails here rather
 * than racing the first one for writes it would silently lose.
 *
 * A durable location has to name a database. An empty (or blank) path would be
 * accepted by the driver as a fresh temporary database that disappears with the
 * process — a store that reports itself durable and keeps nothing — so it is
 * refused here, before any file is touched, and `":memory:"` remains the one
 * explicit way to ask for a store that lives no longer than the running host.
 */
export function openRepository(options: RepositoryOptions): Repository {
  if (options.location.trim() === "") {
    throw new StorageOpenError("a durable store needs a location; an empty path is not a database");
  }
  const ephemeral = options.location === ":memory:";
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(options.location);
  } catch (error) {
    throw new StorageOpenError(describeFailure(error));
  }

  try {
    if (!ephemeral) {
      // Fail fast, and hold what is taken: with `EXCLUSIVE` locking the file
      // lock is kept for the connection's life, so ownership is a fact another
      // process can observe rather than a promise this one makes to itself.
      database.exec("PRAGMA journal_mode = DELETE");
      database.exec("PRAGMA locking_mode = EXCLUSIVE");
    }
    database.exec("PRAGMA synchronous = EXTRA");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");
    database.exec("COMMIT");
    // Migration is inside the same guard on purpose: a store this build refused
    // must not stay locked by the connection that refused it, or nobody could
    // even look at the file to see what is wrong with it.
    migrate(database);
    const repository = new SqliteRepository(database, ephemeral ? "ephemeral" : "durable", options.limits);
    repository.assertIdentified();
    return repository;
  } catch (error) {
    try {
      database.close();
    } catch {
      // The connection is already unusable; the open failure is what matters.
    }
    throw error instanceof StorageOpenError ? error : new StorageOpenError(describeFailure(error));
  }
}

function migrate(database: DatabaseSync): void {
  const current = readUserVersion(database);
  if (current > SCHEMA_VERSION) {
    throw new StorageOpenError(`the store records schema version ${current}, newer than this build's ${SCHEMA_VERSION}`);
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) database.exec(statement);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // A rollback that fails leaves the transaction to the connection's
        // close; the migration failure is the fact worth reporting.
      }
      throw new StorageOpenError(`migration to version ${migration.version} failed: ${describeFailure(error)}`);
    }
  }
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { readonly user_version?: number } | undefined;
  const version = row?.user_version;
  return typeof version === "number" ? version : 0;
}

/** A failure description that carries no path, header or driver text. */
function describeFailure(error: unknown): string {
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) return `storage error ${code}`;
  return "storage error";
}

/** A stable, non-secret hash of one submission's original identity. */
export function submissionHash(sessionId: string, text: string): string {
  return createHash("sha256").update(`${sessionId.length}:${sessionId}:${text}`, "utf8").digest("hex");
}

/** What one durable record's envelope adds on top of its encoded payload. */
export const RECORD_OVERHEAD_BYTES = 64;

/**
 * The size a value really occupies once it is written the way storage writes it.
 *
 * The one accounting the whole host uses for "will this fit": the value is
 * JSON-encoded — escaping included, since a control character costs six bytes
 * where it looked like one — and measured as UTF-8. Character counts and fixed
 * per-item estimates are not this measurement's approximations; they are a
 * different, wrong number.
 */
export function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Whether a settled record of these encoded bytes could be stored whole. */
export function recordFits(data: string, turnId: string, maxRecordBytes: number): boolean {
  return (
    Buffer.byteLength(data, "utf8") + Buffer.byteLength(turnId, "utf8") + RECORD_OVERHEAD_BYTES <= maxRecordBytes
  );
}

/**
 * Whether one accepted input's user fact can be stored whole.
 *
 * Checked against the record as it will actually be written, not against the
 * raw text: JSON escaping is what turns 16 KiB of control characters into a
 * record the store would refuse. A refusal here means the input was never
 * accepted, never model-bound and never tool-bound.
 */
export function userRecordFits(text: string, maxRecordBytes: number): boolean {
  return recordFits(JSON.stringify({ text }), "", maxRecordBytes);
}

/**
 * Whether one model step's assistant declaration and its calls can be stored.
 *
 * Both the declaration and each call become their own durable record, so both
 * are measured. This is deliberately only representability: no truncation, no
 * dropping a call, no rewriting arguments — a step that cannot be stored whole
 * is a step that does not run.
 */
export function stepRecordsFit(
  step: { readonly text: string; readonly toolCalls: readonly { readonly callId: string; readonly name: string; readonly input: unknown }[] },
  maxRecordBytes: number,
): boolean {
  const assistant = JSON.stringify({
    text: step.text,
    toolCalls: step.toolCalls.map((call) => ({
      callId: call.callId,
      name: call.name,
      input: displayOf(call.input),
    })),
  });
  if (!recordFits(assistant, "", maxRecordBytes)) return false;
  for (const call of step.toolCalls) {
    const data = JSON.stringify({ callId: call.callId, name: call.name, input: displayOf(call.input) });
    if (!recordFits(data, "", maxRecordBytes)) return false;
  }
  return true;
}

/** What one run's accepted input costs the recent-run window, envelope included. */
export const RUN_WINDOW_OVERHEAD = 256;

interface Counters {
  sessions: number;
  runs: number;
  plugins: number;
}

class SqliteRepository implements Repository {
  readonly storageId: string;
  readonly retention: "durable" | "ephemeral";
  readonly schemaVersion = SCHEMA_VERSION;
  private readonly database: DatabaseSync;
  private readonly limits: RepositoryLimits;
  private closed = false;

  constructor(database: DatabaseSync, retention: "durable" | "ephemeral", limits: RepositoryLimits) {
    this.database = database;
    this.retention = retention;
    this.limits = limits;
    this.storageId = this.readOrCreateStorageId();
  }

  private readOrCreateStorageId(): string {
    const row = this.database.prepare("SELECT value FROM meta WHERE key = 'storageId'").get() as
      | { readonly value?: string }
      | undefined;
    if (typeof row?.value === "string" && row.value.length > 0) return row.value;

    const storageId = globalThis.crypto.randomUUID();
    this.database.prepare("INSERT INTO meta (key, value) VALUES ('storageId', ?)").run(storageId);
    return storageId;
  }

  /** The identity is re-read from storage, so a botched first write cannot hide. */
  assertIdentified(): void {
    const row = this.database.prepare("SELECT value FROM meta WHERE key = 'storageId'").get() as
      | { readonly value?: string }
      | undefined;
    if (row?.value !== this.storageId) throw new StorageOpenError("the storage identity could not be recorded");
    const version = readUserVersion(this.database);
    if (version !== SCHEMA_VERSION) throw new StorageOpenError("the schema version could not be recorded");
  }

  get revisions(): CollectionRevisions {
    const rows = this.database.prepare("SELECT name, revision FROM collections").all() as {
      readonly name?: string;
      readonly revision?: number;
    }[];
    const found: Counters = { sessions: 0, runs: 0, plugins: 0 };
    for (const row of rows) {
      if (row.name === "sessions" && typeof row.revision === "number") found.sessions = row.revision;
      if (row.name === "runs" && typeof row.revision === "number") found.runs = row.revision;
      if (row.name === "plugins" && typeof row.revision === "number") found.plugins = row.revision;
    }
    return Object.freeze(found);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } catch {
      // Already gone; there is nothing left to release.
    }
  }

  // -------------------------------------------------------------------------
  // Transactions.
  // -------------------------------------------------------------------------

  /**
   * The verdict one write's own evidence is asked for after a lost receipt.
   *
   * `committed` carries the result the caller would have received had the
   * receipt arrived; `absent` is the store proving the batch never landed;
   * `indeterminate` is a store that cannot answer, which is neither.
   */
  private write<T>(act: () => T, verify: () => WriteVerdict<T>): T {
    this.database.exec("BEGIN IMMEDIATE");
    let value: T;
    try {
      value = act();
    } catch (error) {
      if (this.rollback()) throw error;
      // The rollback itself failed, so the transaction API cannot say what
      // happened. The batch's own evidence is the only remaining witness.
      const verdict = this.reach(verify);
      if (verdict.kind === "committed") return verdict.value;
      throw new CommitOutcomeUnknownError(describeFailure(error));
    }

    try {
      this.database.exec("COMMIT");
    } catch (error) {
      // A COMMIT that reported an error may or may not have committed; a
      // successful one leaves nothing to roll back. Both are settled by asking
      // the facts, never by assuming the receipt told the truth.
      this.rollback();
      const verdict = this.reach(verify);
      if (verdict.kind === "committed") return verdict.value;
      if (verdict.kind === "absent") throw error;
      throw new CommitOutcomeUnknownError(describeFailure(error));
    }
    return value;
  }

  /** Ends a transaction that did not commit; `false` means it could not be ended. */
  private rollback(): boolean {
    try {
      this.database.exec("ROLLBACK");
      return true;
    } catch {
      // Either the transaction is already over or the connection is unusable;
      // both are answered by the evidence query, not by guessing here.
      return false;
    }
  }

  /** Runs an evidence query; a query that fails is the same as no evidence. */
  private reach<T>(verify: () => WriteVerdict<T>): WriteVerdict<T> {
    try {
      return verify();
    } catch {
      return { kind: "indeterminate" };
    }
  }

  private bump(...collections: readonly ("sessions" | "runs" | "plugins")[]): void {
    for (const name of collections) {
      this.database.prepare("UPDATE collections SET revision = revision + 1 WHERE name = ?").run(name);
    }
  }

  // -------------------------------------------------------------------------
  // Reads.
  // -------------------------------------------------------------------------

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.database.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
    return row === undefined ? undefined : sessionOf(row as Row);
  }

  getDeletedSession(sessionId: string): number | undefined {
    const row = this.database.prepare("SELECT generation FROM deleted_sessions WHERE session_id = ?").get(sessionId) as
      | { readonly generation?: number }
      | undefined;
    return typeof row?.generation === "number" ? row.generation : undefined;
  }

  listSessions(limit: number, after: SessionCursorKey | null): SessionPage {
    // One row over the bound, so "there is more" is answered by the read
    // rather than inferred from a count that would itself be unbounded.
    const rows =
      after === null
        ? (this.database
            .prepare("SELECT * FROM sessions ORDER BY updated_at DESC, session_id DESC LIMIT ?")
            .all(limit + 1) as Row[])
        : (this.database
            .prepare(
              `SELECT * FROM sessions
               WHERE updated_at < ? OR (updated_at = ? AND session_id < ?)
               ORDER BY updated_at DESC, session_id DESC LIMIT ?`,
            )
            .all(after.updatedAt, after.updatedAt, after.sessionId, limit + 1) as Row[]);

    const records = rows.slice(0, limit).map(sessionOf);
    return { records, hasMore: rows.length > limit };
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
    return row === undefined ? undefined : runOf(row as Row);
  }

  getSubmission(submissionId: string): SubmissionRecord | undefined {
    const row = this.database
      .prepare("SELECT submission_id, session_id, input_hash, run_id, state FROM submissions WHERE submission_id = ?")
      .get(submissionId) as Row | undefined;
    if (row === undefined) return undefined;
    return Object.freeze({
      submissionId: String(row["submission_id"]),
      sessionId: String(row["session_id"]),
      inputHash: String(row["input_hash"]),
      runId: typeof row["run_id"] === "string" ? row["run_id"] : null,
      state: row["state"] === "retired" ? ("retired" as const) : ("active" as const),
    });
  }

  listRunsBySession(sessionId: string, limit: number, after: RunCursorKey | null): RunPage {
    const rows =
      after === null
        ? (this.database
            .prepare(
              "SELECT * FROM runs WHERE session_id = ? ORDER BY accepted_at DESC, run_id DESC LIMIT ?",
            )
            .all(sessionId, limit + 1) as Row[])
        : (this.database
            .prepare(
              `SELECT * FROM runs WHERE session_id = ?
                 AND (accepted_at < ? OR (accepted_at = ? AND run_id < ?))
               ORDER BY accepted_at DESC, run_id DESC LIMIT ?`,
            )
            .all(sessionId, after.acceptedAt, after.acceptedAt, after.runId, limit + 1) as Row[]);

    const records = rows.slice(0, limit).map(runOf);
    return { records, hasMore: rows.length > limit };
  }

  listRecentRuns(limit: number, maxBytes: number): RecentRunPage {
    // One row past the bound, so "there is more" is answered by the read that
    // would have returned it, not guessed from the count that fits.
    const rows = this.database
      .prepare("SELECT * FROM runs ORDER BY accepted_at DESC, run_id DESC LIMIT ?")
      .all(limit + 1) as Row[];
    const bounded = rows.slice(0, limit);

    // The window is bounded in encoded bytes as well as in count: a run's
    // accepted input is the largest thing it carries, and it is measured the
    // way it will actually travel — as JSON with its escaping — because a
    // character count is not what the frame pays for.
    const records: RunRecord[] = [];
    let bytes = 0;
    for (const row of bounded) {
      const record = runOf(row);
      const cost = encodedBytes(record.text) + RUN_WINDOW_OVERHEAD;
      if (records.length > 0 && bytes + cost > maxBytes) break;
      bytes += cost;
      records.push(record);
    }

    return { records: Object.freeze(records), hasMore: rows.length > records.length };
  }

  listUnfinishedRuns(): readonly RunRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM runs WHERE status IN ('accepted', 'running') ORDER BY accepted_at, run_id")
      .all() as Row[];
    return Object.freeze(rows.map(runOf));
  }

  verifyRunHistory(run: RunRecord): boolean {
    const range = this.database
      .prepare("SELECT committed_from_seq, committed_to_seq FROM runs WHERE run_id = ?")
      .get(run.runId) as
      | { readonly committed_from_seq?: number | null; readonly committed_to_seq?: number | null }
      | undefined;
    if (range === undefined) return false;

    // A run that claims no committed history is consistent when its range is
    // empty: a failed or interrupted run whose turn never settled may carry a
    // turn id it never got to commit, and that is not an inconsistency.
    if (range.committed_from_seq === null && range.committed_to_seq === null) return true;
    if (run.turnId === null) return false;

    const turn = this.database
      .prepare("SELECT start_seq, end_seq FROM turns WHERE session_id = ? AND turn_id = ?")
      .get(run.sessionId, run.turnId) as { readonly start_seq?: number; readonly end_seq?: number } | undefined;
    if (turn === undefined) return false;
    // The turn index and the run's recorded range became true in one commit;
    // agreeing with it is the only proof that this run's history is its own.
    return range.committed_from_seq === turn.start_seq && range.committed_to_seq === turn.end_seq;
  }

  verifyTurnCommit(input: CommitTurnInput): "committed" | "absent" | "indeterminate" {
    try {
      const endSeq = input.turnStartSeq + input.records.length;
      const session = this.getSession(input.sessionId);
      if (session === undefined) return "indeterminate";
      const run = this.getRun(input.runId);
      if (run === undefined) return "indeterminate";

      const turn = this.database
        .prepare("SELECT start_seq, end_seq, reason FROM turns WHERE session_id = ? AND turn_id = ?")
        .get(input.sessionId, input.turnId) as
        | { readonly start_seq?: number; readonly end_seq?: number; readonly reason?: string }
        | undefined;
      const events = this.database
        .prepare("SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND seq >= ? AND seq < ?")
        .get(input.sessionId, input.turnStartSeq, endSeq) as { readonly count?: number } | undefined;
      const terminal = run.status !== "accepted" && run.status !== "running";

      const fullyThere =
        session.committedSeq === endSeq &&
        turn !== undefined &&
        turn.start_seq === input.turnStartSeq &&
        turn.end_seq === endSeq &&
        turn.reason === input.reason &&
        events?.count === input.records.length &&
        terminal &&
        run.turnId === input.turnId;
      if (fullyThere) return "committed";

      const untouched = session.committedSeq === input.turnStartSeq && turn === undefined;
      if (untouched) return "absent";
      return "indeterminate";
    } catch {
      return "indeterminate";
    }
  }

  readHistory(sessionId: string, beforeSeq: number, maxEvents: number): HistoryRead {
    if (beforeSeq <= 0 || maxEvents <= 0) {
      return { records: [], fromSeq: Math.max(0, beforeSeq), toSeq: Math.max(0, beforeSeq) };
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM session_events WHERE session_id = ? AND seq < ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(sessionId, beforeSeq, maxEvents) as Row[];

    const records = rows.map(storedOf).reverse();
    const fromSeq = records.length === 0 ? beforeSeq : (records[0]?.seq ?? beforeSeq);
    return { records, fromSeq, toSeq: beforeSeq };
  }

  readTurnWindow(sessionId: string, maxTurns: number, maxBytes: number): TurnWindowRead {
    const session = this.getSession(sessionId);
    const nextSeq = session?.committedSeq ?? 0;
    const turns = this.database
      .prepare("SELECT start_seq, end_seq FROM turns WHERE session_id = ? ORDER BY start_seq DESC LIMIT ?")
      .all(sessionId, maxTurns) as { readonly start_seq?: number; readonly end_seq?: number }[];

    // The newest turn is examined first and the first turn that does not fit
    // ends the window — whether that is an older one or the newest one itself.
    // Nothing is skipped to reach an older turn, nothing oversized is forced
    // in, and the running total is the budget that matters: a window is allowed
    // to be smaller, or to hold no previous turns at all, but it is never
    // allowed to exceed what it was given.
    let baseSeq = nextSeq;
    let bytes = 0;
    for (const turn of turns) {
      const start = turn.start_seq;
      const end = turn.end_seq;
      if (typeof start !== "number" || typeof end !== "number") {
        throw new CorruptRecordError("the turn index holds a range that is not a range");
      }
      const spanBytes = this.measureRange(sessionId, start, end);
      if (bytes + spanBytes > maxBytes) break;
      bytes += spanBytes;
      baseSeq = start;
    }

    if (baseSeq >= nextSeq) return { records: Object.freeze([]), baseSeq: nextSeq, nextSeq };
    const rows = this.database
      .prepare("SELECT * FROM session_events WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq")
      .all(sessionId, baseSeq, nextSeq) as Row[];
    return { records: Object.freeze(rows.map(storedOf)), baseSeq, nextSeq };
  }

  /**
   * A range's real cost in bytes.
   *
   * `LENGTH` counts characters, and a character can be up to three UTF-8 bytes
   * and up to six escaped bytes; a window measured that way is not bounded in
   * what it actually loads. The cast to `BLOB` makes SQLite answer in bytes, and
   * each record's envelope is charged for too, because it travels as well.
   */
  private measureRange(sessionId: string, fromSeq: number, toSeq: number): number {
    const row = this.database
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(CAST(data AS BLOB)) + LENGTH(CAST(turn_id AS BLOB)) + 64), 0) AS bytes
           FROM session_events WHERE session_id = ? AND seq >= ? AND seq < ?`,
      )
      .get(sessionId, fromSeq, toSeq) as { readonly bytes?: number } | undefined;
    return typeof row?.bytes === "number" ? row.bytes : 0;
  }

  // -------------------------------------------------------------------------
  // Writes.
  // -------------------------------------------------------------------------

  createSession(input: CreateSessionInput): SessionRecord {
    return this.write<SessionRecord>(
      () => {
        if (this.getSession(input.sessionId) !== undefined) {
          throw new StorageOpenError("the session id is already in use");
        }
        this.database
          .prepare(
            `INSERT INTO sessions (
               session_id, generation, title, created_at, updated_at,
               metadata_revision, history_revision, committed_seq, status, blocked_reason, active_run_id
             ) VALUES (?, 1, ?, ?, ?, 0, 0, 0, 'ready', NULL, NULL)`,
          )
          .run(input.sessionId, input.title, input.createdAt, input.createdAt);
        this.bump("sessions");
        const created = this.getSession(input.sessionId);
        if (created === undefined) throw new StorageOpenError("the session could not be recorded");
        return created;
      },
      () => {
        const created = this.getSession(input.sessionId);
        if (created !== undefined && created.title === input.title && created.createdAt === input.createdAt) {
          return { kind: "committed" as const, value: created };
        }
        return { kind: "absent" as const };
      },
    );
  }

  admitRun(input: AdmitInput): AdmitOutcome {
    return this.write<AdmitOutcome>(
      () => {
        const submission = this.database
          .prepare("SELECT session_id, input_hash, run_id, state FROM submissions WHERE submission_id = ?")
          .get(input.submissionId) as
          | { readonly session_id?: string; readonly input_hash?: string; readonly run_id?: string; readonly state?: string }
          | undefined;

        if (submission !== undefined) {
          if (submission.state === "retired") return { kind: "retired" } as const;
          const sameIdentity =
            submission.session_id === input.sessionId && submission.input_hash === input.inputHash;
          if (!sameIdentity) return { kind: "conflict" } as const;
          const existing =
            typeof submission.run_id === "string" ? this.getRun(submission.run_id) : undefined;
          if (existing !== undefined) return { kind: "existing", run: existing } as const;
          // A submission row without its run is not a state this store can
          // produce; treating it as a conflict keeps it from becoming one.
          return { kind: "conflict" } as const;
        }

        const session = this.getSession(input.sessionId);
        if (session === undefined) return { kind: "session-not-found" } as const;
        if (session.status === "blocked") return { kind: "session-blocked" } as const;
        if (session.activeRunId !== null) return { kind: "session-busy" } as const;

        this.database
          .prepare(
            `INSERT INTO runs (
               run_id, submission_id, session_id, text, accepted_at, started_at, ended_at,
               host_instance_id, status, end_reason, error_code, execution_knowledge, turn_id,
               cancel_requested, committed_from_seq, committed_to_seq
             ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'accepted', NULL, NULL, NULL, NULL, 0, NULL, NULL)`,
          )
          .run(input.runId, input.submissionId, input.sessionId, input.text, input.acceptedAt, input.hostInstanceId);
        this.database
          .prepare(
            "INSERT INTO submissions (submission_id, session_id, input_hash, run_id, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
          )
          .run(input.submissionId, input.sessionId, input.inputHash, input.runId, input.acceptedAt);
        this.database
          .prepare(
            `UPDATE sessions SET active_run_id = ?, metadata_revision = metadata_revision + 1, updated_at = ?
             WHERE session_id = ?`,
          )
          .run(input.runId, input.acceptedAt, input.sessionId);
        this.bump("sessions", "runs");

        const run = this.getRun(input.runId);
        const updated = this.getSession(input.sessionId);
        if (run === undefined || updated === undefined) throw new StorageOpenError("the admission could not be recorded");
        return { kind: "admitted", run, session: updated } as const;
      },
      () => {
        // Admission is one row each in three tables plus the session's pointer;
        // all of them present and pointing at each other is the proof it landed.
        const run = this.getRun(input.runId);
        const session = this.getSession(input.sessionId);
        const submission = this.getSubmission(input.submissionId);
        if (
          run !== undefined &&
          session !== undefined &&
          submission !== undefined &&
          submission.runId === input.runId &&
          run.status === "accepted" &&
          session.activeRunId === input.runId
        ) {
          return { kind: "committed" as const, value: { kind: "admitted", run, session } as const };
        }
        if (run === undefined && submission === undefined) return { kind: "absent" as const };
        return { kind: "indeterminate" as const };
      },
    );
  }

  markRunStarted(runId: string, hostInstanceId: string, at: number): RunRecord {
    return this.write<RunRecord>(
      () => {
        const changed = this.database
          .prepare(
            `UPDATE runs SET status = 'running', started_at = ?, host_instance_id = ?
             WHERE run_id = ? AND status = 'accepted'`,
          )
          .run(at, hostInstanceId, runId);
        if (changed.changes !== 1) {
          throw new StorageOpenError("the run is not in a state that can be started");
        }
        this.bump("runs");
        const run = this.getRun(runId);
        if (run === undefined) throw new StorageOpenError("the start marker could not be recorded");
        return run;
      },
      () => {
        const run = this.getRun(runId);
        if (run !== undefined && run.status === "running" && run.hostInstanceId === hostInstanceId && run.startedAt !== null) {
          return { kind: "committed" as const, value: run };
        }
        if (run !== undefined && run.status === "accepted" && run.startedAt === null) {
          return { kind: "absent" as const };
        }
        return { kind: "indeterminate" as const };
      },
    );
  }

  commitTurn(input: CommitTurnInput): CommitTurnResult {
    return this.write<CommitTurnResult>(
      () => {
        const session = this.getSession(input.sessionId);
        if (session === undefined) throw new StorageOpenError("the session is gone");
        if (input.turnStartSeq !== session.committedSeq) {
          // A batch that does not continue the committed log exactly is not a
          // batch this store can add; refusing is what keeps seqs honest.
          throw new StorageOpenError("the turn batch does not continue the committed log");
        }

        let seq = input.turnStartSeq;
        for (const record of input.records) {
          if (record.seq !== seq) throw new StorageOpenError("the turn batch is not contiguous");
          this.assertRecordFits(record);
          this.database
            .prepare("INSERT INTO session_events (session_id, seq, turn_id, type, time, data) VALUES (?, ?, ?, ?, ?, ?)")
            .run(input.sessionId, record.seq, record.turnId, record.type, record.time, record.data);
          seq += 1;
        }

        this.database
          .prepare("INSERT INTO turns (session_id, turn_id, start_seq, end_seq, reason) VALUES (?, ?, ?, ?, ?)")
          .run(input.sessionId, input.turnId, input.turnStartSeq, seq, input.reason);
        this.database
          .prepare(
            `UPDATE sessions SET
               committed_seq = ?, history_revision = history_revision + 1,
               metadata_revision = metadata_revision + 1, updated_at = ?, active_run_id = NULL
             WHERE session_id = ?`,
          )
          .run(seq, input.endedAt, input.sessionId);
        this.database
          .prepare(
            `UPDATE runs SET
               status = ?, end_reason = ?, ended_at = ?, turn_id = ?,
               committed_from_seq = ?, committed_to_seq = ?
             WHERE run_id = ?`,
          )
          .run(statusFor(input.reason), input.reason, input.endedAt, input.turnId, input.turnStartSeq, seq, input.runId);
        this.bump("sessions", "runs");

        return this.committedResult(input.sessionId, input.runId);
      },
      () => {
        const verdict = this.verifyTurnCommit(input);
        if (verdict === "committed") {
          return { kind: "committed" as const, value: this.committedResult(input.sessionId, input.runId) };
        }
        return verdict === "absent" ? { kind: "absent" as const } : { kind: "indeterminate" as const };
      },
    );
  }

  failRun(input: HostFaultInput): CommitTurnResult {
    return this.write<CommitTurnResult>(
      () => {
        const session = this.getSession(input.sessionId);
        if (session === undefined) throw new StorageOpenError("the session is gone");
        this.database
          .prepare(
            `UPDATE runs SET status = 'failed', end_reason = 'host_error', error_code = ?, ended_at = ?, turn_id = ?
             WHERE run_id = ?`,
          )
          .run(input.errorCode, input.endedAt, input.turnId, input.runId);
        this.database
          .prepare(
            `UPDATE sessions SET
               status = 'blocked', blocked_reason = ?, metadata_revision = metadata_revision + 1,
               updated_at = ?, active_run_id = NULL
             WHERE session_id = ?`,
          )
          .run(input.blockedReason, input.endedAt, input.sessionId);
        this.bump("sessions", "runs");
        return this.committedResult(input.sessionId, input.runId);
      },
      () => {
        const run = this.getRun(input.runId);
        const session = this.getSession(input.sessionId);
        if (
          run !== undefined &&
          run.status === "failed" &&
          session !== undefined &&
          session.status === "blocked" &&
          session.blockedReason === input.blockedReason &&
          session.activeRunId === null
        ) {
          return { kind: "committed" as const, value: this.committedResult(input.sessionId, input.runId) };
        }
        if (
          run !== undefined &&
          (run.status === "accepted" || run.status === "running") &&
          session !== undefined &&
          session.activeRunId === input.runId
        ) {
          return { kind: "absent" as const };
        }
        return { kind: "indeterminate" as const };
      },
    );
  }

  requestCancel(runId: string, at: number): RunRecord {
    const current = this.getRun(runId);
    if (current === undefined) throw new StorageOpenError("the run is gone");
    // A terminal run has nothing left to record and a recorded intent is never
    // written twice; both answer with the record itself, so the caller can
    // still tell a durable intent from one that was never written.
    if (current.status !== "accepted" && current.status !== "running") return current;
    if (current.cancelRequested) return current;
    void at;

    return this.write<RunRecord>(
      () => {
        this.database.prepare("UPDATE runs SET cancel_requested = 1 WHERE run_id = ?").run(runId);
        this.bump("runs");
        const updated = this.getRun(runId);
        if (updated === undefined) throw new StorageOpenError("the cancel intent could not be recorded");
        return updated;
      },
      () => {
        const run = this.getRun(runId);
        if (run !== undefined && run.cancelRequested) {
          return { kind: "committed" as const, value: run };
        }
        if (run !== undefined && !run.cancelRequested && (run.status === "accepted" || run.status === "running")) {
          return { kind: "absent" as const };
        }
        return { kind: "indeterminate" as const };
      },
    );
  }

  renameSession(input: RenameInput): RenameOutcome {
    return this.write<RenameOutcome>(
      () => {
        const session = this.getSession(input.sessionId);
        if (session === undefined) return { kind: "not-found" } as const;
        if (session.metadataRevision !== input.expectedRevision) {
          return { kind: "revision-conflict", session } as const;
        }
        this.database
          .prepare(
            `UPDATE sessions SET title = ?, metadata_revision = metadata_revision + 1, updated_at = ?
             WHERE session_id = ? AND metadata_revision = ?`,
          )
          .run(input.title, input.at, input.sessionId, input.expectedRevision);
        this.bump("sessions");
        const renamed = this.getSession(input.sessionId);
        if (renamed === undefined) throw new StorageOpenError("the rename could not be recorded");
        return { kind: "renamed", session: renamed } as const;
      },
      () => {
        const session = this.getSession(input.sessionId);
        if (session !== undefined && session.title === input.title && session.metadataRevision === input.expectedRevision + 1) {
          return { kind: "committed" as const, value: { kind: "renamed", session } as const };
        }
        if (session !== undefined && session.metadataRevision === input.expectedRevision) {
          return { kind: "absent" as const };
        }
        return { kind: "indeterminate" as const };
      },
    );
  }

  deleteSession(input: DeleteInput): DeleteOutcome {
    return this.write<DeleteOutcome>(
      () => {
        const session = this.getSession(input.sessionId);
        if (session === undefined) return { kind: "not-found" } as const;
        if (session.metadataRevision !== input.expectedRevision) {
          return { kind: "revision-conflict", session } as const;
        }
        // An unfinished run owns an execution. Deleting around it would destroy
        // the only record of work that may have had effects.
        if (session.activeRunId !== null) return { kind: "busy" } as const;

        // The submission identities this session spent are retired, not
        // released: the smallest record that keeps a deleted conversation's
        // submission from becoming a fresh one.
        this.database
          .prepare("UPDATE submissions SET state = 'retired', run_id = NULL WHERE session_id = ?")
          .run(input.sessionId);
        this.database.prepare("DELETE FROM runs WHERE session_id = ?").run(input.sessionId);
        this.database.prepare("DELETE FROM sessions WHERE session_id = ?").run(input.sessionId);
        this.database
          .prepare("INSERT INTO deleted_sessions (session_id, generation, deleted_at) VALUES (?, ?, ?)")
          .run(input.sessionId, session.generation, input.at);
        this.bump("sessions", "runs");
        return { kind: "deleted", generation: session.generation } as const;
      },
      () => {
        const still = this.getSession(input.sessionId);
        const tombstone = this.getDeletedSession(input.sessionId);
        if (still === undefined && tombstone !== undefined) {
          return { kind: "committed" as const, value: { kind: "deleted", generation: tombstone } as const };
        }
        if (still !== undefined) return { kind: "absent" as const };
        return { kind: "indeterminate" as const };
      },
    );
  }

  bumpPluginRevision(): CollectionRevisions {
    const before = this.revisions.plugins;
    return this.write<CollectionRevisions>(
      () => {
        this.bump("plugins");
        return this.revisions;
      },
      () => {
        const now = this.revisions;
        if (now.plugins === before + 1) return { kind: "committed" as const, value: now };
        if (now.plugins === before) return { kind: "absent" as const };
        return { kind: "indeterminate" as const };
      },
    );
  }

  reconcileInterrupted(hostInstanceId: string, at: number): ReconcileResult {
    const pending = this.listUnfinishedRuns().length;
    if (pending === 0) return { interrupted: 0, revisions: this.revisions };

    return this.write<ReconcileResult>(
      () => {
        let interrupted = 0;
        for (const run of this.listUnfinishedRuns()) {
          // The evidence class is read from what was actually committed: accepted
          // with no start marker proves nothing was dispatched; a start marker
          // proves a start and nothing about what followed it.
          const knowledge: ExecutionKnowledge = run.startedAt === null ? "not-started" : "unknown";
          this.database
            .prepare(
              `UPDATE runs SET status = 'interrupted', end_reason = 'interrupted', execution_knowledge = ?,
                 ended_at = ?, host_instance_id = ?
               WHERE run_id = ? AND status IN ('accepted', 'running')`,
            )
            .run(knowledge, at, hostInstanceId, run.runId);

          const session = this.getSession(run.sessionId);
          if (session === undefined) continue;
          // `not-started` clears the pointer and leaves the session usable; a
          // running marker blocks it, because nothing in the record can say
          // whether the execution had already produced effects.
          const blocked = knowledge === "unknown";
          this.database
            .prepare(
              `UPDATE sessions SET
                 active_run_id = NULL, status = ?, blocked_reason = ?,
                 metadata_revision = metadata_revision + 1, updated_at = ?
               WHERE session_id = ?`,
            )
            .run(blocked ? "blocked" : "ready", blocked ? "unknown-execution" : null, at, run.sessionId);
          interrupted += 1;
        }

        if (interrupted > 0) this.bump("sessions", "runs");
        return { interrupted, revisions: this.revisions };
      },
      () => {
        const left = this.listUnfinishedRuns().length;
        if (left === 0) {
          return { kind: "committed" as const, value: { interrupted: pending, revisions: this.revisions } };
        }
        if (left === pending) return { kind: "absent" as const };
        return { kind: "indeterminate" as const };
      },
    );
  }

  private committedResult(sessionId: string, runId: string): CommitTurnResult {
    const session = this.getSession(sessionId);
    const run = this.getRun(runId);
    if (session === undefined || run === undefined) {
      throw new StorageOpenError("the commit could not be read back");
    }
    return { session, run, revisions: this.revisions };
  }

  private assertRecordFits(record: StoredRecord): void {
    if (!recordFits(record.data, record.turnId, this.limits.maxRecordBytes)) {
      const size = Buffer.byteLength(record.data, "utf8") + Buffer.byteLength(record.turnId, "utf8") + RECORD_OVERHEAD_BYTES;
      throw new RecordTooLargeError(`a ${record.type} record is ${size} bytes`);
    }
  }
}

function statusFor(reason: string): RunStatus {
  switch (reason) {
    case "completed":
      return "completed";
    case "max_steps":
      return "limited";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

type Row = Record<string, unknown>;

function sessionOf(row: Row): SessionRecord {
  const blockedReason = row["blocked_reason"];
  return Object.freeze({
    sessionId: String(row["session_id"]),
    generation: Number(row["generation"]),
    title: String(row["title"]),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
    metadataRevision: Number(row["metadata_revision"]),
    historyRevision: Number(row["history_revision"]),
    committedSeq: Number(row["committed_seq"]),
    status: row["status"] === "blocked" ? ("blocked" as const) : ("ready" as const),
    blockedReason:
      blockedReason === "unknown-execution" || blockedReason === "host-fault"
        ? (blockedReason as BlockedReason)
        : null,
    activeRunId: typeof row["active_run_id"] === "string" ? row["active_run_id"] : null,
  });
}

function runOf(row: Row): RunRecord {
  return Object.freeze({
    runId: String(row["run_id"]),
    submissionId: String(row["submission_id"]),
    sessionId: String(row["session_id"]),
    text: String(row["text"]),
    acceptedAt: Number(row["accepted_at"]),
    startedAt: typeof row["started_at"] === "number" ? row["started_at"] : null,
    endedAt: typeof row["ended_at"] === "number" ? row["ended_at"] : null,
    hostInstanceId: String(row["host_instance_id"]),
    status: String(row["status"]) as RunStatus,
    endReason: (typeof row["end_reason"] === "string" ? row["end_reason"] : null) as EndReason | null,
    errorCode: typeof row["error_code"] === "string" ? row["error_code"] : null,
    executionKnowledge:
      row["execution_knowledge"] === "not-started" || row["execution_knowledge"] === "unknown"
        ? (row["execution_knowledge"] as ExecutionKnowledge)
        : null,
    turnId: typeof row["turn_id"] === "string" ? row["turn_id"] : null,
    cancelRequested: row["cancel_requested"] === 1,
  });
}

function storedOf(row: Row): StoredRecord {
  return Object.freeze({
    seq: Number(row["seq"]),
    turnId: String(row["turn_id"]),
    type: String(row["type"]) as SessionEvent["type"],
    time: Number(row["time"]),
    data: String(row["data"]),
  });
}
