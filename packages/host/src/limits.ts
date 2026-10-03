/**
 * The host's published safety limits.
 *
 * They live in one place because they are one set of facts: the numbers
 * `host.describe` publishes are the numbers this host actually enforces, and a
 * limit that is only written down where it is advertised is a limit nobody
 * checks. Every one of them bounds a single read, a single write or a single
 * frame — none of them caps how much history may accumulate, and there is
 * deliberately no such cap here to reach for.
 */

import type { HostLimits } from "@every-dagent/protocol";
import { MAX_FRAME_BYTES, MAX_PAGE_BYTES, MAX_PAGE_ITEMS, MAX_TITLE_CHARS } from "@every-dagent/protocol";

export const HOST_LIMITS: HostLimits = Object.freeze({
  /** One run at a time, including a run still waiting to settle. */
  maxActiveRuns: 1,
  /** Raw UTF-8 bytes one accepted input may occupy. */
  maxInputBytes: 16 * 1024,
  /** Encoded bytes one durable record may occupy, envelope included. */
  maxRecordBytes: 64 * 1024,
  maxPageItems: MAX_PAGE_ITEMS,
  maxPageBytes: MAX_PAGE_BYTES,
  maxFrameBytes: MAX_FRAME_BYTES,
  maxOutboxBytes: 1024 * 1024,
  maxTitleChars: MAX_TITLE_CHARS,
});

/** How many frames one connection may queue before the host gives up on it. */
export const OUTBOX_LIMIT_FRAMES = 256;

// ---------------------------------------------------------------------------
// The M4 execution profile.
//
// These numbers shape how this host runs approvals; they are *not* protocol
// laws and not settings. A different host may choose different ones, and none
// of them is published as a wire limit: what a client sees is the deadline of
// the approval it was actually asked about.
// ---------------------------------------------------------------------------

/** The absolute business deadline of one approval, in milliseconds. Not configurable in M4. */
export const APPROVAL_DEADLINE_MS = 120_000;

/** The most one approval's exact input may occupy, in UTF-8 bytes of neutral JSON. */
export const APPROVAL_INPUT_MAX_BYTES = 24 * 1024;

/** The most one encoded approval snapshot may occupy. */
export const APPROVAL_SNAPSHOT_MAX_BYTES = 32 * 1024;

/** How many connections one approval may be outstanding on at once. */
export const APPROVAL_MAX_DELIVERIES = 8;

/** How many business approvals this host holds at once. One execution, one approval. */
export const APPROVAL_MAX_PENDING = 1;

/**
 * How long an execution waits for this host's own projection to bind it to a
 * live occurrence.
 *
 * The wait exists because the producer (the Core) can reach the execution
 * boundary before the consumer (this host's run projection) has seen the
 * `tool/call` event — and an approval must never be published before the call
 * it belongs to can be placed. The wait is a hand-off between two parts of one
 * host, not a deadline: it is woken immediately by cancellation, shutdown, a
 * storage fault or the run settling, and it fails closed (no dispatch) if it
 * ever does run out.
 */
export const PROJECTION_RENDEZVOUS_MS = 5_000;
