/**
 * Repair Batch 1.4 — E3 / R12 at the real Client: a contradictory page never
 * becomes history.
 *
 * The client revalidates every accepted response with the same schemas the
 * host encodes with, so a page whose two halves disagree is a protocol
 * violation, not a fold: the page does not enter the history snapshot, the
 * caller's wait is declined, and the connection does not stay `ready`.
 *
 * The positive control is the same page with matching halves in the same
 * order: a result above its call is a legal fragment of a backward traversal,
 * and it folds.
 */

import { describe, expect, it } from "vitest";

import { createScenario } from "./helpers/scenario.js";

/** One page whose oldest item is the result, its call below it in the log. */
function resultThenCall(
  call: Record<string, unknown>,
): Record<string, unknown> {
  return {
    page: {
      storageId: "fake-storage",
      sessionId: "s-1",
      generation: 1,
      historyRevision: 0,
      fenceSeq: 3,
      direction: "backward",
      items: [
        {
          kind: "tool-result",
          id: "s-1:1",
          turnId: "turn-1",
          seq: 1,
          invocationId: "inv-1",
          callId: "call-1",
          name: "calculator",
          ok: true,
          content: "42",
        },
        call,
      ],
      coverage: { fromSeq: 1, toSeq: 3 },
      startsAtTurnBoundary: false,
      endsAtTurnBoundary: false,
      atStart: false,
      atFence: true,
      nextCursor: "cursor-1",
    },
  };
}

const MATCHING_CALL = {
  kind: "tool-call",
  id: "s-1:2",
  turnId: "turn-1",
  seq: 2,
  invocationId: "inv-1",
  callId: "call-1",
  name: "calculator",
  input: { kind: "json", value: { a: 1 } },
};

const CONTRADICTING_CALL = { ...MATCHING_CALL, callId: "call-2" };

function rawHistoryResponse(hostInstanceId: string, requestId: string, body: Record<string, unknown>): string {
  return JSON.stringify({
    kind: "host-response",
    protocolVersion: "2",
    hostInstanceId,
    requestId,
    result: body,
  });
}

describe("E3 the client validates fragment pairs in either order", () => {
  it("accepts a result above its matching call and folds the page", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const host = scenario.host;

    const history = scenario.client.sessions.history({ sessionId: "s-1", limit: 5 });
    const requestId = host.requestIdOf("sessions.history") ?? "";
    expect(requestId).not.toBe("");

    host.sendRaw(rawHistoryResponse(host.hostInstanceId, requestId, resultThenCall(MATCHING_CALL)));

    const answer = await history;
    expect(answer.page.items.map((item) => item.kind)).toEqual(["tool-result", "tool-call"]);
    // Folded into the coverage the snapshot keeps, in the order it arrived.
    const coverage = scenario.client.getSnapshot().history["s-1"];
    expect(coverage?.items.map((item) => item.kind)).toEqual(["tool-result", "tool-call"]);
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });

  it("rejects a result above a contradicting call, without folding anything", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const host = scenario.host;

    const history = scenario.client.sessions.history({ sessionId: "s-1", limit: 5 });
    const requestId = host.requestIdOf("sessions.history") ?? "";
    expect(requestId).not.toBe("");

    // A hostile peer: the page's two halves claim the same occurrence and
    // disagree about which call it is. The raw frame is the only way to send
    // it — the protocol's own encoder refuses to build it.
    host.sendRaw(rawHistoryResponse(host.hostInstanceId, requestId, resultThenCall(CONTRADICTING_CALL)));

    await expect(history).rejects.toMatchObject({ kind: "protocol", reason: "invalid-response" });
    // Nothing about the contradiction became history, and the connection that
    // carried it is not a `ready` one.
    expect(scenario.client.getSnapshot().history["s-1"]).toBeUndefined();
    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });
});
