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
