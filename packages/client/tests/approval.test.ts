/**
 * The typed tool-approval seam on the client.
 *
 * The client is where a `tool.approval` request either becomes a typed
 * question with a bounded answer or becomes a refusal, and the rules are
 * narrow: the payload is the Host's own snapshot, the answer names that one
 * execution, and what this client has *done* is kept apart from what the Host
 * has *decided*.
 */

import { describe, expect, it } from "vitest";

import { decodeFrame, encodeFrame, validateMessage } from "@every-dagent/protocol";
import type { ApprovalSnapshot, JsonValue, ToolApprovalResponse } from "@every-dagent/protocol";

import { createScenario, flush } from "./helpers/scenario.js";
import type { FakeHost } from "./helpers/fake-host.js";

const APPROVAL: ApprovalSnapshot = Object.freeze({
  approvalId: "approval-1",
  executionId: "exec-1",
  sessionId: "s-1",
  runId: "r-1",
  turnId: "t-1",
  invocationId: "inv-1",
  callId: "call-1",
  name: "counter",
  input: Object.freeze({ kind: "json" as const, value: Object.freeze({ n: 1 }) }),
  deadlineAt: 1_700_000_000_000,
  status: "pending" as const,
  canRespond: true,
});

/** Sends one `tool.approval` host request, built and encoded as the protocol demands. */
function sendApproval(host: FakeHost, overrides: Partial<ApprovalSnapshot> = {}, requestId = "h-1"): void {
  const candidate = {
    kind: "host-request",
    protocolVersion: "2",
    requestId,
    method: "tool.approval",
    params: { ...APPROVAL, ...overrides } as unknown as JsonValue,
    hostInstanceId: host.hostInstanceId,
    streamId: host.currentStreamId ?? "",
    timeoutMs: 120_000,
  };
  const validated = validateMessage({ kind: "host-request" }, candidate);
  if (!validated.success) throw new Error(`the fixture built an invalid host request: ${validated.failure.reason}`);
  const encoded = encodeFrame({ kind: "host-request" }, validated.output);
  if (!encoded.success) throw new Error("the fixture could not encode its host request");
  host.sendRaw(encoded.output);
}

/** The client's answers, decoded from the frames it sent. */
function answers(scenario: ReturnType<typeof createScenario>): readonly Record<string, JsonValue>[] {
  return scenario.host.sent.flatMap((frame) => {
    const decoded = decodeFrame(frame);
    if (!decoded.success || decoded.output.kind !== "client-response") return [];
    const answer = decoded.output;
    const record: Record<string, JsonValue> = { requestId: answer.requestId };
    if (answer.result !== undefined) record["result"] = answer.result;
    if (answer.error !== undefined) record["error"] = { code: answer.error.code, message: answer.error.message };
    return [record];
  });
}

/** A ready scenario whose client holds one handler. */
async function scenarioWithHandler(
  handler: Parameters<ReturnType<typeof createScenario>["client"]["registerToolApprovalHandler"]>[0],
): Promise<ReturnType<typeof createScenario>> {
  const scenario = createScenario({});
  scenario.client.registerToolApprovalHandler(handler);
  await scenario.ready();
  return scenario;
}

describe("the typed approval seam", () => {
  it("hands the handler the Host's snapshot and answers with its decision", async () => {
    const seen: ApprovalSnapshot[] = [];
    const scenario = await scenarioWithHandler((snapshot) => {
      seen.push(snapshot);
      return { approvalId: snapshot.approvalId, executionId: snapshot.executionId, decision: "approve" };
    });

    sendApproval(scenario.host);
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.approvalId).toBe("approval-1");
    expect(answers(scenario)[0]?.["result"]).toEqual({
      approvalId: "approval-1",
      executionId: "exec-1",
      decision: "approve",
    });
    // What the client knows is that it sent an answer — never that the
    // execution was approved. The Host's own state is the other half.
    expect(scenario.client.getSnapshot().approvalReply).toMatchObject({
      state: "sent",
      approvalId: "approval-1",
      executionId: "exec-1",
      decision: "approve",
    });
  });

  it("answers a capability this client does not implement with its own refusal", async () => {
    const scenario = createScenario({});
    await scenario.ready();

    sendApproval(scenario.host);
    await flush();

    // No handler: the delivery ends, and the Host's approval is untouched —
    // the refusal is explicitly *not* a rejection of the execution.
    expect(answers(scenario)[0]?.["error"]).toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED" });
    expect(scenario.client.getSnapshot().approvalReply.state).toBe("none");
  });

  it("turns a handler that throws into a safe failure, never its own words", async () => {
    const scenario = await scenarioWithHandler(() => {
      throw new Error("the handler exploded: super-secret-token");
    });

    sendApproval(scenario.host);
    await flush();

    const error = answers(scenario)[0]?.["error"] as { code: string; message: string };
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.message).not.toContain("super-secret-token");
    expect(scenario.client.getSnapshot().approvalReply.state).toBe("failed");
  });

  it("refuses an answer about a different execution", async () => {
    const scenario = await scenarioWithHandler(
      (): ToolApprovalResponse => ({ approvalId: "approval-1", executionId: "another-execution", decision: "approve" }),
    );

    sendApproval(scenario.host);
    await flush();

    expect(answers(scenario)[0]?.["error"]).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(scenario.client.getSnapshot().approvalReply.state).toBe("failed");
  });

  it("refuses an answer that is not the profile's shape at all", async () => {
    const scenario = await scenarioWithHandler(
      () => ({ approvalId: "approval-1", executionId: "exec-1", decision: "maybe", extra: true }) as never,
    );

    sendApproval(scenario.host);
    await flush();

    expect(answers(scenario)[0]?.["error"]).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("does not send an answer for a request whose stream was replaced", async () => {
    let release!: () => void;
    const scenario = await scenarioWithHandler(
      (snapshot): Promise<ToolApprovalResponse> =>
        new Promise((resolve) => {
          release = (): void =>
            resolve({ approvalId: snapshot.approvalId, executionId: snapshot.executionId, decision: "approve" });
        }),
    );

    sendApproval(scenario.host);
    await flush();
    expect(scenario.client.getSnapshot().approvalReply.state).toBe("pending");

    // A re-cut replaces the stream this request arrived on. The handler finishes
    // afterwards, and its late answer must never travel: the request it belongs
    // to is over, and the new stream has its own numbering.
    await scenario.client.resync();
    release();
    await flush();

    expect(answers(scenario)).toEqual([]);
    expect(scenario.client.getSnapshot().approvalReply.state).not.toBe("sent");
  });

  it("keeps the Host's business state apart from this client's reply state", async () => {
    const scenario = await scenarioWithHandler((snapshot) => ({
      approvalId: snapshot.approvalId,
      executionId: snapshot.executionId,
      decision: "approve",
    }));
    sendApproval(scenario.host);
    await flush();

    // The Host says what it decided: the approval is approved, and no longer
    // answerable. This client's own history says it sent an answer.
    scenario.host.emit({ type: "approval.updated", approval: { ...APPROVAL, status: "approved", canRespond: false } });
    await flush();

    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.presentation?.approval?.status).toBe("approved");
    expect(snapshot.approvalCanRespond).toBe(false);
    expect(snapshot.approvalReply.state).toBe("closed");
  });

  it("will not answer an approval the Host has not published", async () => {
    // A delivery with no current approval: the request is legal, and this
    // client has nothing it may claim to answer.
    const scenario = await scenarioWithHandler((snapshot) => ({
      approvalId: snapshot.approvalId,
      executionId: snapshot.executionId,
      decision: "approve",
    }));

    sendApproval(scenario.host);
    await flush();

    expect(scenario.client.getSnapshot().approvalCanRespond).toBe(false);
  });
});
