/**
 * A bounded queue of frames.
 *
 * Both directions of the binding are bounded on purpose: a reader that stops
 * reading, or a writer that outruns its transport, must cost a fixed amount of
 * memory and then end the connection — never an unbounded buffer, and never a
 * silent drop that would leave a sequence looking continuous when it is not.
 */

export interface FrameQueueLimits {
  readonly maxFrames: number;
  readonly maxBytes: number;
}

export interface FrameQueue {
  /** Accepts a frame; `false` means the queue is full and the caller must close. */
  push(frame: string, bytes: number): boolean;
  shift(): string | undefined;
  clear(): void;
  readonly size: number;
  readonly bytes: number;
}

interface QueuedFrame {
  readonly frame: string;
  /** What this frame was charged when it was accepted; released exactly as charged. */
  readonly bytes: number;
}

export function createFrameQueue(limits: FrameQueueLimits): FrameQueue {
  const frames: QueuedFrame[] = [];
  let bytes = 0;

  return {
    push(frame: string, length: number): boolean {
      if (frames.length >= limits.maxFrames || bytes + length > limits.maxBytes) return false;
      frames.push({ frame, bytes: length });
      bytes += length;
      return true;
    },

    shift(): string | undefined {
      const entry = frames.shift();
      if (entry === undefined) return undefined;
      // The same number that was charged, not a re-measure of the string: a
      // byte budget that is entered in one unit and left in another leaks.
      bytes -= entry.bytes;
      return entry.frame;
    },

    clear(): void {
      frames.length = 0;
      bytes = 0;
    },

    get size(): number {
      return frames.length;
    },

    get bytes(): number {
      return bytes;
    },
  };
}
