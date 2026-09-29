import { describe, expect, it } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  validateMessage,
  type ProtocolChannel,
} from "@every-dagent/protocol";

import { createMemoryChannelPair } from "./helpers/memory-channel.js";
import { TEST_PROFILE_METHOD, refineTestEchoResult } from "./helpers/reverse-profile.js";
import { clientResponseSuccess, hostRequest, INSTANCE, STREAM } from "./helpers/fixtures.js";

describe("reverse request envelope", () => {
  it("validates a well-formed host-request with any method name", () => {
    const result = validateMessage({ kind: "host-request" }, hostRequest("anything.at.all", { x: 1 }));
    expect(result.success).toBe(true);
  });

  it("validates an unknown reverse method as a valid envelope (refusal is the Client's dispatch)", () => {
    const result = validateMessage({ kind: "host-request" }, hostRequest(TEST_PROFILE_METHOD, { value: "hi" }));
    expect(result.success).toBe(true);
  });

  it("rejects a host-request whose timeoutMs is not a positive safe integer", () => {
    for (const timeoutMs of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const result = validateMessage(
        { kind: "host-request" },
        { ...hostRequest("test.ping", {}), timeoutMs },
      );
      expect(result).toMatchObject({ success: false });
    }
  });

  it("enforces the result/error XOR on client responses", () => {
    const both = validateMessage({ kind: "client-response" }, {
      ...clientResponseSuccess({ echoed: "x" }),
      error: { code: "REQUEST_CANCELLED", message: "x" },
    });
    expect(both).toMatchObject({ success: false });

    const neither = validateMessage({ kind: "client-response" }, {
      kind: "client-response",
      protocolVersion: "1",
      hostInstanceId: INSTANCE,
      streamId: STREAM,
      requestId: "h-1",
    });
    expect(neither).toMatchObject({ success: false });
  });

  it("validates the error-only client response", () => {
    const result = validateMessage({ kind: "client-response" }, {
      kind: "client-response",
      protocolVersion: "1",
      hostInstanceId: INSTANCE,
      streamId: STREAM,
      requestId: "h-1",
      error: { code: "METHOD_NOT_FOUND", message: "unknown reverse method" },
    });
    expect(result.success).toBe(true);
  });

  it("refines a test-profile result only after the envelope validated", () => {
    const badShape = refineTestEchoResult({ echoed: 42 });
    expect(badShape.success).toBe(false);

    const good = refineTestEchoResult({ echoed: "hi" });
    expect(good.success).toBe(true);

    // The envelope itself accepts any JSON result; refinement is profile work.
    const envelope = validateMessage(
      { kind: "client-response" },
      clientResponseSuccess({ echoed: 42 }),
    );
    expect(envelope.success).toBe(true);
  });

  it("answers a host.request.cancelled control event through the same validator", () => {
    const result = validateMessage(
      { kind: "host-event" },
      {
        kind: "host-event",
        protocolVersion: "1",
        hostInstanceId: INSTANCE,
        streamId: STREAM,
        sequence: 4,
        scope: { kind: "host" },
        type: "host.request.cancelled",
        payload: { requestId: "h-1", reason: "timeout" },
      },
    );
    expect(result.success).toBe(true);
  });
});

describe("memory channel transport contract", () => {
  it("delivers string frames both ways and never shares objects", () => {
    const { clientSide, hostSide } = createMemoryChannelPair();
    const receivedByHost: string[] = [];
    const receivedByClient: string[] = [];

    hostSide.listen({ onFrame: (frame) => receivedByHost.push(frame), onClose: () => {} });
    clientSide.listen({ onFrame: (frame) => receivedByClient.push(frame), onClose: () => {} });

    const request = hostRequest(TEST_PROFILE_METHOD, { value: "hi" });
    const encodedRequest = encodeFrame({ kind: "host-request" }, request as never);
    expect(encodedRequest.success).toBe(true);
    if (encodedRequest.success) clientSide.send(encodedRequest.output);

    // The host side parses the STRING it received: JSON roundtrip is forced.
    expect(receivedByHost.length).toBe(1);
    const parsed = JSON.parse(receivedByHost[0] as string) as Record<string, unknown>;
    expect(parsed["method"]).toBe(TEST_PROFILE_METHOD);
    // What arrived is not the same object the client encoded.
    expect(parsed).not.toBe(request);

    const response = clientResponseSuccess({ echoed: "hi" });
    const encodedResponse = encodeFrame({ kind: "client-response" }, response as never);
    expect(encodedResponse.success).toBe(true);
    if (encodedResponse.success) hostSide.send(encodedResponse.output);
    expect(receivedByClient.length).toBe(1);
  });

  it("honours single-listener, close-once and late-send-fails semantics", () => {
    const { clientSide, hostSide } = createMemoryChannelPair();
    let closed = 0;
    hostSide.listen({ onFrame: () => {}, onClose: () => { closed += 1; } });

    expect(() => hostSide.listen({ onFrame: () => {}, onClose: () => {} })).toThrow();

    hostSide.close();
    hostSide.close();
    expect(closed).toBe(1);
    expect(() => clientSide.send("{}")).toThrow();
    void clientSide;
  });

  it("keeps the loopback pair assignable to the frozen ProtocolChannel type", () => {
    const { clientSide, hostSide }: { clientSide: ProtocolChannel; hostSide: ProtocolChannel } =
      createMemoryChannelPair();
    expect(typeof clientSide.send).toBe("function");
    expect(typeof hostSide.listen).toBe("function");
  });
});

describe("reverse seam boundary", () => {
  it("decodes an unknown-method host-request the Host could answer METHOD_NOT_FOUND to", () => {
    const encoded = encodeFrame({ kind: "host-request" }, hostRequest("file.pick", {}) as never);
    expect(encoded.success).toBe(true);
    if (encoded.success) {
      const decoded = decodeFrame(encoded.output);
      expect(decoded.success).toBe(true);
      if (decoded.success && decoded.output.kind === "host-request") {
        expect(decoded.output.method).toBe("file.pick");
      }
    }

    // And the error-only response path can carry METHOD_NOT_FOUND back.
    const refusal = {
      kind: "host-response",
      protocolVersion: "1",
      hostInstanceId: INSTANCE,
      requestId: "h-9",
      error: { code: "METHOD_NOT_FOUND", message: "unknown method" },
    } as const;
    const encodedRefusal = encodeFrame({ kind: "host-response" }, refusal);
    expect(encodedRefusal.success).toBe(true);
  });
});
