/**
 * The binding's own numbers.
 *
 * They live apart from either half so the browser-side channel can carry them
 * without importing a `node:http` server — and so they read as what they are:
 * this binding's choices, not protocol constants.
 */

/** The largest protocol frame this binding will carry, in UTF-8 bytes. */
export const FRAME_LIMIT_BYTES = 1024 * 1024;
/** The largest wrapped record, with room for the JSON wrapper's escaping. */
export const RECORD_LIMIT_BYTES = 6 * 1024 * 1024 + 64;

export interface WebLimits {
  /** The largest protocol frame, in UTF-8 bytes. */
  readonly frameBytes: number;
  /** The largest single record, wrapper included. */
  readonly recordBytes: number;
  /** Frames and bytes one direction may hold, in flight included. */
  readonly queueFrames: number;
  readonly queueBytes: number;
  /** Established logical connections. */
  readonly maxConnections: number;
  /** Created but not yet claimed connections. */
  readonly maxPending: number;
  /** Connection creation rate. */
  readonly createPerSecond: number;
  readonly createBurst: number;
  /** How long a created connection may wait to be claimed. */
  readonly pendingTtlMs: number;
  /** How long one upstream request may take, in total. */
  readonly postTimeoutMs: number;
  /** How long establishing a logical connection may take, in total. */
  readonly connectTimeoutMs: number;
  /** How long one SSE record may stay unfinished, however busy the stream looks. */
  readonly recordTimeoutMs: number;
  /** Downstream keep-alive, and how long the client tolerates silence. */
  readonly heartbeatMs: number;
  readonly idleTimeoutMs: number;
  /** How long a stalled write may block the queue before the connection ends. */
  readonly drainTimeoutMs: number;
  readonly headerBytes: number;
  readonly headerTimeoutMs: number;
  readonly maxSockets: number;
}

/**
 * The binding's own numbers.
 *
 * They are fixed here and tested here; they are not protocol constants, and the
 * protocol has no field for them.
 */
export const DEFAULT_WEB_LIMITS: WebLimits = Object.freeze({
  frameBytes: FRAME_LIMIT_BYTES,
  recordBytes: RECORD_LIMIT_BYTES,
  queueFrames: 64,
  queueBytes: 8 * 1024 * 1024,
  maxConnections: 16,
  maxPending: 4,
  createPerSecond: 2,
  createBurst: 4,
  pendingTtlMs: 5000,
  postTimeoutMs: 10000,
  connectTimeoutMs: 10000,
  recordTimeoutMs: 30000,
  heartbeatMs: 15000,
  idleTimeoutMs: 45000,
  drainTimeoutMs: 15000,
  headerBytes: 8 * 1024,
  headerTimeoutMs: 5000,
  maxSockets: 64,
});
