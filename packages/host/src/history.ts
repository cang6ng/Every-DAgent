/**
 * Pages: bounded reads of durable collections, and the cursors that continue them.
 *
 * The shape is the same for all three collections — history, the session
 * directory, a session's runs — and so are the two ideas behind it.
 *
 * A page is a *window*, never a whole. Every read here takes a bound and stops
 * at it; nothing in this module has a code path that loads a collection to
 * answer a question about part of it. That is what makes "this host never reads
 * your whole history" a property of the implementation rather than a promise.
 *
 * A cursor is a *claim about a cut*, and it is validated before it is believed.
 * It carries the storage, the session and generation it was issued for, so a
 * cursor cannot be pointed at another session or another store; a history
 * cursor carries the fence it was issued against, so turns appended afterwards
 * extend the session without invalidating it; and a directory or run cursor
 * carries the collection revision it was read under, so a cursor from before a
 * rename or a deletion is refused instead of being stitched onto newer facts. A
 * cursor that is malformed, or that no longer describes this store, is an
 * error — never a guess.
 */

import type {
  CanonicalItem,
  HistoryPage,
  RunSummary,
  RunSummaryPage,
  SessionSummary,
  SessionSummaryPage,
} from "@every-dagent/protocol";
import { MAX_PAGE_BYTES, MAX_PAGE_ITEMS, MAX_TITLE_CHARS } from "@every-dagent/protocol";

import { projectionError, storedItem, type OpenCall } from "./projection.js";
import {
  assertStoredRange,
  CorruptRecordError,
  encodedBytes,
  invocationOf,
  parseStoredRecord,
  type Repository,
  type RunCursorKey,
  type RunRecord,
  type SessionCursorKey,
  type SessionRecord,
  type StoredRecord,
} from "./repository.js";

/** Whether a listed run's committed range is the turn the store's index holds. */
function servesRunRecord(repository: Repository, record: RunRecord): boolean {
  if (record.status === "accepted" || record.status === "running") return true;
  try {
    return repository.verifyRunHistory(record);
  } catch {
    return false;
  }
}

/**
 * How much of one page may be occupied by its items, leaving room for the
 * envelope. Both page kinds — history and runs — stop at whichever of their
 * item and byte bounds is reached first.
 */
const PAGE_ITEM_BUDGET_BYTES = MAX_PAGE_BYTES - 4096;

/** The default page size when a caller does not ask for one. */
export const DEFAULT_PAGE_ITEMS = 20;

/** The first title a session gets. Deterministic, never a model call. */
export function defaultTitle(sessionId: string, at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  // Bounded by construction, and shortened from the id so the title stays
  // legible while remaining unique per session.
  return fitTitle(`会话 ${shortId(sessionId)} · ${stamp}`);
}

/** Keeps a title inside the contract's bound without ever producing an empty one. */
export function fitTitle(title: string): string {
  if (title.length <= MAX_TITLE_CHARS) return title;
  return title.slice(0, MAX_TITLE_CHARS);
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Cursors.
// ---------------------------------------------------------------------------

/** Why a cursor could not be used. Both cases are errors; neither is a fresh start. */
export type CursorFailure = "malformed" | "stale";

interface CursorBase {
  readonly v: 1;
  readonly storageId: string;
}

interface HistoryCursor extends CursorBase {
  readonly kind: "history";
  readonly sessionId: string;
  readonly generation: number;
  readonly historyRevision: number;
  readonly fenceSeq: number;
  readonly beforeSeq: number;
}

interface SessionsCursor extends CursorBase {
  readonly kind: "sessions";
  readonly collectionRevision: number;
  readonly updatedAt: number;
  readonly sessionId: string;
}

interface RunsCursor extends CursorBase {
  readonly kind: "runs";
  readonly collectionRevision: number;
  readonly sessionId: string;
  readonly acceptedAt: number;
  readonly runId: string;
}

export function encodeCursor(cursor: HistoryCursor | SessionsCursor | RunsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): unknown {
  try {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Reads a history cursor.
 *
 * The fence is the part that makes appends harmless: a cursor keeps reading the
 * history that existed when it was issued, so a turn committed afterwards is
 * simply outside this traversal. The generation is the part that makes a
 * deletion final: a cursor issued for a session that has since been removed is
 * answered SESSION_NOT_FOUND, never redrawn onto a new one.
 */
export function decodeHistoryCursor(
  raw: string,
  storageId: string,
): { readonly cursor: HistoryCursor } | { readonly failure: CursorFailure } {
  const parsed = decodeCursor(raw);
  if (!isRecord(parsed) || parsed["v"] !== 1 || parsed["kind"] !== "history") return { failure: "malformed" };
  if (typeof parsed["storageId"] !== "string" || parsed["storageId"] !== storageId) return { failure: "malformed" };
  const generation = finite(parsed["generation"]);
  const historyRevision = finite(parsed["historyRevision"]);
  const fenceSeq = finite(parsed["fenceSeq"]);
  const beforeSeq = finite(parsed["beforeSeq"]);
  const sessionId = parsed["sessionId"];
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    generation === undefined ||
    historyRevision === undefined ||
    fenceSeq === undefined ||
    beforeSeq === undefined ||
    beforeSeq > fenceSeq
  ) {
    return { failure: "malformed" };
  }
  return { cursor: { v: 1, kind: "history", storageId, sessionId, generation, historyRevision, fenceSeq, beforeSeq } };
}

export function decodeSessionsCursor(
  raw: string,
  storageId: string,
): { readonly cursor: SessionsCursor } | { readonly failure: CursorFailure } {
  const parsed = decodeCursor(raw);
  if (!isRecord(parsed) || parsed["v"] !== 1 || parsed["kind"] !== "sessions") return { failure: "malformed" };
  if (typeof parsed["storageId"] !== "string" || parsed["storageId"] !== storageId) return { failure: "malformed" };
  const collectionRevision = finite(parsed["collectionRevision"]);
  const updatedAt = finite(parsed["updatedAt"]);
  const sessionId = parsed["sessionId"];
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    collectionRevision === undefined ||
    updatedAt === undefined
  ) {
    return { failure: "malformed" };
  }
  return { cursor: { v: 1, kind: "sessions", storageId, collectionRevision, updatedAt, sessionId } };
}

export function decodeRunsCursor(
  raw: string,
  storageId: string,
): { readonly cursor: RunsCursor } | { readonly failure: CursorFailure } {
  const parsed = decodeCursor(raw);
  if (!isRecord(parsed) || parsed["v"] !== 1 || parsed["kind"] !== "runs") return { failure: "malformed" };
  if (typeof parsed["storageId"] !== "string" || parsed["storageId"] !== storageId) return { failure: "malformed" };
  const collectionRevision = finite(parsed["collectionRevision"]);
  const acceptedAt = finite(parsed["acceptedAt"]);
  const sessionId = parsed["sessionId"];
  const runId = parsed["runId"];
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof runId !== "string" ||
    runId.length === 0 ||
    collectionRevision === undefined ||
    acceptedAt === undefined
  ) {
    return { failure: "malformed" };
  }
  return {
    cursor: { v: 1, kind: "runs", storageId, collectionRevision, sessionId, acceptedAt, runId },
  };
}

export function pageLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_PAGE_ITEMS;
  return Math.max(1, Math.min(requested, MAX_PAGE_ITEMS));
}

// ---------------------------------------------------------------------------
// Records to DTOs.
// ---------------------------------------------------------------------------

export function sessionSummaryOf(record: SessionRecord): SessionSummary {
  return Object.freeze({
    sessionId: record.sessionId,
    generation: record.generation,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    blockedReason: record.blockedReason,
    metadataRevision: record.metadataRevision,
    historyRevision: record.historyRevision,
    committedSeq: record.committedSeq,
    activeRunId: record.activeRunId,
  });
}

export function runSummaryOf(record: RunRecord): RunSummary {
  return Object.freeze({
    runId: record.runId,
    submissionId: record.submissionId,
    sessionId: record.sessionId,
    text: record.text,
    turnId: record.turnId,
    cancelRequested: record.cancelRequested,
    acceptedAt: record.acceptedAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    status: record.status,
    endReason: record.endReason,
    error: null,
    executionKnowledge: record.executionKnowledge,
  });
}

// ---------------------------------------------------------------------------
// Page readers.
// ---------------------------------------------------------------------------

export function readSessionPage(
  repository: Repository,
  rawCursor: string | undefined,
  requested: number | undefined,
): { readonly page: SessionSummaryPage } | { readonly failure: CursorFailure } {
  const limit = pageLimit(requested);
  let after: SessionCursorKey | null = null;

  if (rawCursor !== undefined) {
    const decoded = decodeSessionsCursor(rawCursor, repository.storageId);
    if ("failure" in decoded) return { failure: decoded.failure };
    if (decoded.cursor.collectionRevision !== repository.revisions.sessions) {
      // The directory changed since this cursor was issued. Continuing would
      // hand the caller a page from one version of the catalogue glued to
      // another, which is precisely what the revision exists to prevent.
      return { failure: "stale" };
    }
    after = { updatedAt: decoded.cursor.updatedAt, sessionId: decoded.cursor.sessionId };
  }

  const result = repository.listSessions(limit, after);
  const revision = repository.revisions.sessions;
  const last = result.records[result.records.length - 1];
  const nextCursor =
    result.hasMore && last !== undefined
      ? encodeCursor({
          v: 1,
          kind: "sessions",
          storageId: repository.storageId,
          collectionRevision: revision,
          updatedAt: last.updatedAt,
          sessionId: last.sessionId,
        })
      : null;

  return {
    page: Object.freeze({
      items: Object.freeze(result.records.map(sessionSummaryOf)),
      collectionRevision: revision,
      nextCursor,
      hasMore: result.hasMore,
    }),
  };
}

export function readRunPage(
  repository: Repository,
  sessionId: string,
  rawCursor: string | undefined,
  requested: number | undefined,
): { readonly page: RunSummaryPage } | { readonly failure: CursorFailure } {
  const limit = pageLimit(requested);
  let after: RunCursorKey | null = null;

  if (rawCursor !== undefined) {
    const decoded = decodeRunsCursor(rawCursor, repository.storageId);
    if ("failure" in decoded) return { failure: decoded.failure };
    if (decoded.cursor.collectionRevision !== repository.revisions.runs) return { failure: "stale" };
    if (decoded.cursor.sessionId !== sessionId) return { failure: "stale" };
    after = { acceptedAt: decoded.cursor.acceptedAt, runId: decoded.cursor.runId };
  }

  const result = repository.listRunsBySession(sessionId, limit, after);

  // Every terminal run that would be listed has to agree with the history it
  // claims: its recorded range is checked against the turn index before any of
  // it is served. A page holding a run whose history is not its own is refused
  // as a whole — a listing that silently dropped the entry would be a different
  // lie than the one it avoided.
  for (const record of result.records) {
    if (!servesRunRecord(repository, record)) {
      throw new CorruptRecordError(`a run in the list claims history that is not its own`);
    }
  }

  // A run summary carries the accepted input, which is the largest thing a run
  // ever holds, so the count bound alone does not bound the page. Items are
  // measured as they will be encoded and the page ends at whichever bound it
  // reaches first — and the cursor names the last item actually returned, so the
  // next page starts exactly where this one stopped.
  const items: RunSummary[] = [];
  let bytes = 0;
  for (const record of result.records) {
    const summary = runSummaryOf(record);
    const cost = encodedBytes(summary) + 64;
    if (items.length > 0 && bytes + cost > PAGE_ITEM_BUDGET_BYTES) break;
    bytes += cost;
    items.push(summary);
  }

  const revision = repository.revisions.runs;
  const last = items[items.length - 1];
  const hasMore = result.hasMore || items.length < result.records.length;
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor({
          v: 1,
          kind: "runs",
          storageId: repository.storageId,
          collectionRevision: revision,
          sessionId,
          acceptedAt: last.acceptedAt,
          runId: last.runId,
        })
      : null;

  return {
    page: Object.freeze({
      items: Object.freeze(items),
      collectionRevision: revision,
      nextCursor,
      hasMore,
    }),
  };
}

export interface HistoryPageResult {
  readonly page: HistoryPage;
  readonly nextCursor: string | null;
}

export type HistoryPageOutcome =
  | { readonly kind: "page"; readonly result: HistoryPageResult }
  | { readonly kind: "session-not-found"; readonly deleted: boolean }
  | { readonly kind: "failure"; readonly failure: CursorFailure };

/**
 * Reads one bounded page of committed history against a fixed fence.
 *
 * The read is bounded twice over: at most `limit + 2` records are fetched, and
 * the page is then trimmed from its oldest end until its items fit both the
 * item count and the byte budget. Trimming, rather than re-reading, is what
 * keeps this one round trip — and the trim lands on an event boundary, so the
 * pages of a traversal partition the fenced range without a gap or an overlap.
 *
 * A page is cut where it has to be, which may be inside a turn: a turn whose
 * items do not fit one page is split, and the boundary flags on the page say so
 * rather than letting a fragment be read as a finished turn.
 */
export function readHistoryPage(
  repository: Repository,
  sessionId: string,
  rawCursor: string | undefined,
  requested: number | undefined,
): HistoryPageOutcome {
  const session = repository.getSession(sessionId);
  if (session === undefined) {
    return { kind: "session-not-found", deleted: repository.getDeletedSession(sessionId) !== undefined };
  }

  let fenceSeq = session.committedSeq;
  let historyRevision = session.historyRevision;
  let beforeSeq = session.committedSeq;
  let generation = session.generation;

  if (rawCursor !== undefined) {
    const decoded = decodeHistoryCursor(rawCursor, repository.storageId);
    if ("failure" in decoded) return { kind: "failure", failure: decoded.failure };
    if (decoded.cursor.sessionId !== sessionId || decoded.cursor.generation !== session.generation) {
      // A cursor for another session, or for an identity that no longer
      // exists, is not a position in this one.
      return { kind: "session-not-found", deleted: false };
    }
    if (decoded.cursor.fenceSeq > session.committedSeq || decoded.cursor.beforeSeq > decoded.cursor.fenceSeq) {
      // Committed history is never shortened, so a cursor beyond the high-water
      // was not issued by this store.
      return { kind: "failure", failure: "malformed" };
    }
    fenceSeq = decoded.cursor.fenceSeq;
    historyRevision = decoded.cursor.historyRevision;
    beforeSeq = decoded.cursor.beforeSeq;
    generation = decoded.cursor.generation;
  }

  const limit = pageLimit(requested);
  const read = repository.readHistory(sessionId, beforeSeq, limit + 2);
  const kept = trimToBudget(sessionId, read.records, limit);

  // Everything the page will serve is checked as durable fact first: strict
  // payloads, unbroken positions, a turn's events all carrying its own id, and
  // tool occurrences that pair. A fragment is allowed to *begin* mid-turn — a
  // page is explicitly a window — but nothing inside it is repaired into place.
  // A page that cannot be served honestly is refused, not served approximately.
  assertStoredRange(kept.records, { partialPrefix: true, baseSeq: kept.fromSeq });

  const items: CanonicalItem[] = [];
  let openCall: OpenCall | undefined;
  for (const record of kept.records) {
    if (record.type === "tool/call") {
      const parsed = parseStoredRecord(record);
      openCall = {
        invocationId: invocationOf(sessionId, record.seq),
        callId: parsed["callId"] as string,
        name: parsed["name"] as string,
      };
    }
    const item = storedItem(record, sessionId, openCall);
    if (record.type === "tool/result" && item === undefined) {
      throw projectionError("a stored tool result has no call to belong to");
    }
    if (item !== undefined) items.push(item);
  }

  const fromSeq = kept.fromSeq;
  const first = kept.records[0];
  const last = kept.records[kept.records.length - 1];
  const atStart = fromSeq === 0;
  const nextCursor = atStart
    ? null
    : encodeCursor({
        v: 1,
        kind: "history",
        storageId: repository.storageId,
        sessionId,
        generation,
        historyRevision,
        fenceSeq,
        beforeSeq: fromSeq,
      });

  return {
    kind: "page",
    result: {
      page: Object.freeze({
        storageId: repository.storageId,
        sessionId,
        generation,
        historyRevision,
        fenceSeq,
        direction: "backward" as const,
        items: Object.freeze(items),
        coverage: Object.freeze({ fromSeq, toSeq: kept.toSeq }),
        startsAtTurnBoundary: first === undefined || first.type === "turn/start",
        endsAtTurnBoundary: last === undefined || last.type === "turn/end",
        atStart,
        atFence: kept.toSeq === fenceSeq,
        nextCursor,
      }),
      nextCursor,
    },
  };
}

interface TrimmedRange {
  readonly records: readonly StoredRecord[];
  readonly fromSeq: number;
  readonly toSeq: number;
}

/**
 * The newest suffix of `records` whose items fit the page budget.
 *
 * The cut is chosen from the newest end backwards, so a page always carries the
 * most recent facts it can. One adjustment keeps the page honest at its own
 * edge: a tool result is never left without its call, because half of an
 * occurrence reads as a different occurrence. When the call is inside the same
 * read — it is the record immediately before the result — the page carries the
 * occurrence whole, which may be one item more than the caller asked for and is
 * the only way a `limit` smaller than an occurrence can serve one at all; the
 * protocol's own ceilings are still respected, and a call and its result always
 * fit one page together. When the call is outside the read, the fragment is
 * dropped and the next page picks it up — the cursor then points below it —
 * which keeps the traversal contiguous.
 */
function trimToBudget(sessionId: string, records: readonly StoredRecord[], limit: number): TrimmedRange {
  const newest = records[records.length - 1];
  if (newest === undefined) return { records: [], fromSeq: 0, toSeq: 0 };
  const toSeq = newest.seq + 1;

  const total = countItems(records);
  let kept = records.length;
  let itemCount = total.items;
  let bytes = total.bytes;

  while (kept > 1 && (itemCount > limit || bytes > PAGE_ITEM_BUDGET_BYTES)) {
    kept -= 1;
    const removed = records[records.length - kept - 1];
    if (removed === undefined) break;
    const weight = itemWeight(removed);
    itemCount -= weight.items;
    bytes -= weight.bytes;
  }

  while (kept > 0 && records[records.length - kept]?.type === "tool/result") {
    const call = records[records.length - kept - 1];
    if (call !== undefined && call.type === "tool/call") {
      const weight = itemWeight(call);
      if (itemCount + weight.items <= MAX_PAGE_ITEMS && bytes + weight.bytes <= PAGE_ITEM_BUDGET_BYTES) {
        kept += 1;
        break;
      }
    }
    kept -= 1;
  }
  if (kept === 0) {
    // Every record the read returned was an orphaned result, which a log this
    // store wrote cannot contain; refusing beats inventing a page.
    throw projectionError("the history window held no complete occurrence");
  }

  const slice = records.slice(records.length - kept);
  const first = slice[0];
  if (first === undefined) throw projectionError("the history window is empty");
  return { records: slice, fromSeq: first.seq, toSeq };
}

/** The whole range's item count and encoded size. */
function countItems(records: readonly StoredRecord[]): { items: number; bytes: number } {
  let items = 0;
  let bytes = 0;
  for (const record of records) {
    const weight = itemWeight(record);
    items += weight.items;
    bytes += weight.bytes;
  }
  return { items, bytes };
}

/** One record's contribution to a page's item count and size. */
function itemWeight(record: StoredRecord): { items: number; bytes: number } {
  const items = record.type === "turn/start" || record.type === "turn/end" ? 0 : 1;
  // The record's own encoded size is the honest measure of what it adds to a
  // payload: the page carries a projection of it, and a projection is never
  // larger than its source by more than the fields both already share.
  const bytes = Buffer.byteLength(record.data, "utf8") + 96;
  return { items, bytes };
}
