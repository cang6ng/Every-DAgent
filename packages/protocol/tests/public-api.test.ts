import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  validateJsonValue,
  validateMessage,
  type ClientCapabilities,
  type ClientRequest,
  type HostCapabilities,
  type HostEvent,
  type HostResponse,
  type OperationName,
} from "@every-dagent/protocol";

/**
 * Type-level identity helper: proves two types are the same, not merely
 * assignable. Used to pin the frozen name sets at compile time.
 */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
  ? true
  : false;
type Expect<T extends true> = T;

const RUNTIME_EXPORTS = [
  "PROTOCOL_VERSION",
  "decodeFrame",
  "encodeFrame",
  "validateJsonValue",
  "validateMessage",
].sort();

describe("public API surface", () => {
  it("exports exactly the frozen runtime whitelist", async () => {
    const ns = await import("@every-dagent/protocol");
    expect(Object.keys(ns).sort()).toEqual(RUNTIME_EXPORTS);
  });

  it("declares generation 1", () => {
    expect(PROTOCOL_VERSION).toBe("1");
  });

  it("pins the twelve operation names at the type level", () => {
    const pinned: Expect<
      Equal<
        OperationName,
        | "host.describe"
        | "sessions.list"
        | "sessions.create"
        | "sessions.get"
        | "runs.start"
        | "runs.get"
        | "runs.cancel"
        | "plugins.list"
        | "plugins.enable"
        | "plugins.disable"
        | "subscriptions.open"
        | "subscriptions.close"
      >
    > = true;
    expect(pinned).toBe(true);
  });

  it("pins the eight event type literals at the type level", () => {
    const pinned: Expect<
      Equal<
        HostEvent["type"],
        | "session.created"
        | "run.updated"
        | "run.output.delta"
        | "run.tool.call"
        | "run.tool.result"
        | "run.ended"
        | "plugin.updated"
        | "host.request.cancelled"
      >
    > = true;
    expect(pinned).toBe(true);
  });

  it("keeps a describe request free of hostInstanceId in the type", () => {
    const request = {
      kind: "client-request",
      protocolVersion: "1",
      requestId: "c-1",
      method: "host.describe",
      params: {
        supportedProtocolVersions: ["1"],
        client: { name: "c", version: "1" },
        capabilities: { reverseRequests: true },
      },
    } as const;
    const typed: ClientRequest = request;
    expect(typed.method).toBe("host.describe");
  });

  it("rejects a success response on the methodless error-only target at the type level", () => {
    const successResponse = {
      kind: "host-response",
      protocolVersion: "1",
      hostInstanceId: "host-1",
      requestId: "c-1",
      result: { ok: true },
    };
    // @ts-expect-error the methodless host-response target only takes {error}
    const failure = encodeFrame({ kind: "host-response" }, successResponse);
    expect(failure.success).toBe(false);
  });

  it("rejects an unknown method selector on a host-response target at the type level", () => {
    // @ts-expect-error "no.such.method" is not an OperationName
    const failure = validateMessage({ kind: "host-response", method: "no.such.method" }, {});
    expect(failure.success).toBe(false);
  });

  it("exposes the capability shapes as type-only exports", () => {
    const client: ClientCapabilities = { reverseRequests: true };
    const host: HostCapabilities = {
      sessions: true,
      runs: true,
      plugins: true,
      subscriptions: true,
      reverseRequests: true,
    };
    expect(client.reverseRequests).toBe(true);
    expect(host.sessions).toBe(true);
  });
});

describe("encodeFrame target/message correlation", () => {
  const listResponse: HostResponse<"sessions.list"> = {
    kind: "host-response",
    protocolVersion: "1",
    hostInstanceId: "host-1",
    requestId: "c-1",
    result: { sessions: [] },
  };

  it("encodes a correctly correlated host-response pair", () => {
    const ok = encodeFrame({ kind: "host-response", method: "sessions.list" }, listResponse);
    expect(ok.success).toBe(true);
    if (ok.success) expect(JSON.parse(ok.output)).toMatchObject({ kind: "host-response" });
  });

  it("rejects a mismatched target/message pair at the type level", () => {
    // @ts-expect-error a runs.get target cannot encode a sessions.list response
    const mismatched = encodeFrame({ kind: "host-response", method: "runs.get" }, listResponse);
    expect(mismatched.success).toBe(false);
  });

  it("requires narrowing a union target before encoding", () => {
    const unionTarget: { kind: "host-response"; method: OperationName } = {
      kind: "host-response",
      method: "sessions.list",
    };
    // @ts-expect-error a union target matches no per-method overload
    const untyped = encodeFrame(unionTarget, listResponse);
    expect(untyped.success).toBe(true);
  });
});
