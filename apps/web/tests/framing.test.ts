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

  it("never delivers an unfinished record, and drops an oversized one", () => {
    const parser = createSseParser(64);

    expect(parser.feed('data: "half')).toEqual([]);
    expect(parser.feed(" of a record")).toEqual([]);
    expect(parser.feed('"\n\n')).toEqual(['"half of a record"']);
    expect(parser.pendingLength).toBe(0);

    const oversized = createSseParser(64);
    expect(oversized.feed(`data: ${"x".repeat(200)}\n\n`)).toEqual([]);
    expect(oversized.pendingLength).toBe(0);
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
