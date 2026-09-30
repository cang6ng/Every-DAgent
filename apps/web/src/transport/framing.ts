/**
 * Framing: one protocol frame, one text record, in both directions.
 *
 * A frame is already a JSON string. The binding wraps it in *another* JSON
 * string — `JSON.stringify(frame)` — and unwraps it on the far side. The wrapper
 * is not decoration: it keeps an arbitrary frame exact through a transport that
 * may normalize text (a lone surrogate must survive, and a `data:` line must not
 * be able to end early), and it means the parser never has to look inside a
 * protocol message to know where one ends.
 *
 * Nothing here knows what a session, a run or a plugin is.
 */

const encoder = new TextEncoder();

/** The UTF-8 byte length of a string, which is what every transport budget counts. */
export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

/** Wraps one frame as the text a record carries. */
export function wrapFrame(frame: string): string {
  return JSON.stringify(frame);
}

/** Reads one wrapped record back into a frame; `undefined` if it is not a string. */
export function unwrapRecord(record: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    return undefined;
  }
  return typeof parsed === "string" ? parsed : undefined;
}

/** One SSE record: a single `data:` line and the blank line that ends it. */
export function encodeSseRecord(frame: string): string {
  return `data: ${wrapFrame(frame)}\n\n`;
}

/** A comment record, used for the ready marker and the heartbeat. */
export function encodeSseComment(text: string): string {
  return `: ${text}\n\n`;
}

/**
 * The framing a record may add around its payload — `data: ` and the line ends.
 *
 * A bound has to be stated about a protocol unit, never about the buffer that
 * happens to hold it: the same line is measured with this allowance whether it
 * arrived in one chunk or in twenty.
 */
const RECORD_ALLOWANCE_BYTES = 16;

export interface SseParser {
  /** Feeds one decoded chunk and returns every complete record it produced. */
  feed(chunk: string): readonly string[];
  /** True once a line or a record exceeded the limit: this stream cannot be trusted further. */
  readonly overflowed: boolean;
  /**
   * Whether a record has started and not finished.
   *
   * Its lines may all be complete — a record ends with a blank line, not with
   * the last newline — so this is about the record, not about the buffer. A
   * record that holds nothing but comments is open too: it has started, and it
   * is on the clock like any other.
   */
  readonly open: boolean;
  /**
   * Which record is open: it changes every time a new one starts.
   *
   * A deadline belongs to one record. A chunk that ends a record and starts the
   * next one must not leave the next one holding the previous one's clock, so
   * the owner can tell the records apart by this number alone.
   */
  readonly generation: number;
  /** Drops whatever was incomplete: a record that never finished is never delivered. */
  reset(): void;
  readonly pendingLength: number;
}

/**
 * An incremental SSE reader.
 *
 * It handles the parts a real stream makes unavoidable: records split across
 * chunks, `\r\n` as well as `\n`, comment lines, and several `data:` lines in one
 * record.
 *
 * What the limits apply to is the protocol's own units — a line, and the payload
 * of a record — and every one of them is judged at a position in the byte
 * stream, never at a position in a chunk. A record split anywhere is therefore
 * judged exactly as the same record arriving whole: the same records are
 * emitted, and the same stream overflows.
 *
 * Exceeding a limit is fatal and sticky: the rest of that record is never
 * reinterpreted as a new one, and the caller is expected to end the connection
 * rather than continue with a stream whose framing it can no longer trust.
 */
export function createSseParser(limitBytes: number): SseParser {
  // The longest legal line is a `data:` line carrying a payload at the limit,
  // plus the framing a record adds. Comments and ignored fields are measured
  // against the same bound: a line that cannot be bounded is a stream that
  // cannot be bounded, and skipping a field must not skip its size.
  const lineLimit = limitBytes + RECORD_ALLOWANCE_BYTES;
  let buffer = "";
  let data: string[] = [];
  /** Whether a record has begun and not yet met its terminator. */
  let started = false;
  let generation = 0;
  let overflowed = false;

  const beginRecord = (): void => {
    started = true;
    generation += 1;
  };

  /**
   * Refuses the stream, keeping every record that was already complete before
   * the violation: those records are the same ones a differently cut stream
   * would have delivered, and dropping them here would make what the caller
   * received depend on where the chunk boundaries fell.
   */
  const overflow = (records: readonly string[]): readonly string[] => {
    overflowed = true;
    data = [];
    buffer = "";
    started = false;
    return records;
  };

  return {
    get overflowed(): boolean {
      return overflowed;
    },

    get open(): boolean {
      return started;
    },

    get generation(): number {
      return generation;
    },

    get pendingLength(): number {
      return buffer.length;
    },

    feed(chunk: string): readonly string[] {
      if (overflowed) return [];

      buffer += chunk;
      const records: string[] = [];
      // Bytes that belong to no record yet begin one: a record starts when its
      // first byte arrives, not when its first line happens to be complete — a
      // partial line is a record in progress, and it is on the clock.
      if (!started && buffer.length > 0) beginRecord();

      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);

        if (utf8Length(line) > lineLimit) return overflow(records);

        if (line === "") {
          // The blank line ends a record; a record with no data is a comment.
          if (data.length > 0) records.push(data.join("\n"));
          data = [];
          started = false;
          // The next record may already have begun behind the terminator.
          if (buffer.length > 0) beginRecord();
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) {
          const value = line.slice(5);
          data.push(value.startsWith(" ") ? value.slice(1) : value);
          if (utf8Length(data.join("\n")) > limitBytes) return overflow(records);
          continue;
        }
        // Any other field is ignored by contract; `id`/`retry` mean nothing here
        // because this binding never resumes a stream.
      }

      if (utf8Length(buffer) > lineLimit) return overflow(records);
      return records;
    },

    reset(): void {
      buffer = "";
      data = [];
      started = false;
    },
  };
}
