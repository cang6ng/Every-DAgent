import { describe, expect, it } from "vitest";

import { decodeFrame, encodeFrame, validateMessage } from "@every-dagent/protocol";

import {
  businessRequest,
  clientResponseSuccess,
  describeRequest,
  hostEvent,
  hostRequest,
  hostResponseError,
  hostResponseSuccess,
  INSTANCE,
  sessionSnapshot,
} from "./helpers/fixtures.js";

describe("decodeFrame", () => {
  it("decodes every base kind into its envelope", () => {
    const frames = [
      JSON.stringify(describeRequest()),
      JSON.stringify(hostResponseSuccess({ closed: true })),
      JSON.stringify(clientResponseSuccess({ echoed: "x" })),
      JSON.stringify(hostEvent("run.output.delta", { kind: "run", sessionId: "s-1", runId: "r-1" }, { itemId: "i", text: "t" })),
      JSON.stringify(hostRequest("test.echo", { value: "x" })),
    ];
    const kinds = frames.map((frame) => {
      const decoded = decodeFrame(frame);
      expect(decoded.success).toBe(true);
      return decoded.success ? decoded.output.kind : "";
    });
    expect(kinds).toEqual([
      "client-request",
      "host-response",
      "client-response",
      "host-event",
      "host-request",
    ]);
  });

  it("rejects malformed frames with INVALID_JSON", () => {
    expect(decodeFrame("")).toMatchObject({ success: false, failure: { reason: "INVALID_JSON" } });
    expect(decodeFrame("{not json")).toMatchObject({ success: false, failure: { reason: "INVALID_JSON" } });
    // Two concatenated JSON objects parse as neither.
    expect(decodeFrame('{"a":1}{"b":2}')).toMatchObject({ success: false, failure: { reason: "INVALID_JSON" } });
  });

  it("rejects non-object top-level JSON with INVALID_ENVELOPE", () => {
    expect(decodeFrame("[1,2]")).toMatchObject({ success: false, failure: { reason: "INVALID_ENVELOPE" } });
    expect(decodeFrame("42")).toMatchObject({ success: false, failure: { reason: "INVALID_ENVELOPE" } });
    expect(decodeFrame("null")).toMatchObject({ success: false, failure: { reason: "INVALID_ENVELOPE" } });
  });

  it("catches values only the JSON guard can see, not the parser", () => {
    // 1e999 parses to Infinity.
    expect(decodeFrame('{"kind":"client-request","overflow":1e999}')).toMatchObject({
      success: false,
      failure: { reason: "NON_JSON_VALUE" },
    });
    // -0 parses back as -0.
    expect(decodeFrame('{"a":-0}')).toMatchObject({
      success: false,
      failure: { reason: "NON_JSON_VALUE" },
    });
  });

  it("keeps unknown-but-legal generations decodable for the version gate", () => {
    const decoded = decodeFrame(JSON.stringify({ ...describeRequest(), protocolVersion: "2" }));
    expect(decoded.success).toBe(true);

    const validated = validateMessage({ kind: "client-request" }, { ...describeRequest(), protocolVersion: "2" });
    expect(validated).toMatchObject({ success: false });
  });

  it("survives a missing params with a safe correlation, and never salvages one from broken JSON", () => {
    const missingParams = decodeFrame(JSON.stringify({
      kind: "client-request",
      protocolVersion: "1",
      requestId: "c-7",
      method: "sessions.list",
    }));
    expect(missingParams).toMatchObject({ success: false, failure: { reason: "INVALID_ENVELOPE" } });
    if (!missingParams.success) {
      expect(missingParams.failure.correlation).toEqual({ kind: "client-request", requestId: "c-7" });
    }

    const broken = decodeFrame('{"kind":"client-request","requestId":"c-8"');
    if (!broken.success) expect(broken.failure.correlation).toBeUndefined();
  });

  it("keeps an unknown method decodable so the second layer can answer UNKNOWN_METHOD", () => {
    // Regression guard for the two-layer design: if the base decode ever ran
    // v1 request schemas, an unknown method would die here as INVALID_ENVELOPE
    // instead of surviving to a routable UNKNOWN_METHOD.
    const decoded = decodeFrame(JSON.stringify(
      businessRequest("credentials.steal", {}),
    ));
    expect(decoded.success).toBe(true);
    if (decoded.success) expect(decoded.output).toMatchObject({ kind: "client-request" });

    const validated = validateMessage({ kind: "client-request" }, JSON.parse(JSON.stringify(businessRequest("credentials.steal", {}))));
    expect(validated).toMatchObject({ success: false });
    if (!validated.success) expect(validated.failure.reason).toBe("UNKNOWN_METHOD");
  });

  it("treats prototype-chain method names as unknown at both layers, without crashing", () => {
    for (const method of ["constructor", "toString", "__proto__", "prototype"]) {
      const frame = JSON.stringify(businessRequest(method, {}));
      const decoded = decodeFrame(frame);
      expect(decoded.success).toBe(true);

      const validated = validateMessage({ kind: "client-request" }, JSON.parse(frame));
      expect(validated).toMatchObject({ success: false });
      if (!validated.success) expect(validated.failure.reason).toBe("UNKNOWN_METHOD");
    }
  });
});

describe("encodeFrame", () => {
  it("round-trips a validated message through a string frame", () => {
    const request = businessRequest("sessions.get", { sessionId: "s-1" });
    const encoded = encodeFrame({ kind: "client-request" }, request as never);
    expect(encoded.success).toBe(true);
    if (encoded.success) {
      expect(typeof encoded.output).toBe("string");
      const decoded = decodeFrame(encoded.output);
      expect(decoded.success).toBe(true);
      if (decoded.success) expect(decoded.output.kind).toBe("client-request");

      const validated = validateMessage({ kind: "client-request" }, JSON.parse(encoded.output));
      expect(validated.success).toBe(true);
    }
  });

  it("re-validates on encode: a bad message never becomes a frame", () => {
    const bad = businessRequest("sessions.get", { sessionId: "" });
    const encoded = encodeFrame({ kind: "client-request" }, bad as never);
    expect(encoded).toMatchObject({ success: false });
  });

  it("refuses a message carrying a nested sparse array before it becomes a frame", () => {
    const sparse: unknown[] = new Array(2);
    sparse[0] = 1;
    const hollow: unknown[] = new Array(3);
    for (const nested of [
      { sessionId: "s-1", submissionId: "sub-1", text: "hello", extra: { deep: [1, sparse] } },
      { sessionId: "s-1", submissionId: "sub-1", text: "hello", extra: { deep: [1, hollow] } },
    ]) {
      const encoded = encodeFrame(
        { kind: "client-request" },
        businessRequest("runs.start", nested) as never,
      );
      expect(encoded).toMatchObject({ success: false });
      if (!encoded.success) expect(encoded.failure.reason).toBe("NON_JSON_VALUE");
    }
  });

  it("serializes the methodless error-only response for unknown methods", () => {
    const errorResponse = {
      kind: "host-response",
      protocolVersion: "1",
      hostInstanceId: INSTANCE,
      requestId: "c-99",
      error: { code: "METHOD_NOT_FOUND", message: "unknown method" },
    } as const;
    const encoded = encodeFrame({ kind: "host-response" }, errorResponse);
    expect(encoded.success).toBe(true);
    if (encoded.success) {
      const decoded = decodeFrame(encoded.output);
      expect(decoded.success).toBe(true);
      if (decoded.success) expect(decoded.output).toMatchObject({ kind: "host-response" });
    }
  });

  it("encodes every valid event kind", () => {
    const events = [
      hostEvent("session.created", { kind: "session", sessionId: "s-1" }, { session: sessionSnapshot() }),
      hostEvent("run.output.delta", { kind: "run", sessionId: "s-1", runId: "r-1" }, { itemId: "i", text: "t" }),
    ];
    for (const event of events) {
      const encoded = encodeFrame({ kind: "host-event" }, event as never);
      expect(encoded.success).toBe(true);
    }
  });
});
