/**
 * Repair Batch 1.4 — E3 / R12: occurrence pairing is order-independent.
 *
 * A page's cut can land on either side of a tool occurrence, so a page can
 * carry the result above its call. The validator used to compare the two only
 * when the call came first: a result followed by a contradicting call was
 * accepted. These regressions hold the validator to both orders, and keep the
 * fragment licence intact — a half with no counterpart is a legal page, not a
 * fault.
 */

import { describe, expect, it } from "vitest";

import { encodeFrame, validateMessage, type CanonicalItem } from "@every-dagent/protocol";

import { historyPage, hostResponseSuccess } from "./helpers/fixtures.js";

/** One history page carrying exactly the given items, numbered in array order. */
function historyPageOf(items: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    page: historyPage(
      items.map((item, index) => ({ ...item, seq: index + 1 })) as unknown as CanonicalItem[],
    ),
  };
}

const call = (): Record<string, unknown> => ({
  kind: "tool-call",
  id: "i-inv-1",
  turnId: "turn-1",
  invocationId: "inv-1",
  callId: "call-1",
  name: "calculator",
  input: { kind: "json", value: { a: 1 } },
});

const result = (): Record<string, unknown> => ({
  kind: "tool-result",
  id: "r-inv-1",
  turnId: "turn-1",
  invocationId: "inv-1",
  callId: "call-1",
  name: "calculator",
  ok: true,
  content: "42",
});

function accepts(items: readonly Record<string, unknown>[]): boolean {
  const validated = validateMessage(
    { kind: "host-response", method: "sessions.history" },
    hostResponseSuccess(historyPageOf(items)),
  );
  return validated.success;
}

describe("E3 fragment pairs are validated in either order", () => {
  it("accepts a single half, whichever half it is", () => {
    // 1. call-only → VALID. 2. result-only → VALID.
    expect(accepts([call()])).toBe(true);
    expect(accepts([result()])).toBe(true);
  });

  it("accepts matching halves in either order", () => {
    // 3. call then result → VALID. 4. result then call → VALID.
    expect(accepts([call(), result()])).toBe(true);
    expect(accepts([result(), call()])).toBe(true);
  });

  it("rejects a turnId disagreement in either order", () => {
    // 5/6. The second half disagrees about which turn the occurrence is in.
    const laterTurn = { ...result(), turnId: "turn-2" };
    expect(accepts([call(), laterTurn])).toBe(false);
    expect(accepts([laterTurn, call()])).toBe(false);
  });

  it("rejects a callId disagreement in either order", () => {
    // 7. Both orders.
    const otherCall = { ...call(), callId: "call-2" };
    expect(accepts([otherCall, result()])).toBe(false);
    expect(accepts([result(), otherCall])).toBe(false);
  });

  it("rejects a tool-name disagreement in either order", () => {
    // 8. Both orders.
    const otherName = { ...call(), name: "other-tool" };
    expect(accepts([otherName, result()])).toBe(false);
    expect(accepts([result(), otherName])).toBe(false);
  });

  it("rejects a half that arrives twice, in either order", () => {
    // 9. Duplicate calls. 10. Duplicate results.
    expect(accepts([call(), { ...call(), id: "i-inv-1b" }])).toBe(false);
    expect(accepts([result(), { ...result(), id: "r-inv-1b" }])).toBe(false);
    // A duplicate that does not sit next to its twin is still a duplicate.
    expect(accepts([call(), result(), { ...call(), id: "i-inv-1b" }])).toBe(false);
  });

  it("keeps the wire encoder to the same rule as the validator", () => {
    // The frame a host would send is held to the same check on the way out:
    // a result-then-contradicting-call page is not encodable.
    const contradicted = {
      kind: "host-response" as const,
      protocolVersion: "2" as const,
      hostInstanceId: "host-1",
      requestId: "req-1",
      result: hostResponseSuccess(historyPageOf([result(), { ...call(), callId: "call-2" }])) as {
        readonly page: unknown;
      },
    };
    const encoded = encodeFrame(
      { kind: "host-response", method: "sessions.history" },
      contradicted as unknown as Parameters<typeof encodeFrame>[1],
    );
    expect(encoded.success).toBe(false);
  });
});
