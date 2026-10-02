/**
 * The E4 request-id bound, at the validation boundary.
 *
 * A request id is at most `MAX_REQUEST_ID_BYTES` **UTF-8 bytes** — not
 * characters, not UTF-16 code units, not JSON-token bytes — in every envelope
 * position: the client's request, the host's answer, the host's own reverse
 * request, and the client's answer to it. A legal id travels through
 * validation and encoding untouched; an over-long one is not a correlation at
 * all, which is what keeps it from being answered with an echo of itself.
 */

import { describe, expect, it } from "vitest";

import type { ClientRequest, SessionSummary } from "@every-dagent/protocol";
import { MAX_REQUEST_ID_BYTES, decodeFrame, encodeFrame, validateMessage } from "@every-dagent/protocol";

import {
  businessRequest,
  clientResponseSuccess,
  describeRequest,
  hostResponseError,
  hostResponseSuccess,
  hostRequest,
  sessionSummary,
} from "./helpers/fixtures.js";

/** One legal id of each shape the bound allows. */
const LEGAL: readonly string[] = [
  "c-1",
  "a".repeat(MAX_REQUEST_ID_BYTES - 1),
  "a".repeat(MAX_REQUEST_ID_BYTES),
  "中".repeat(42),
  "🙂".repeat(32),
  // The worst legal id there is: every byte escapes to six JSON characters.
  "\u0000".repeat(MAX_REQUEST_ID_BYTES),
];

/** One id that is over the bound in bytes only — its character count is 43. */
const OVER = "中".repeat(43);

const EMPTY_SESSIONS = { sessions: { items: [], collectionRevision: 0, nextCursor: null, hasMore: false } };

describe("the request-id byte bound", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(Buffer.byteLength(OVER, "utf8")).toBe(MAX_REQUEST_ID_BYTES + 1);
    expect(OVER.length).toBe(43);
    expect(Buffer.byteLength("🙂".repeat(32), "utf8")).toBe(MAX_REQUEST_ID_BYTES);
    expect("🙂".repeat(32).length).toBe(64);
  });

  it("accepts every legal id in every envelope position", () => {
    for (const id of LEGAL) {
      // The client's request and the host's answer to it.
      expect(validateMessage({ kind: "client-request" }, businessRequest("sessions.list", {}, id)).success).toBe(true);
      expect(
        validateMessage(
          { kind: "host-response", method: "sessions.list" },
          hostResponseSuccess(EMPTY_SESSIONS, id),
        ).success,
      ).toBe(true);
      // The host's own reverse request and the client's answer to it.
      expect(validateMessage({ kind: "host-request" }, hostRequest("tool.approval", {}, id)).success).toBe(true);
      expect(validateMessage({ kind: "client-response" }, clientResponseSuccess({ ok: true }, id)).success).toBe(true);
    }
  });

  it("refuses the over-long id in every envelope position", () => {
    expect(validateMessage({ kind: "client-request" }, businessRequest("sessions.list", {}, OVER)).success).toBe(false);
    expect(
      validateMessage({ kind: "host-response", method: "sessions.list" }, hostResponseSuccess(EMPTY_SESSIONS, OVER)).success,
    ).toBe(false);
    expect(validateMessage({ kind: "host-request" }, hostRequest("tool.approval", {}, OVER)).success).toBe(false);
    expect(validateMessage({ kind: "client-response" }, clientResponseSuccess({ ok: true }, OVER)).success).toBe(false);
    // The error-only path carries an id too, and it is held to the same bound.
    expect(validateMessage({ kind: "host-response" }, hostResponseError(OVER)).success).toBe(false);
  });

  it("refuses to encode a frame carrying an over-long id", () => {
    // The type parameter is not proof: the encoder re-validates what it is
    // handed, and the id is what fails.
    const request = businessRequest("sessions.list", {}, OVER) as unknown as ClientRequest;
    expect(encodeFrame({ kind: "client-request" }, request).success).toBe(false);
  });

  it("drops the correlation for an over-long id, so nothing can answer it", () => {
    // A legal id is a correlation: the rest of the envelope may be broken —
    // here the method is missing — and the upper layer can still answer
    // INVALID_REQUEST.
    const legal = decodeFrame(
      JSON.stringify({
        kind: "client-request",
        protocolVersion: "2",
        requestId: "a".repeat(MAX_REQUEST_ID_BYTES),
        params: {},
      }),
    );
    expect(legal.success).toBe(false);
    if (!legal.success) {
      expect(legal.failure.correlation?.requestId).toHaveLength(MAX_REQUEST_ID_BYTES);
    }

    // An over-long one is not: the id itself is illegal, so the association is
    // refused rather than echoed back to its sender.
    for (const frame of [
      { kind: "client-request", protocolVersion: "2", requestId: OVER, params: {} },
      describeRequest(OVER),
    ]) {
      const decoded = decodeFrame(JSON.stringify(frame));
      expect(decoded.success).toBe(false);
      if (!decoded.success) expect(decoded.failure.correlation).toBeUndefined();
    }
  });

  it("keeps the request-id bound off the other identities the wire carries", () => {
    // Session, run and stream ids are bounded by the frame they travel in, not
    // by the request-id bound: a host that mints longer ids stays legal, and
    // the tightening is exactly one field's.
    const longId = "x".repeat(MAX_REQUEST_ID_BYTES + 50);
    expect(validateMessage({ kind: "client-request" }, businessRequest("sessions.get", { sessionId: longId })).success).toBe(
      true,
    );
    const session = { ...sessionSummary(), sessionId: longId } as SessionSummary;
    expect(
      validateMessage({ kind: "host-response", method: "sessions.get" }, hostResponseSuccess({ session }, "c-1")).success,
    ).toBe(true);
  });
});
