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

/** The UTF-8 byte length of a string, without allocating a Buffer. */
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

export interface SseParser {
  /** Feeds one decoded chunk and returns every complete record it produced. */
  feed(chunk: string): readonly string[];
  /** Drops whatever was incomplete: a record that never finished is never delivered. */
  reset(): void;
  readonly pendingLength: number;
}

/**
 * An incremental SSE reader.
 *
 * It handles the parts a real stream makes unavoidable: records split across
 * chunks, `\r\n` as well as `\n`, comment lines, and several `data:` lines in
 * one record. An oversized or unfinished record is dropped rather than guessed
 * at, and the caller decides that the connection is over.
 */
export function createSseParser(limitBytes: number): SseParser {
  let buffer = "";
  let data: string[] = [];

  return {
    get pendingLength(): number {
      return buffer.length;
    },

    feed(chunk: string): readonly string[] {
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
            // A record past the limit is dropped, never truncated and never
            // delivered: half a frame would be worse than none.
            if (utf8Length(record) <= limitBytes) records.push(record);
          }
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) {
          const value = line.slice(5);
          data.push(value.startsWith(" ") ? value.slice(1) : value);
          continue;
        }
        // Any other field is ignored by contract; `id`/`retry` mean nothing here
        // because this binding never resumes a stream.
      }

      if (utf8Length(buffer) > limitBytes || utf8Length(data.join("\n")) > limitBytes) {
        buffer = "";
        data = [];
      }

      return records;
    },

    reset(): void {
      buffer = "";
      data = [];
    },
  };
}
