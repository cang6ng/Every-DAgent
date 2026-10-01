import { describe, expect, it } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  validateMessage,
  type HostRequest,
  type ProtocolChannel,
} from "@every-dagent/protocol";

import { createMemoryChannelPair } from "./helpers/memory-channel.js";
import {
  TEST_PROFILE_METHOD,
  refineTestEchoParams,
  refineTestEchoResult,
} from "./helpers/reverse-profile.js";
import {
  clientResponseError,
  clientResponseSuccess,
  hostRequest,
  INSTANCE,
  STREAM,
} from "./helpers/fixtures.js";

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

    // Neither half present: a v2 envelope that carries no outcome at all.
    const neither = validateMessage({ kind: "client-response" }, {
      kind: "client-response",
      protocolVersion: "2",
      hostInstanceId: INSTANCE,
      streamId: STREAM,
      requestId: "h-1",
    });
    expect(neither).toMatchObject({ success: false });
  });

  it("validates the error-only client response", () => {
    const result = validateMessage({ kind: "client-response" }, clientResponseError());
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
        protocolVersion: "2",
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

describe("reverse seam roundtrip over a memory channel", () => {
  it("carries a test-only profile Host → Client → Host with real refinement", () => {
    const { clientSide, hostSide } = createMemoryChannelPair();
    const clientFrames: string[] = [];
    const hostFrames: string[] = [];
    clientSide.listen({ onFrame: (frame) => clientFrames.push(frame), onClose: () => {} });
    hostSide.listen({ onFrame: (frame) => hostFrames.push(frame), onClose: () => {} });

    // Host → Client: the reverse request travels from the host side.
    const request = hostRequest(TEST_PROFILE_METHOD, { value: "hi" });
    const encodedRequest = encodeFrame({ kind: "host-request" }, request as never);
    expect(encodedRequest.success).toBe(true);
    if (encodedRequest.success) hostSide.send(encodedRequest.output);
    expect(clientFrames.length).toBe(1);

    // Client: frame → decodeFrame → validateMessage → refine the params.
    const decodedRequest = decodeFrame(clientFrames[0]);
    expect(decodedRequest.success).toBe(true);
    const validated = validateMessage({ kind: "host-request" }, decodedRequest.success ? decodedRequest.output : undefined);
    expect(validated.success).toBe(true);
    if (validated.success) {
      const hostRequestMessage = validated.output as HostRequest;
      expect(hostRequestMessage.method).toBe(TEST_PROFILE_METHOD);
      const params = refineTestEchoParams(hostRequestMessage.params);
      expect(params.success).toBe(true);
      const value = params.success ? params.output.value : "";

      // Client → Host: the response travels from the client side and MUST be
      // a client-response — the Host is the one that reads it.
      const response = clientResponseSuccess({ echoed: value });
      const encodedResponse = encodeFrame({ kind: "client-response" }, response as never);
      expect(encodedResponse.success).toBe(true);
      if (encodedResponse.success) clientSide.send(encodedResponse.output);
    }

    // Host side: frame → decodeFrame → validateMessage → refine the result.
    expect(hostFrames.length).toBe(1);
    const decodedResponse = decodeFrame(hostFrames[0]);
    expect(decodedResponse.success).toBe(true);
    const hostValidated = validateMessage(
      { kind: "client-response" },
      decodedResponse.success ? decodedResponse.output : undefined,
    );
    expect(hostValidated.success).toBe(true);
    if (hostValidated.success) {
      const result = refineTestEchoResult((hostValidated.output as { result: unknown }).result);
      expect(result.success).toBe(true);
      if (result.success) expect(result.output.echoed).toBe("hi");
    }
  });

  it("answers an unknown HostRequest with a client-response error, never a host-response", () => {
    const { clientSide, hostSide } = createMemoryChannelPair();
    const clientFrames: string[] = [];
    const hostFrames: string[] = [];
    clientSide.listen({ onFrame: (frame) => clientFrames.push(frame), onClose: () => {} });
    hostSide.listen({ onFrame: (frame) => hostFrames.push(frame), onClose: () => {} });

    const encodedRequest = encodeFrame(
      { kind: "host-request" },
      hostRequest("file.pick", {}) as never,
    );
    expect(encodedRequest.success).toBe(true);
    if (encodedRequest.success) hostSide.send(encodedRequest.output);

    // The client decodes the frame, validates the envelope, finds no handler
    // for the method, and refuses through its own response channel: a
    // client-response error carrying METHOD_NOT_FOUND.
    const decodedRequest = decodeFrame(clientFrames[0]);
    expect(decodedRequest.success).toBe(true);
    const validated = validateMessage({ kind: "host-request" }, decodedRequest.success ? decodedRequest.output : undefined);
    expect(validated.success).toBe(true);
    if (validated.success) {
      const refusal = clientResponseError();
      (refusal as Record<string, unknown>)["requestId"] = (validated.output as HostRequest).requestId;
      (refusal as Record<string, unknown>)["error"] = { code: "METHOD_NOT_FOUND", message: "unknown reverse method" };
      const encodedRefusal = encodeFrame({ kind: "client-response" }, refusal as never);
      expect(encodedRefusal.success).toBe(true);
      if (encodedRefusal.success) clientSide.send(encodedRefusal.output);
    }

    // The host decodes the frame before correlating the refusal.
    const decodedRefusal = decodeFrame(hostFrames[0]);
    expect(decodedRefusal.success).toBe(true);
    const hostReceived = validateMessage(
      { kind: "client-response" },
      decodedRefusal.success ? decodedRefusal.output : undefined,
    );
    expect(hostReceived.success).toBe(true);
    if (hostReceived.success) {
      expect((hostReceived.output as { error?: { code: string } }).error?.code).toBe("METHOD_NOT_FOUND");
    }
  });

  it("honours single-listener, close-once and late-send-fails semantics", () => {
    const { clientSide, hostSide } = createMemoryChannelPair();
    let closed = 0;
    hostSide.listen({ onFrame: () => {}, onClose: () => { closed += 1; } });

    expect(() => hostSide.listen({ onFrame: () => {}, onClose: () => {} })).toThrow();

    hostSide.close();
    hostSide.close();
    expect(closed).toBe(1);
    // The host side is closed, so client → host delivery fails loudly instead
    // of vanishing.
    expect(() => clientSide.send("{}")).toThrow();
  });

  it("keeps the loopback pair assignable to the frozen ProtocolChannel type", () => {
    const { clientSide, hostSide }: { clientSide: ProtocolChannel; hostSide: ProtocolChannel } =
      createMemoryChannelPair();
    expect(typeof clientSide.send).toBe("function");
    expect(typeof hostSide.listen).toBe("function");
  });
});
