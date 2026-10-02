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

/**
 * What a connection can say about a transaction it tried to end.
 *
 * `ended` is a fact about the connection: no transaction is open, so a read
 * through it sees committed rows and only committed rows. `open` is a rollback
 * that did not happen — the transaction is still there, and so are its
 * uncommitted rows. `unknown` is a connection that cannot even be asked.
 */
type TransactionState = "ended" | "open" | "unknown";

/**
 * The schema generation this build writes and reads.
 *
 * Version 2 adds the terminal commit's ownership binding: the turn index row
 * names the run that committed it (`turns.run_id`), written in the same
 * transaction as the run's own pointer. It exists because a run's pointer and
 * the turn it names are two copies of one claim, and two self-consistent
 * copies cannot prove they belong together — exchanging them between two runs
 * leaves both looking valid. The turn's own row is the independent half. A
 * store written before version 2 has no such half, and nothing here invents
 * one: a turn without an owner reads exactly like a turn with the wrong one,
 * and both are refused.
 */
export const SCHEMA_VERSION = 2;

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

/** One turn index row's own ownership claim: who committed it, and with what. */
interface TurnOwnerRow {
  readonly turnId: string;
  readonly startSeq: number;
  readonly endSeq: number;
  readonly reason: string;
  /** The run the commit transaction recorded as this turn's owner; `null` in stores written before the binding. */
  readonly runId: string | null;
}

/** The exact half-open range one proven turn holds, as its index row records it. */
export interface TurnOwnerRange {
  readonly startSeq: number;
  readonly endSeq: number;
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

/**
 * A connection whose own reads can no longer be taken as the store's facts.
 *
 * It is the state a connection is left in when a transaction could not be
 * ended: whatever that transaction wrote is still visible to this connection,
 * so a read here could answer with rows the store never made durable — and a
 * terminal read off uncommitted rows is exactly the fabricated outcome the
 * commit rules exist to prevent. Reads through such a connection are refused
 * until a trustworthy view of the same store has been re-established.
 */
export class StoreUntrustedError extends Error {
  constructor(detail: string) {
    super(`the store cannot be read as its own committed facts: ${detail}`);
    this.name = "StoreUntrustedError";
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
   * Whether one turn index row is proven to be the turn its owner run
   * committed — the same ownership and accepted-input proof the run read, the
   * execution window and the commit confirmation all apply, asked about a
   * single turn and checked from the turn's own side.
   *
   * This is the bounded question a history page asks about each turn its
   * records belong to: a page may be a fragment, but every fact it publishes
   * still has to belong to a turn this store can prove. `false` covers every
   * way a turn can fail to be provable — no index row, no owner binding, a
   * legacy NULL owner, an owner that names another turn, session, range or
   * reason, or a canonical first user fact that is not the accepted input —
   * and each of them is refused, never repaired.
   */
  verifyTurnOwnership(sessionId: string, turnId: string): boolean;
  /**
   * The exact half-open range one turn is proven to hold, or `undefined` when
   * that turn cannot be proven at all.
   *
   * The proof and the range are one answer, never two steps: a caller that has
   * to know *which positions* a turn may publish — a history page binding a
   * record to the turn its own id names — must not be able to hold a range
   * from a turn the store cannot vouch for, because then the range would carry
   * authority the turn itself never earned. `undefined` is exactly the answer
   * `verifyTurnOwnership` gives `false` for, and the two are one lookup.
   */
  ownedTurnRange(sessionId: string, turnId: string): TurnOwnerRange | undefined;
  /**
   * The exact range one turn may be *published* at, proven under both proofs
   * a committed turn carries.
   *
   * A history page is the one reader that may publish fragments, and neither
   * proof alone is enough for it. The turn-side binding alone is satisfied by
   * a forged pair of rows moved together; the run read alone answers the
   * vacuous `true` for a run that never committed a turn. So a page asks for
   * the range only under both: the owner run's row must hold this exact
   * committed range, *and* that range must pass `verifyRunHistory` — the
   * authority `runs.get` serves by. A turn that fails either is a turn no page
   * may publish, and the answer is `undefined` rather than a range.
   */
  publishableTurnRange(sessionId: string, turnId: string): TurnOwnerRange | undefined;
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
  /**
   * Blocks one session whose committed canonical could not be read as fact.
   *
   * A corruption found while reading a session's history or a run's recorded
   * outcome is a fact about that session: nothing may execute against a history
   * the host cannot trust. The block is durable, keeps the session readable,
   * renameable and deletable, and is the same safe state a run with an unknown
   * outcome leaves behind — there is no unblock operation in this phase.
   */
  blockCorruptSession(sessionId: string, at: number): SessionRecord | undefined;
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

/**
 * Whether a stored value is a display input, exactly.
 *
 * `kind: "json"` is a claim that there is a JSON value to show, and the claim is
 * only taken with the value actually present and JSON-safe: a record that says
 * "json" and holds nothing is corruption, not an input that reads back as
 * `undefined`. `kind: "unavailable"` is the one fixed reason this host writes,
 * so any other word is a shape it did not produce.
 */
function isDisplayInput(value: unknown): value is DisplayInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record["kind"] === "unavailable") return record["reason"] === "not-json-safe";
  if (record["kind"] !== "json") return false;
  return "value" in record && validateJsonValue(record["value"]).success;
}

/** Whether two display inputs show the same thing, key order aside. */
function sameDisplayInput(left: DisplayInput, right: DisplayInput): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "unavailable" || right.kind === "unavailable") {
    return left.kind === "unavailable" && right.kind === "unavailable" && left.reason === right.reason;
  }
  return sameJsonValue(left.value, right.value);
}

/** Whether two JSON values are the same value, key order aside. */
function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameJsonValue(item, right[index] as JsonValue));
  }

  const leftKeys = Object.keys(left);
  const rightRecord = right as { readonly [key: string]: JsonValue };
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;
  const leftRecord = left as { readonly [key: string]: JsonValue };
  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameJsonValue(leftRecord[key] as JsonValue, rightRecord[key] as JsonValue),
  );
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
  /**
   * The calls an assistant record declared and no `tool/call` has answered yet.
   *
   * The declaration is the claim and the call record is the fact: a tool call
   * that is not the one declared — a different id, a different name, a different
   * input — is a log where the model was told something the tools were not, and
   * a declared call with no record behind it is the same lie the other way
   * round. Both are refused here.
   */
  const declared: { readonly callId: string; readonly name: string; readonly input: DisplayInput }[] = [];
  let awaitingResult = false;
  let openCall: { readonly callId: string; readonly name: string } | undefined;

  const resolveBeforeTurnEnd = (seq: number): void => {
    if (awaitingResult) throw new CorruptRecordError(`turn end at seq ${seq} leaves a tool call unanswered`);
    if (declared.length > 0) throw new CorruptRecordError(`turn end at seq ${seq} leaves declared tool calls unrecorded`);
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
        if (declared.length > 0) throw new CorruptRecordError("an assistant record interrupts tool calls it never recorded");
        const calls = storedToolCalls(record.data);
        if (calls === undefined) throw new CorruptRecordError("an assistant record's calls cannot be read back");
        declared.push(...calls.map((call) => ({ callId: call.callId, name: call.name, input: call.input })));
        declarable = true;
        break;
      }
      case "tool/call": {
        if (awaitingResult) throw new CorruptRecordError("a tool call interrupts an unanswered tool call");
        const parsed = parseStoredRecord(record);
        const display = storedDisplay(record.data);
        if (display === undefined) throw new CorruptRecordError("a tool call record's input cannot be read back");
        if (declarable) {
          const claim = declared.shift();
          if (claim === undefined) {
            throw new CorruptRecordError(`a tool call at seq ${record.seq} was never declared by an assistant record`);
          }
          if (
            claim.callId !== parsed["callId"] ||
            claim.name !== parsed["name"] ||
            !sameDisplayInput(claim.input, display)
          ) {
            throw new CorruptRecordError(`a tool call at seq ${record.seq} is not the call an assistant record declared`);
          }
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
  {
    version: 2,
    statements: [
      // The owner binding, and nothing else. Existing turn rows keep a NULL
      // owner on purpose: copying a run's current pointer into it would be
      // manufacturing the very proof the column exists to carry, and a
      // pre-version-2 store has no evidence a swap did not happen. Such a
      // turn is refused when it is read, like any record that is not what it
      // claims to be.
      `ALTER TABLE turns ADD COLUMN run_id TEXT`,
      `CREATE UNIQUE INDEX turns_by_owner ON turns (run_id) WHERE run_id IS NOT NULL`,
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
    database = openDatabase(options.location);
  } catch (error) {
    throw error instanceof StorageOpenError ? error : new StorageOpenError(describeFailure(error));
  }

  try {
    const repository = new SqliteRepository(
      database,
      ephemeral ? "ephemeral" : "durable",
      ephemeral ? null : options.location,
      options.limits,
    );
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

/**
 * Opens one connection: ownership, pragmas, schema.
 *
 * This is the whole open sequence, and it is deliberately one function so that
 * re-establishing a trustworthy view of a store after an unjudgeable write is
 * the same operation as opening it the first time — a fresh connection can only
 * see committed facts, which is exactly what makes it trustworthy.
 */
function openDatabase(location: string): DatabaseSync {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(location);
  } catch (error) {
    throw new StorageOpenError(describeFailure(error));
  }

  try {
    if (location !== ":memory:") {
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
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // The connection is already unusable; the open failure is what matters.
    }
    throw error instanceof StorageOpenError ? error : new StorageOpenError(describeFailure(error));
  }
}

/** The storage identity a connection can see, if it records one. */
function readStorageId(database: DatabaseSync): string | undefined {
  const row = database.prepare("SELECT value FROM meta WHERE key = 'storageId'").get() as
    | { readonly value?: string }
    | undefined;
  return typeof row?.value === "string" ? row.value : undefined;
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

/**
 * The longest turn identity a stored record may carry.
 *
 * Turn identities are minted by the Core as UUIDs, and the store enforces this
 * exact bound on every record it accepts. That is what lets an input be judged
 * before its turn exists — the check uses the largest identity the store will
 * ever write, so a record that passes is a record the store takes, and for the
 * identities this runtime really mints the two numbers are the same one.
 */
export const MAX_TURN_ID_BYTES = 36;

/** Whether a record of this encoded payload fits, once its identity is charged for. */
function payloadFits(data: string, identityBytes: number, maxRecordBytes: number): boolean {
  return Buffer.byteLength(data, "utf8") + identityBytes + RECORD_OVERHEAD_BYTES <= maxRecordBytes;
}

/** Whether a settled record of these encoded bytes could be stored whole. */
export function recordFits(data: string, turnId: string, maxRecordBytes: number): boolean {
  return payloadFits(data, Buffer.byteLength(turnId, "utf8"), maxRecordBytes);
}

/**
 * Whether one accepted input's user fact can be stored whole.
 *
 * Checked against the record as it will actually be written, not against the
 * raw text: JSON escaping is what turns 16 KiB of control characters into a
 * record the store would refuse. The identity is the store's own declared
 * bound, because this input's turn has not been opened yet — and the store
 * enforces that bound on every record it takes, so the check and the write
 * agree by construction. A refusal here means the input was never accepted,
 * never model-bound and never tool-bound.
 */
export function userRecordFits(text: string, maxRecordBytes: number): boolean {
  return payloadFits(JSON.stringify({ text }), MAX_TURN_ID_BYTES, maxRecordBytes);
}

/**
 * The heaviest input the store would still accept, as a value.
 *
 * A control character is the most expensive character there is — six bytes once
 * escaped — so the input that weighs most is one made of nothing else, at the
 * length where its record exactly fills the bound. It is what "a legal input"
 * means for any check that has to model one before it exists.
 */
export function heaviestAcceptedText(maxRecordBytes: number): string {
  const payload = Buffer.byteLength(JSON.stringify({ text: "" }), "utf8");
  const escaped = maxRecordBytes - MAX_TURN_ID_BYTES - RECORD_OVERHEAD_BYTES - payload;
  return "\u0000".repeat(Math.max(0, Math.floor(escaped / 6)));
}

/**
 * The encoded payloads one model step will be stored as: its assistant
 * declaration, then each of its calls.
 *
 * Built through `encodeStoredData`, the one payload builder the commit path
 * uses, so what is measured here is the record that will be written — the same
 * escaping, the same field assembly, the same builder — and not a second
 * estimate that could drift from it.
 */
export function stepRecordPayloads(
  step: {
    readonly text: string;
    readonly toolCalls: readonly { readonly callId: string; readonly name: string; readonly input: unknown }[];
  },
  turnId: string,
): readonly string[] {
  const assistant: SessionEvent = {
    type: "message/assistant",
    turnId,
    seq: 0,
    time: 0,
    data: { text: step.text, toolCalls: step.toolCalls.map((call) => ({ callId: call.callId, name: call.name, input: call.input })) },
  };
  const payloads = [encodeStoredData(assistant)];
  for (const call of step.toolCalls) {
    const event: SessionEvent = {
      type: "tool/call",
      turnId,
      seq: 0,
      time: 0,
      data: { callId: call.callId, name: call.name, input: call.input },
    };
    payloads.push(encodeStoredData(event));
  }
  return payloads;
}

/**
 * Whether one model step's assistant declaration and its calls can be stored,
 * told the turn the step belongs to.
 *
 * Both the declaration and each call become their own durable record, so each is
 * measured — with the step's real turn identity, through the store's own
 * builder, against the store's own bound. This is deliberately only
 * representability: no truncation, no dropping a call, no rewriting arguments —
 * a step that cannot be stored whole is a step that does not run, and it is
 * refused before any of its tools are dispatched.
 */
export function stepRecordsFit(
  step: {
    readonly text: string;
    readonly toolCalls: readonly { readonly callId: string; readonly name: string; readonly input: unknown }[];
  },
  turnId: string,
  maxRecordBytes: number,
): boolean {
  const identityBytes = Buffer.byteLength(turnId, "utf8");
  return stepRecordPayloads(step, turnId).every((data) => payloadFits(data, identityBytes, maxRecordBytes));
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
  private database: DatabaseSync;
  /** The file behind the connection, or `null` when the store is this connection. */
  private readonly location: string | null;
  private readonly limits: RepositoryLimits;
  /** Whether a read through this connection can still be the store's own answer. */
  private trusted = true;
  private closed = false;

  constructor(
    database: DatabaseSync,
    retention: "durable" | "ephemeral",
    location: string | null,
    limits: RepositoryLimits,
  ) {
    this.database = database;
    this.retention = retention;
    this.location = location;
    this.limits = limits;
    this.storageId = this.readOrCreateStorageId();
  }

  private readOrCreateStorageId(): string {
    const recorded = readStorageId(this.database);
    if (recorded !== undefined && recorded.length > 0) return recorded;

    const storageId = globalThis.crypto.randomUUID();
    this.database.prepare("INSERT INTO meta (key, value) VALUES ('storageId', ?)").run(storageId);
    return storageId;
  }

  /** The identity is re-read from storage, so a botched first write cannot hide. */
  assertIdentified(): void {
    if (readStorageId(this.database) !== this.storageId) {
      throw new StorageOpenError("the storage identity could not be recorded");
    }
    const version = readUserVersion(this.database);
    if (version !== SCHEMA_VERSION) throw new StorageOpenError("the schema version could not be recorded");
  }

  get revisions(): CollectionRevisions {
    this.assertTrusted();
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
    this.assertTrusted();
    this.database.exec("BEGIN IMMEDIATE");
    let value: T;
    try {
      value = act();
    } catch (error) {
      // The transaction is ended before anything is asked of the store: only a
      // connection with no open transaction reads committed facts, and the
      // batch's own rows would otherwise answer the question about the batch.
      const state = this.endTransaction();
      if (state !== "ended") {
        this.distrust();
        throw new CommitOutcomeUnknownError(describeFailure(error));
      }
      throw error;
    }

    try {
      this.database.exec("COMMIT");
    } catch (error) {
      // A COMMIT that reported an error may or may not have committed. That is
      // settled by the batch's own evidence — but only once the transaction is
      // known to be over: while it is still open, the evidence query would read
      // the batch's uncommitted rows and call them durable.
      const state = this.endTransaction();
      if (state !== "ended") {
        this.distrust();
        throw new CommitOutcomeUnknownError(describeFailure(error));
      }
      const verdict = this.reach(verify);
      if (verdict.kind === "committed") return verdict.value;
      if (verdict.kind === "absent") throw error;
      throw new CommitOutcomeUnknownError(describeFailure(error));
    }
    return value;
  }

  /**
   * Ends the transaction this connection is in, and says what is known about it.
   *
   * A rollback that runs is one fact: the transaction is over and none of its
   * rows are durable, which is what makes a read through this connection the
   * store's own answer again. A rollback that reports an error is not a fact at
   * all — it may have had nothing to roll back (a commit that landed) or it may
   * have failed with the transaction still open — so the connection itself is
   * asked, and a connection that cannot answer is not trusted to be readable.
   */
  private endTransaction(): TransactionState {
    try {
      this.database.exec("ROLLBACK");
    } catch {
      // Answered by the question below, not by guessing here.
    }
    try {
      return this.database.isTransaction ? "open" : "ended";
    } catch {
      return "unknown";
    }
  }

  /** Refuses a read or a write through a connection this host cannot trust. */
  private assertTrusted(): void {
    if (!this.trusted) {
      throw new StoreUntrustedError("the connection still holds a transaction it could not end");
    }
  }

  /**
   * Stops trusting this connection, and tries to obtain a trustworthy view of
   * the same store instead.
   *
   * For a durable store a fresh connection *is* that view: it can only see
   * committed facts, so the batch that could not be judged stays judged by what
   * the store actually holds. The replacement is verified before it is adopted
   * — same storage identity, same schema — and a store that lives only inside
   * this connection (an in-memory one) has no such view to re-establish, so it
   * stays unreadable rather than showing rows that may never have landed.
   */
  private distrust(): void {
    this.trusted = false;
    if (this.location === null) return;

    // Ownership is the lock, and the lock belongs to the connection: the old one
    // is released before a replacement can take it.
    try {
      this.database.close();
    } catch {
      // A connection that cannot close is not one to re-read from either.
      return;
    }

    let replacement: DatabaseSync | undefined;
    try {
      replacement = openDatabase(this.location);
      if (readStorageId(replacement) !== this.storageId) {
        throw new StorageOpenError("the storage identity changed");
      }
      if (readUserVersion(replacement) !== SCHEMA_VERSION) {
        throw new StorageOpenError("the schema version changed");
      }
      this.database = replacement;
      this.trusted = true;
    } catch {
      if (replacement !== undefined) {
        try {
          replacement.close();
        } catch {
          // Unusable either way; this repository stays refused.
        }
      }
      // Nothing trustworthy is left to read, so nothing is read: the connection
      // that would answer is gone, and `assertTrusted` refuses every access.
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
    this.assertTrusted();
    const row = this.database.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
    return row === undefined ? undefined : sessionOf(row as Row);
  }

  getDeletedSession(sessionId: string): number | undefined {
    this.assertTrusted();
    const row = this.database.prepare("SELECT generation FROM deleted_sessions WHERE session_id = ?").get(sessionId) as
      | { readonly generation?: number }
      | undefined;
    return typeof row?.generation === "number" ? row.generation : undefined;
  }

  listSessions(limit: number, after: SessionCursorKey | null): SessionPage {
    this.assertTrusted();
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
    this.assertTrusted();
    const row = this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
    return row === undefined ? undefined : runOf(row as Row);
  }

  getSubmission(submissionId: string): SubmissionRecord | undefined {
    this.assertTrusted();
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
    this.assertTrusted();
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
    this.assertTrusted();
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
    this.assertTrusted();
    const rows = this.database
      .prepare("SELECT * FROM runs WHERE status IN ('accepted', 'running') ORDER BY accepted_at, run_id")
      .all() as Row[];
    return Object.freeze(rows.map(runOf));
  }

  /**
   * Whether a run's terminal agrees with the history the store holds.
   *
   * The range, the turn index, the run's own terminal and the session's
   * high-water all became true in one commit, so agreeing with one another is
   * the only proof that this run's history is its own. The rules are the ones
   * the store's own writes imply: a run that never committed a turn — a host
   * failure, an interrupted run, one still unfinished — carries no range, and a
   * run whose status claims a settled turn, `completed` above all, must carry
   * the range, the turn row and the reason that claim implies. A status that
   * names a committed turn and holds no range is a record disagreeing with
   * itself, and is refused exactly like one pointing at somebody else's turn.
   *
   * Two further facts, because "this turn is mine" is not implied by the turn
   * merely existing:
   *
   * - The turn is this run's own, and the turn's own row says so. Every
   *   terminal commit writes the run's range, its turn and the turn's owner
   *   binding in one transaction, so the two sides are one relation recorded
   *   twice — and the turn's side is the one a swap cannot keep coherent. A
   *   run whose claimed turn is owned by another run, a turn two runs both
   *   claim, and a turn with no owner at all (a store written before the
   *   binding existed) are each a state this store cannot have produced, and
   *   none of them is served from here.
   * - The range holds the canonical facts it claims — the same sequence, turn
   *   closure and tool-pairing rules a history page and an execution window
   *   apply, applied here to the run's own committed range instead of to a cut
   *   out of it — and its first user fact is the input this run accepted,
   *   compared as decoded text, verbatim. That is what makes one authority:
   *   whichever way a client asks about a settled run, the same records are
   *   held to the same rules.
   */
  verifyRunHistory(run: RunRecord): boolean {
    this.assertTrusted();
    const stored = this.database
      .prepare("SELECT committed_from_seq, committed_to_seq FROM runs WHERE run_id = ?")
      .get(run.runId) as
      | { readonly committed_from_seq?: number | null; readonly committed_to_seq?: number | null }
      | undefined;
    if (stored === undefined) return false;

    const from = typeof stored["committed_from_seq"] === "number" ? stored["committed_from_seq"] : null;
    const to = typeof stored["committed_to_seq"] === "number" ? stored["committed_to_seq"] : null;

    if (from === null || to === null) {
      if (from !== null || to !== null) return false;
      return (
        run.status === "accepted" ||
        run.status === "running" ||
        run.status === "failed" ||
        run.status === "interrupted"
      );
    }

    if (run.turnId === null) return false;
    const expected = endReasonFor(run.status);
    if (expected === undefined || run.endReason !== expected) return false;
    if (to <= from) return false;

    const turn = this.turnOwnerRow(run.sessionId, run.turnId);
    if (turn === undefined) return false;
    if (turn.startSeq !== from || turn.endSeq !== to || turn.reason !== expected) return false;
    // The independent half of the proof: the turn's own row names the run
    // that committed it. Without this line a pair of exchanged pointers is
    // self-consistent on both sides and unprovable from either.
    if (turn.runId !== run.runId) return false;

    // History is never shortened, so the committed log this turn belongs to has
    // to reach at least its end; a session that does not hold the turn is a run
    // whose history is somewhere else.
    const session = this.getSession(run.sessionId);
    if (session === undefined || session.committedSeq < to) return false;

    const claimants = this.database
      .prepare("SELECT COUNT(*) AS count FROM runs WHERE session_id = ? AND turn_id = ?")
      .get(run.sessionId, run.turnId) as { readonly count?: number } | undefined;
    if (claimants?.count !== 1) return false;

    // The canonical turn's first user fact is the input this run accepted,
    // compared as the decoded text it was recorded as — never trimmed, never
    // normalized, never re-serialized. A record whose user text is not the
    // text its run accepted is a fact this host did not write.
    if (this.userFactTextAt(run.sessionId, from + 1) !== run.text) return false;

    try {
      const rows = this.database
        .prepare("SELECT * FROM session_events WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq")
        .all(run.sessionId, from, to) as Row[];
      assertStoredRange(rows.map(storedOf), { partialPrefix: false, baseSeq: from });
    } catch {
      return false;
    }
    return true;
  }

  /**
   * One turn, held to the ownership proof from the turn's own side.
   *
   * The lookup and the proof are one step so that no caller can hold a turn
   * row it has not proven: the row is read by its own key, and the proof is
   * `turnOwnershipHolds` — the same rule the execution window applies before
   * a turn can be handed to a model, now also the rule a history page applies
   * before a fragment of that turn can be published.
   */
  verifyTurnOwnership(sessionId: string, turnId: string): boolean {
    return this.ownedTurnRange(sessionId, turnId) !== undefined;
  }

  /**
   * The same one lookup, in the form a caller needs when the answer is not
   * merely yes but *where*: the exact half-open range the turn index row holds,
   * returned only once `turnOwnershipHolds` has proven the turn it belongs to.
   *
   * A caller that binds facts to positions — a history page binding each record
   * to the turn its own id names — gets the range and the proof as one value,
   * so it can never measure a record against a range from a turn this store
   * cannot vouch for. `undefined` is the same refusal `verifyTurnOwnership`
   * answers `false` for: no index row, no owner binding, a legacy NULL owner,
   * an owner that names another turn, session, range or reason, or a canonical
   * first user fact that is not the accepted input.
   */
  ownedTurnRange(sessionId: string, turnId: string): TurnOwnerRange | undefined {
    this.assertTrusted();
    const turn = this.turnOwnerRow(sessionId, turnId);
    if (turn === undefined || !this.turnOwnershipHolds(sessionId, turn)) return undefined;
    return { startSeq: turn.startSeq, endSeq: turn.endSeq };
  }

  /**
   * The same range, asked under both proofs a committed turn carries — the
   * turn-side binding and the run read's whole committed range — so a page can
   * never be the one reader a forged pair of index rows, or an owner run that
   * never committed anything, still satisfies.
   *
   * `verifyRunHistory` alone is not enough here: for a run that never
   * committed a turn it deliberately answers `true` — a read has nothing to
   * check on such a run — and a page must not accept that vacuous proof for a
   * turn it is about to publish. The turn-side binding rules that branch out
   * (the owner's own row must hold this exact committed range), and the run
   * read then holds that range to the canonical facts it claims. The proof is
   * bounded by the turn itself: one turn row, one run record and one range
   * read, never the session's history.
   */
  publishableTurnRange(sessionId: string, turnId: string): TurnOwnerRange | undefined {
    this.assertTrusted();
    const turn = this.turnOwnerRow(sessionId, turnId);
    if (turn === undefined || turn.runId === null) return undefined;
    if (!this.turnOwnershipHolds(sessionId, turn)) return undefined;
    const run = this.getRun(turn.runId);
    if (run === undefined || run.sessionId !== sessionId || run.turnId !== turn.turnId) return undefined;
    if (!this.verifyRunHistory(run)) return undefined;
    return { startSeq: turn.startSeq, endSeq: turn.endSeq };
  }

  /**
   * One turn index row's own ownership claim, as it is stored.
   *
   * `runId` is `null` exactly when the row predates the ownership binding —
   * a claim that no run can be held to, which is refused wherever a claim is
   * required rather than repaired into one.
   */
  private turnOwnerRow(sessionId: string, turnId: string): TurnOwnerRow | undefined {
    const row = this.database
      .prepare("SELECT turn_id, start_seq, end_seq, reason, run_id FROM turns WHERE session_id = ? AND turn_id = ?")
      .get(sessionId, turnId) as Row | undefined;
    return row === undefined ? undefined : this.ownerRowOf(row);
  }

  /** The one place a turn index row becomes the ownership row the checks work on. */
  private ownerRowOf(row: Row): TurnOwnerRow {
    const startSeq = row["start_seq"];
    const endSeq = row["end_seq"];
    const reason = row["reason"];
    if (typeof startSeq !== "number" || typeof endSeq !== "number" || typeof reason !== "string") {
      throw new CorruptRecordError("the turn index holds a range that is not a range");
    }
    return Object.freeze({
      turnId: String(row["turn_id"]),
      startSeq,
      endSeq,
      reason,
      runId: typeof row["run_id"] === "string" ? row["run_id"] : null,
    });
  }

  /**
   * The decoded text of the user fact committed at one position, or
   * `undefined` when the record there is not one.
   *
   * The one reader both bindings use — the run-side read checks a run's own
   * range, the window-side read checks a turn the model is about to be handed
   * — so "the first user fact is the accepted input" is one rule applied in
   * one place, and a record that cannot be parsed is a refusal rather than a
   * substituted value.
   */
  private userFactTextAt(sessionId: string, seq: number): string | undefined {
    const row = this.database
      .prepare("SELECT seq, turn_id, type, time, data FROM session_events WHERE session_id = ? AND seq = ?")
      .get(sessionId, seq) as Row | undefined;
    if (row === undefined) return undefined;
    const record = storedOf(row);
    if (record.type !== "message/user") return undefined;
    try {
      return parseStoredRecord(record)["text"] as string;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether one turn index row's owner binding holds, checked from the turn's
   * side against the run's own row.
   *
   * This is the direction an execution window needs: the turn names a run, and
   * that run — read from its own row, not from the pointer under test — must
   * name this turn, this session, this exact half-open range and this reason,
   * in the terminal status the reason implies. It also holds the turn's first
   * user fact to the accepted input the owner run recorded. A turn with no
   * owner, an owner that claims something else, and an owner whose accepted
   * input is not the canonical fact are all the same answer here: the turn is
   * not one this host can vouch for.
   */
  private turnOwnershipHolds(sessionId: string, turn: TurnOwnerRow): boolean {
    if (turn.runId === null) return false;
    const row = this.database
      .prepare(
        "SELECT session_id, turn_id, status, end_reason, committed_from_seq, committed_to_seq, text FROM runs WHERE run_id = ?",
      )
      .get(turn.runId) as Row | undefined;
    if (row === undefined) return false;
    if (String(row["session_id"]) !== sessionId) return false;
    if (row["turn_id"] !== turn.turnId) return false;
    if (row["committed_from_seq"] !== turn.startSeq || row["committed_to_seq"] !== turn.endSeq) return false;
    if (row["end_reason"] !== turn.reason) return false;
    if (endReasonFor(String(row["status"]) as RunStatus) !== turn.reason) return false;
    return this.userFactTextAt(sessionId, turn.startSeq + 1) === String(row["text"]);
  }

  verifyTurnCommit(input: CommitTurnInput): "committed" | "absent" | "indeterminate" {
    this.assertTrusted();
    try {
      const endSeq = input.turnStartSeq + input.records.length;
      const session = this.getSession(input.sessionId);
      if (session === undefined) return "indeterminate";
      const run = this.getRun(input.runId);
      if (run === undefined) return "indeterminate";

      const turn = this.turnOwnerRow(input.sessionId, input.turnId);
      const events = this.database
        .prepare("SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND seq >= ? AND seq < ?")
        .get(input.sessionId, input.turnStartSeq, endSeq) as { readonly count?: number } | undefined;
      const terminal = run.status !== "accepted" && run.status !== "running";

      const fullyThere =
        session.committedSeq === endSeq &&
        turn !== undefined &&
        turn.startSeq === input.turnStartSeq &&
        turn.endSeq === endSeq &&
        turn.reason === input.reason &&
        turn.runId === input.runId &&
        // The one ownership authority, applied here as everywhere else: the
        // owner run's own row must name this turn, this session, this exact
        // half-open range, this reason and this accepted input. Confirming a
        // lost commit receipt is deciding whether to publish a terminal, so
        // "the pointers look consistent" is not enough — a batch whose range
        // evidence disagrees with its own turn index is not the batch this
        // store committed, and the honest answer is that the store cannot say.
        this.turnOwnershipHolds(input.sessionId, turn) &&
        events?.count === input.records.length &&
        terminal &&
        run.turnId === input.turnId &&
        // ...and the read's own authority is the last word here too, so the
        // confirmation can never be weaker than `runs.get`: the exact committed
        // range held to every rule the run read applies — record identities,
        // payloads and structure, not a count of them. A batch whose records
        // were rewritten inside their own range is a store this host cannot
        // vouch for, and a lost receipt is not a licence to publish a terminal
        // anyway.
        this.verifyRunHistory(run);
      if (fullyThere) return "committed";

      const untouched = session.committedSeq === input.turnStartSeq && turn === undefined;
      if (untouched) return "absent";
      return "indeterminate";
    } catch {
      return "indeterminate";
    }
  }

  readHistory(sessionId: string, beforeSeq: number, maxEvents: number): HistoryRead {
    this.assertTrusted();
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

  /**
   * The newest whole turns whose *actual* representation fits the budget.
   *
   * The budget is spent on the representation itself, never on an estimate of
   * it: each turn is read on its own, rebuilt as the very events the window
   * hands to the Core, and encoded the way any structure is measured here —
   * sequence, time, turn id, event kind, payload, JSON escaping and the
   * array/object framing all included. The running total is that number.
   *
   * One turn at a time also keeps the read bounded: nothing is loaded to be
   * judged and then not used, a turn that does not fit ends the window there —
   * the newest one included — and no older turn is skipped in the hope that it
   * fits where the newer one did not.
   *
   * Ownership is checked before a turn can be handed to anything. The window
   * is the history a model will see, and E2's rule for it is the same rule the
   * published terminal obeys: history whose owning run cannot be proven is not
   * history this host may use. The check is per turn and bounded by the same
   * limit that bounds the read, and it is deliberately *not* a scan of the
   * whole log — only the suffix that could become a window is held to it.
   */
  readTurnWindow(sessionId: string, maxTurns: number, maxBytes: number): TurnWindowRead {
    this.assertTrusted();
    const session = this.getSession(sessionId);
    const nextSeq = session?.committedSeq ?? 0;
    const turns = this.database
      .prepare(
        "SELECT turn_id, start_seq, end_seq, reason, run_id FROM turns WHERE session_id = ? ORDER BY start_seq DESC LIMIT ?",
      )
      .all(sessionId, maxTurns) as Row[];

    const taken: StoredRecord[] = [];
    let baseSeq = nextSeq;
    for (const row of turns) {
      const turn = this.ownerRowOf(row);
      // The history a model is handed must be the history this session's own
      // runs committed: every turn the window considers carries its owner
      // binding and its accepted input, checked from the run's own row before
      // any of it can become a window. An unprovable turn is refused here
      // exactly like an unreadable one — the run faults and the session stops
      // rather than the model being fed history nobody can vouch for.
      if (!this.turnOwnershipHolds(sessionId, turn)) {
        throw new CorruptRecordError(`turn "${turn.turnId}" is not owned by the run its index names`);
      }

      const rows = this.database
        .prepare("SELECT * FROM session_events WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq")
        .all(sessionId, turn.startSeq, turn.endSeq) as Row[];
      const candidate = [...rows.map(storedOf), ...taken];
      const events = candidate.map(toSessionEvent);
      if (encodedBytes(events) > maxBytes) break;

      taken.splice(0, taken.length, ...candidate);
      baseSeq = turn.startSeq;
    }

    return { records: Object.freeze(taken), baseSeq, nextSeq };
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
            `UPDATE sessions SET active_run_id = ?, metadata_revision = metadata_revision + 1,
               updated_at = MAX(updated_at, ?)
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
            `UPDATE runs SET status = 'running', started_at = MAX(accepted_at, ?), host_instance_id = ?
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
          .prepare(
            "INSERT INTO turns (session_id, turn_id, start_seq, end_seq, reason, run_id) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(input.sessionId, input.turnId, input.turnStartSeq, seq, input.reason, input.runId);
        this.database
          .prepare(
            `UPDATE sessions SET
               committed_seq = ?, history_revision = history_revision + 1,
               metadata_revision = metadata_revision + 1, updated_at = MAX(updated_at, ?), active_run_id = NULL
             WHERE session_id = ?`,
          )
          .run(seq, input.endedAt, input.sessionId);
        this.database
          .prepare(
            `UPDATE runs SET
               status = ?, end_reason = ?, ended_at = MAX(COALESCE(started_at, accepted_at), ?), turn_id = ?,
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
            `UPDATE runs SET status = 'failed', end_reason = 'host_error', error_code = ?,
               ended_at = MAX(COALESCE(started_at, accepted_at), ?), turn_id = ?
             WHERE run_id = ?`,
          )
          .run(input.errorCode, input.endedAt, input.turnId, input.runId);
        this.database
          .prepare(
            `UPDATE sessions SET
               status = 'blocked', blocked_reason = ?, metadata_revision = metadata_revision + 1,
               updated_at = MAX(updated_at, ?), active_run_id = NULL
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

  /**
   * Blocks a session whose committed facts cannot be read as what they claim.
   *
   * It is written like any other session change: one transaction, a metadata
   * revision, and a durable answer. A session that is already blocked, or gone,
   * is left exactly as it is — blocking is not a repair, and there is nothing
   * here that could undo one.
   */
  blockCorruptSession(sessionId: string, at: number): SessionRecord | undefined {
    const current = this.getSession(sessionId);
    if (current === undefined || current.status === "blocked") return current;

    return this.write<SessionRecord | undefined>(
      () => {
        this.database
          .prepare(
            `UPDATE sessions SET
               status = 'blocked', blocked_reason = 'host-fault',
               metadata_revision = metadata_revision + 1, updated_at = MAX(updated_at, ?)
             WHERE session_id = ?`,
          )
          .run(at, sessionId);
        this.bump("sessions");
        return this.getSession(sessionId);
      },
      () => {
        const session = this.getSession(sessionId);
        if (session !== undefined && session.status === "blocked") {
          return { kind: "committed" as const, value: session };
        }
        return session === undefined
          ? { kind: "indeterminate" as const }
          : { kind: "absent" as const };
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
            `UPDATE sessions SET title = ?, metadata_revision = metadata_revision + 1, updated_at = MAX(updated_at, ?)
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
                 metadata_revision = metadata_revision + 1, updated_at = MAX(updated_at, ?)
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
    const identityBytes = Buffer.byteLength(record.turnId, "utf8");
    if (identityBytes > MAX_TURN_ID_BYTES || !recordFits(record.data, record.turnId, this.limits.maxRecordBytes)) {
      const size = Buffer.byteLength(record.data, "utf8") + identityBytes + RECORD_OVERHEAD_BYTES;
      throw new RecordTooLargeError(`a ${record.type} record is ${size} bytes`);
    }
  }
}

/** The turn-end reason a status that claims a settled turn must have been written with. */
function endReasonFor(status: RunStatus): EndReason | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "limited":
      return "max_steps";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "error";
    default:
      return undefined;
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
