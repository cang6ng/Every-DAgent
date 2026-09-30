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
 * An unterminated record is measured against the limit with this allowance, so a
 * record split across chunks is judged exactly as the same record arriving whole.
 */
const RECORD_ALLOWANCE_BYTES = 16;

export interface SseParser {
  /** Feeds one decoded chunk and returns every complete record it produced. */
  feed(chunk: string): readonly string[];
  /** True once a record exceeded the limit: this stream cannot be trusted further. */
  readonly overflowed: boolean;
  /**
   * Whether a record has started and not finished.
   *
   * Its lines may all be complete — a record ends with a blank line, not with
   * the last newline — so this is about the record, not about the buffer.
   */
  readonly open: boolean;
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
 * The limit is enforced on the record's payload, measured as it arrives, so the
 * verdict does not depend on where the chunk boundaries fell. Exceeding it is
 * fatal and sticky: the rest of that record is never reinterpreted as a new one,
 * and the caller is expected to end the connection rather than continue with a
 * stream whose framing it can no longer trust.
 */
export function createSseParser(limitBytes: number): SseParser {
  let buffer = "";
  let data: string[] = [];
  let overflowed = false;

  const abandon = (): readonly string[] => {
    overflowed = true;
    data = [];
    buffer = "";
    return [];
  };

  return {
    get overflowed(): boolean {
      return overflowed;
    },

    get open(): boolean {
      return buffer.length > 0 || data.length > 0;
    },

    get pendingLength(): number {
      return buffer.length;
    },

    feed(chunk: string): readonly string[] {
      if (overflowed) return [];

      buffer += chunk;
      const records: string[] = [];

      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);

        if (line === "") {
          // The blank line ends a record; a record with no data is a comment.
          if (data.length > 0) {
            const record = data.join("\n");
            if (utf8Length(record) > limitBytes) return abandon();
            records.push(record);
          }
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) {
          const value = line.slice(5);
          data.push(value.startsWith(" ") ? value.slice(1) : value);
          if (utf8Length(data.join("\n")) > limitBytes) return abandon();
          continue;
        }
        // Any other field is ignored by contract; `id`/`retry` mean nothing here
        // because this binding never resumes a stream.
      }

      if (utf8Length(buffer) > limitBytes + RECORD_ALLOWANCE_BYTES) return abandon();
      return records;
    },

    reset(): void {
      buffer = "";
      data = [];
    },
  };
}
