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
