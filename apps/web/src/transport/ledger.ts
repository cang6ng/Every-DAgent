/**
 * What one connection still owes its socket, and who is allowed to say so.
 *
 * Retaining counts a record the socket took and has not flushed; releasing
 * takes it back when the socket drains. Both are owned: a holder presents the
 * generation it was issued under, and retiring the ledger — which is what
 * closing a connection is — moves the generation on and empties it in the same
 * step.
 *
 * The ownership is the whole point. A write or a drain that belongs to a
 * connection that has already closed comes back to a ledger that no longer
 * exists: releasing there would drive the count below zero, and retaining would
 * put work on the books of a connection that is gone. Neither is arithmetic to
 * be clamped afterwards — a late continuation has no ownership, so it is
 * refused, and the ledger of a closed connection stays `(0, 0)` for good.
 */

export interface Ledger {
  /** Records the socket has taken and not flushed. */
  readonly frames: number;
  /** The encoded bytes of those records. */
  readonly bytes: number;
  /** Whether the ledger has been retired: it is empty and refuses every call. */
  readonly retired: boolean;
  /** The number a holder must present to change it; retiring moves it on. */
  readonly generation: number;
  /** Adds work the socket has taken but not flushed. */
  retain(generation: number, frames: number, bytes: number): void;
  /** Takes back work the socket has flushed. */
  release(generation: number, frames: number, bytes: number): void;
  /** Ends the ledger: empty, and closed to every later call of any generation. */
  retire(): void;
}

export function createLedger(): Ledger {
  let frames = 0;
  let bytes = 0;
  let generation = 0;
  let retired = false;

  /** Whether a holder that presents `presented` still speaks for this ledger. */
  const owned = (presented: number): boolean => !retired && presented === generation;

  return {
    get frames(): number {
      return frames;
    },
    get bytes(): number {
      return bytes;
    },
    get retired(): boolean {
      return retired;
    },
    get generation(): number {
      return generation;
    },

    retain(presented: number, addedFrames: number, addedBytes: number): void {
      if (!owned(presented)) return;
      frames += addedFrames;
      bytes += addedBytes;
    },

    release(presented: number, takenFrames: number, takenBytes: number): void {
      if (!owned(presented)) return;
      frames -= takenFrames;
      bytes -= takenBytes;
    },

    retire(): void {
      retired = true;
      frames = 0;
      bytes = 0;
      generation += 1;
    },
  };
}
