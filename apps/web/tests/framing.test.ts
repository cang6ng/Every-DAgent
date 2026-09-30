/**
 * Framing: what actually travels, and what happens when it does not fit.
 *
 * The wrapper is the whole reason a frame survives: an arbitrary string is
 * carried as text, and a record that never finishes is dropped rather than
 * guessed at. These tests pin both, at the byte level, without a socket.
 */

import { describe, expect, it } from "vitest";

import {
  FRAME_LIMIT_BYTES,
  RECORD_LIMIT_BYTES,
  createSseParser,
  encodeSseComment,
  encodeSseRecord,
  unwrapRecord,
  utf8Length,
  wrapFrame,
} from "../src/index.js";

describe("the JSON string wrapper", () => {
  it("round-trips any frame exactly, including the awkward ones", () => {
    const frames = [
      '{"kind":"host-response","result":{"text":"hello"}}',
      'a frame with "quotes", \\backslashes\\ and \n newlines',
      "\u0000 control characters \u001f",
      "a lone surrogate: \ud800",
      "emoji and accents: 🚀 café é",
      "",
    ];

    for (const frame of frames) {
      expect(unwrapRecord(wrapFrame(frame))).toBe(frame);
    }
  });

  it("refuses a record that is not a wrapped string", () => {
    expect(unwrapRecord('{"kind":"host-response"}')).toBeUndefined();
    expect(unwrapRecord("42")).toBeUndefined();
    expect(unwrapRecord("null")).toBeUndefined();
    expect(unwrapRecord("not json at all")).toBeUndefined();
  });

  it("keeps a protocol frame from being able to end its own record", () => {
    // A frame containing a blank line cannot split the record in two: the
    // wrapper escapes it, and the parser only splits on real line breaks.
    const frame = 'a frame with\n\ntwo blank lines';
    const parser = createSseParser(RECORD_LIMIT_BYTES);
    const records = parser.feed(encodeSseRecord(frame));

    expect(records).toHaveLength(1);
    expect(unwrapRecord(records[0] ?? "")).toBe(frame);
  });

  it("measures UTF-8 bytes, not code units", () => {
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("🚀")).toBe(4);
    expect(utf8Length(FRAME_LIMIT_BYTES === 1024 * 1024 ? "ok" : "")).toBe(2);
  });
});

describe("the SSE reader", () => {
  it("reads records split across chunks, in order", () => {
    const parser = createSseParser(RECORD_LIMIT_BYTES);
    const stream = encodeSseRecord("first") + encodeSseRecord("second");

    const chunks = [stream.slice(0, 5), stream.slice(5, 11), stream.slice(11)];
    const records = chunks.flatMap((chunk) => [...parser.feed(chunk)]);

    expect(records.map((record) => unwrapRecord(record))).toEqual(["first", "second"]);
  });

  it("accepts CRLF line endings", () => {
    const parser = createSseParser(RECORD_LIMIT_BYTES);

    expect(parser.feed('data: "crlf"\r\n\r\n')).toHaveLength(1);
  });

  it("ignores comments and other fields, and joins multiple data lines", () => {
    const parser = createSseParser(RECORD_LIMIT_BYTES);

    expect(parser.feed(": ready\n\n")).toEqual([]);
    expect(parser.feed('id: 7\nretry: 100\ndata: "one"\ndata: "two"\n\n')).toEqual(['"one"\n"two"']);
  });

  it("never delivers an unfinished record", () => {
    const parser = createSseParser(64);

    expect(parser.feed('data: "half')).toEqual([]);
    expect(parser.feed(" of a record")).toEqual([]);
    expect(parser.feed('"\n\n')).toEqual(['"half of a record"']);
    expect(parser.pendingLength).toBe(0);
    expect(parser.overflowed).toBe(false);
  });

  it("accepts a record exactly at the limit and refuses the next byte", () => {
    const payload = "x".repeat(64);
    const atLimit = createSseParser(64);
    expect(atLimit.feed(`data: ${payload}\n\n`)).toEqual([payload]);
    expect(atLimit.overflowed).toBe(false);

    const overLimit = createSseParser(64);
    expect(overLimit.feed(`data: ${"x".repeat(65)}\n\n`)).toEqual([]);
    expect(overLimit.overflowed).toBe(true);
  });

  it("judges a record the same way however it was split", () => {
    const payload = "x".repeat(64);
    const record = `data: ${payload}\n\n`;

    for (let cut = 1; cut < record.length; cut += 1) {
      const parser = createSseParser(64);
      const records = [...parser.feed(record.slice(0, cut)), ...parser.feed(record.slice(cut))];
      expect(records, `split at ${cut}`).toEqual([payload]);
      expect(parser.overflowed, `split at ${cut}`).toBe(false);
    }

    const tooLong = `data: ${"x".repeat(65)}\n\n`;
    for (let cut = 1; cut < tooLong.length; cut += 1) {
      const parser = createSseParser(64);
      const records = [...parser.feed(tooLong.slice(0, cut)), ...parser.feed(tooLong.slice(cut))];
      expect(records, `split at ${cut}`).toEqual([]);
      expect(parser.overflowed, `split at ${cut}`).toBe(true);
    }
  });

  it("counts a record's payload across several data lines", () => {
    const parser = createSseParser(10);
    // Twenty bytes of payload, spread over lines, with the separators counted.
    expect(parser.feed('data: "1234"\ndata: "5678"\n\n')).toEqual([]);
    expect(parser.overflowed).toBe(true);
  });

  /**
   * One stream, cut into chunks of `size` code points each.
   *
   * A chunk boundary in this parser is a boundary between decoded code points:
   * the bytes were already turned into a string by the decoder above it, and
   * cutting a surrogate pair here would be a different stream, not a different
   * chunking of this one.
   */
  function judged(stream: string, limit: number, size: number): { readonly records: readonly string[]; readonly overflowed: boolean; readonly generations: number } {
    const parser = createSseParser(limit);
    const points = [...stream];
    const records: string[] = [];
    for (let at = 0; at < points.length; at += size) {
      for (const record of parser.feed(points.slice(at, at + size).join(""))) records.push(record);
    }
    return { records, overflowed: parser.overflowed, generations: parser.generation };
  }

  it("judges one stream identically however it is cut into chunks", () => {
    const streams: readonly { readonly name: string; readonly stream: string; readonly limit: number }[] = [
      // The counterexample: a comment record longer than the limit is refused
      // whether it arrives whole or in pieces — the verdict is about the line,
      // not about the buffer that happens to hold it.
      { name: "a comment record past the limit", stream: `: ${"x".repeat(40)}\n\n`, limit: 8 },
      { name: "a comment record at the limit", stream: `: ${"x".repeat(6)}\n\n`, limit: 8 },
      { name: "comment-only records", stream: ": keepalive\n\n: ping\n\n", limit: 64 },
      { name: "several data records", stream: 'data: "one"\n\ndata: "two"\n\n', limit: 64 },
      { name: "a record exactly at the limit", stream: `data: ${"z".repeat(64)}\n\n`, limit: 64 },
      { name: "a record one byte past it", stream: `data: ${"z".repeat(65)}\n\n`, limit: 64 },
      { name: "CRLF line ends", stream: 'data: "crlf"\r\n\r\n', limit: 64 },
      // CRLF is one terminator, and which half of it a chunk ends on is not a
      // property of the stream. The line below is exactly at the limit without
      // its CR, so a parser that charges the CR as content overflows on one
      // chunking and not on another.
      { name: "a line ending in CRLF exactly at the limit", stream: `: ${"x".repeat(22)}\r\n\r\n`, limit: 8 },
      { name: "a CRLF line one byte past the limit", stream: `: ${"x".repeat(23)}\r\n\r\n`, limit: 8 },
      { name: "a line whose CR is followed by something else", stream: `: ${"x".repeat(22)}\ry\n\n`, limit: 8 },
      { name: "a blank CRLF line after a comment", stream: `: ${"x".repeat(6)}\r\n\r\n: ${"y".repeat(6)}\r\n\r\n`, limit: 8 },
      { name: "a record with no terminator", stream: 'data: "unfinished', limit: 64 },
      { name: "an oversized line with no terminator", stream: `data: ${"q".repeat(40)}`, limit: 8 },
      { name: "multi-byte payloads", stream: 'data: "é中🚀"\n\n', limit: 64 },
      { name: "a comment between data lines", stream: 'data: "a"\n: note\ndata: "b"\n\n', limit: 64 },
      // A complete record followed by a violating one: what was already
      // delivered must not depend on the chunk boundary having fallen between
      // the two.
      { name: "a good record before a bad one", stream: `data: "ok"\n\ndata: ${"x".repeat(40)}\n\n`, limit: 8 },
    ];

    for (const { name, stream, limit } of streams) {
      const whole = judged(stream, limit, stream.length + 1);
      for (let size = 1; size <= [...stream].length; size += 1) {
        const cut = judged(stream, limit, size);
        expect(cut, `${name}, chunks of ${size}`).toMatchObject({
          records: whole.records,
          overflowed: whole.overflowed,
        });
      }
    }
  });

  it("does not overflow a line whose CR has arrived but whose LF has not", () => {
    // The counterexample, byte for byte: a comment line of exactly the line
    // limit, terminated by CRLF, inside a record of its own. Every chunking of
    // these 28 bytes is the same stream, so every chunking gets the same
    // verdict — including the one that splits the terminator in half.
    const raw = `: ${"x".repeat(22)}\r\n\r\n`;
    expect(utf8Length(raw)).toBe(28);

    expect(judged(raw, 8, raw.length + 1), "whole").toMatchObject({ records: [], overflowed: false });
    expect(judged(raw, 8, 25), "split between the CR and its LF").toMatchObject({ records: [], overflowed: false });
    for (let size = 1; size <= [...raw].length; size += 1) {
      expect(judged(raw, 8, size), `chunks of ${size}`).toMatchObject({ records: [], overflowed: false });
    }
  });

  it("keeps a line bounded that never receives its LF", () => {
    // Holding back a trailing CR is holding back one byte, not suspending the
    // limit: a stream that is nothing but CRs, or that ends on one, is measured
    // like any other and refused once it is past the bound.
    expect(judged(": " + "x".repeat(22) + "\r", 8, 1000)).toMatchObject({ records: [], overflowed: false });
    expect(judged(": " + "x".repeat(23) + "\r", 8, 1000)).toMatchObject({ records: [], overflowed: true });
    expect(judged("\r".repeat(64), 8, 1000)).toMatchObject({ records: [], overflowed: true });
  });

  it("refuses an oversized line that ends in CR, however it is cut", () => {
    // The CR is only held back while it could still be half of a terminator:
    // the line below is past the limit with or without it.
    const raw = `: ${"x".repeat(24)}\r\n\r\n`;
    for (let size = 1; size <= [...raw].length; size += 1) {
      expect(judged(raw, 8, size), `chunks of ${size}`).toMatchObject({ records: [], overflowed: true });
    }
  });

  it("delivers the records it already completed before a violation", () => {
    // The failing record is dropped, and the record that finished before it is
    // not: a chunk that happens to carry both must not swallow the first.
    expect(judged(`data: "ok"\n\ndata: ${"x".repeat(40)}\n\n`, 8, 1_000)).toEqual({
      records: ['"ok"'],
      overflowed: true,
      generations: 2,
    });
    expect(judged(`data: "ok"\n\ndata: ${"x".repeat(40)}\n\n`, 8, 3).records).toEqual(['"ok"']);
  });

  it("starts a new generation whenever a record starts", () => {
    const parser = createSseParser(64);
    expect(parser.generation).toBe(0);
    parser.feed('data: "first');
    const first = parser.generation;
    expect(first).toBe(1);
    expect(parser.open).toBe(true);

    // The same chunk ends the first record and starts the second: the second is
    // a different record, and its deadline must not be the first one's.
    parser.feed('"\n\ndata: "second');
    expect(parser.generation).toBe(first + 1);
    expect(parser.open).toBe(true);

    // A record that ends and nothing follows leaves nothing open.
    parser.feed('"\n\n');
    expect(parser.open).toBe(false);
    expect(parser.feed("")).toEqual([]);
    expect(parser.generation).toBe(first + 1);
  });

  it("treats a comment-only record as a record", () => {
    const parser = createSseParser(64);

    parser.feed(": keepalive\n");
    // Its only line is a comment, and the record it belongs to has not been
    // terminated: it has started, and it is open.
    expect(parser.open).toBe(true);

    parser.feed("\n");
    expect(parser.open).toBe(false);
  });

  it("does not reinterpret the rest of an oversized record as a new one", () => {
    const parser = createSseParser(16);
    parser.feed(`data: ${"x".repeat(64)}\n`);

    expect(parser.overflowed).toBe(true);
    expect(parser.pendingLength).toBe(0);
    // Whatever arrives afterwards belongs to the record that already failed.
    expect(parser.feed('data: "small"\n\n')).toEqual([]);
    expect(parser.overflowed).toBe(true);
  });

  it("writes the ready marker as a comment", () => {
    expect(encodeSseComment("ready")).toBe(": ready\n\n");
  });
});

describe("the binding's limits", () => {
  it("keeps the record limit above any frame plus its wrapper", () => {
    const worstCase = wrapFrame("\\".repeat(FRAME_LIMIT_BYTES)).length;
    expect(RECORD_LIMIT_BYTES).toBeGreaterThan(worstCase);
  });
});
