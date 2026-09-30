/**
 * The binding's lifecycle and security bounds.
 *
 * What a deployment gets to assume, and what a caller gets told when something
 * goes wrong: authentication that fails without taking the process with it, a
 * capacity limit that cannot be walked around by declaring connections first,
 * an origin policy that is enforced rather than assumed, closes that are always
 * reported exactly once, and deadlines that are absolute.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { ProtocolChannel, ProtocolChannelListener } from "@every-dagent/protocol";

import { connectHttpChannel, startHttpBinding, type HttpBinding } from "../src/index.js";

import { createCredentials, openRawPeer, startBinding, waitUntil } from "./helpers/raw-peer.js";

const TRANSPORT_HEADER = "x-every-dagent-transport";

const open: { close(): Promise<void> }[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  }
});

function silence(): ProtocolChannelListener {
  return { onFrame: (): void => undefined, onClose: (): void => undefined };
}

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the probe server has no port");
  return address.port;
}

describe("authentication cannot take the process down", () => {
  it("refuses a token whose bytes differ even when its characters match", async () => {
    const { binding } = await startBinding();
    open.push(binding);
    const credentials = await createCredentials(binding.origin);

    // Same number of characters as the real token, different number of bytes:
    // exactly the case that would throw inside a byte-wise comparison.
    const forged = "é".repeat(credentials.token.length);
    const refused = await fetch(`${binding.origin}/connections/${credentials.connectionId}/events`, {
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(refused.status).toBe(401);
    // And the binding is still serving.
    const healthy = await fetch(`${binding.origin}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", [TRANSPORT_HEADER]: "1" },
      body: "{}",
    });
    expect(healthy.status).toBe(201);
  });
});

describe("capacity is reserved when it is claimed", () => {
  it("does not let declared connections exceed the established limit", async () => {
    const { binding, channels } = await startBinding({ limits: { maxConnections: 1, maxPending: 8 } });
    open.push(binding);

    const first = await createCredentials(binding.origin);
    const second = await createCredentials(binding.origin);

    const claimed = await fetch(`${binding.origin}/connections/${first.connectionId}/events`, {
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(claimed.status).toBe(200);
    const reader = claimed.body?.getReader();
    expect(reader).toBeDefined();
    await waitUntil(() => channels.length === 1, "the first connection to be attached");

    const refused = await fetch(`${binding.origin}/connections/${second.connectionId}/events`, {
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(refused.status).toBe(503);
    await reader?.cancel();
  });

  it("releases the slot when the connection ends", async () => {
    const { binding, channels } = await startBinding({ limits: { maxConnections: 1, maxPending: 8 } });
    open.push(binding);

    const first = await createCredentials(binding.origin);
    const claim = await fetch(`${binding.origin}/connections/${first.connectionId}/events`, {
      headers: { authorization: `Bearer ${first.token}` },
    });
    const reader = claim.body?.getReader();
    expect(reader).toBeDefined();
    await waitUntil(() => channels.length === 1, "the connection to be attached");
    await reader?.cancel();
    await waitUntil(() => binding.connections === 0, "the slot to be released");

    const second = await createCredentials(binding.origin);
    const claimed = await fetch(`${binding.origin}/connections/${second.connectionId}/events`, {
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(claimed.status).toBe(200);
    claimed.body?.cancel().catch(() => undefined);
  });
});

describe("the deployment policy is enforced", () => {
  it("refuses to listen anywhere but loopback", async () => {
    await expect(startHttpBinding({ onConnection: silence, address: "0.0.0.0" })).rejects.toThrow(/loopback only/);
  });

  it("accepts the binding's own origin without an allowlist", async () => {
    const { binding } = await startBinding();
    open.push(binding);

    const sameOrigin = await fetch(`${binding.origin}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", [TRANSPORT_HEADER]: "1", origin: binding.origin },
      body: "{}",
    });
    const elsewhere = await fetch(`${binding.origin}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", [TRANSPORT_HEADER]: "1", origin: "http://elsewhere.example" },
      body: "{}",
    });

    expect(sameOrigin.status).toBe(201);
    expect(elsewhere.status).toBe(403);
  });

  it("refuses an opaque origin", async () => {
    const { binding } = await startBinding({ originAllowlist: ["null"] });
    open.push(binding);

    const response = await fetch(`${binding.origin}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", [TRANSPORT_HEADER]: "1", origin: "null" },
      body: "{}",
    });

    expect(response.status).toBe(403);
  });

  it("answers a preflight only for an allowed origin", async () => {
    const { binding } = await startBinding({ originAllowlist: ["http://allowed.example"] });
    open.push(binding);

    const allowed = await fetch(`${binding.origin}/connections`, {
      method: "OPTIONS",
      headers: { origin: "http://allowed.example", "access-control-request-method": "POST" },
    });
    const refused = await fetch(`${binding.origin}/connections`, {
      method: "OPTIONS",
      headers: { origin: "http://elsewhere.example", "access-control-request-method": "POST" },
    });

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://allowed.example");
    expect(refused.status).toBe(403);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("a close that happened before anyone was listening", () => {
  it("is delivered when the client listens", async () => {
    const { binding } = await startBinding();
    open.push(binding);
    const channel = await connectHttpChannel({ origin: binding.origin });
    channel.send("anything");
    channel.close();

    const closed: number[] = [];
    channel.listen({
      onFrame: (): void => undefined,
      onClose: (): void => {
        closed.push(1);
      },
    });

    expect(closed).toHaveLength(1);
  });

  it("is delivered when the owner listens on the server side", async () => {
    const kept: ProtocolChannel[] = [];
    const { binding } = await startBinding({
      onConnection: (channel) => {
        kept.push(channel);
        // Deliberately not listening yet.
      },
    });
    open.push(binding);

    const peer = await openRawPeer(binding.origin);
    const channel = kept[0];
    expect(channel).toBeDefined();
    expect(peer.ended).toBe(false);

    peer.close();
    await waitUntil(() => binding.connections === 0, "the connection to end on the binding's side");

    const closed: number[] = [];
    channel?.listen({
      onFrame: (): void => undefined,
      onClose: (): void => {
        closed.push(1);
      },
    });

    expect(closed).toHaveLength(1);
  });
});

/**
 * A server that speaks the binding's three routes, so the client channel can be
 * pointed at behaviour a real binding would not produce — a stream that stalls,
 * a record that never ends, a POST that is never answered.
 */
interface ProbeServer {
  readonly origin: string;
  readonly requests: string[];
  readonly counter: { readonly posts: number; readonly postsAbandoned: number };
  stream: { write(chunk: string): void; end(): void } | undefined;
  onClaim?: (response: { write(chunk: string): void; end(): void }) => void;
  holdPosts?: boolean;
}

async function serveProbe(): Promise<ProbeServer> {
  const counts = { posts: 0, postsAbandoned: 0 };
  const state: {
    origin: string;
    requests: string[];
    stream: { write(chunk: string): void; end(): void } | undefined;
    onClaim?: (response: { write(chunk: string): void; end(): void }) => void;
    holdPosts?: boolean;
  } = { origin: "", requests: [], stream: undefined };

  const server = createServer((request, response) => {
    const url = request.url ?? "";
    state.requests.push(`${request.method ?? ""} ${url}`);

    if (request.method === "POST" && url === "/connections") {
      response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ connectionId: "probe", token: "probe-token" }));
      return;
    }
    if (request.method === "GET" && url.endsWith("/events")) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write(": ready\n\n");
      state.stream = response;
      state.onClaim?.(response);
      return;
    }
    if (request.method === "POST" && url.endsWith("/frames")) {
      counts.posts += 1;
      if (state.holdPosts === true) {
        request.on("close", () => {
          if (!response.writableEnded) counts.postsAbandoned += 1;
        });
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the probe server has no port");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests: state.requests,
    counter: counts,
    get stream(): { write(chunk: string): void; end(): void } | undefined {
      return state.stream;
    },
    set onClaim(handler: ((response: { write(chunk: string): void; end(): void }) => void) | undefined) {
      state.onClaim = handler;
    },
    get holdPosts(): boolean | undefined {
      return state.holdPosts;
    },
    set holdPosts(value: boolean | undefined) {
      state.holdPosts = value;
    },
  };
}

describe("deadlines are absolute", () => {
  it("fails a connection that never finishes establishing", async () => {
    // A server that accepts the request and never answers it.
    const port = await serve(() => undefined);
    const started = Date.now();

    await expect(
      connectHttpChannel({ origin: `http://127.0.0.1:${port}`, limits: { connectTimeoutMs: 200 } }),
    ).rejects.toThrow();

    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("ends a stream whose record never finishes, however slowly it arrives", async () => {
    const probe = await serveProbe();
    let dribble: ReturnType<typeof setInterval> | undefined;
    probe.onClaim = (response) => {
      // A record that keeps growing and never ends: more data lines, each one
      // terminated, and no blank line to finish the record. This is a record
      // arriving slowly, not an idle stream — and its deadline is still absolute.
      dribble = setInterval(() => {
        response.write('data: "still going\n');
      }, 20);
    };

    try {
      const channel = await connectHttpChannel({
        origin: probe.origin,
        limits: { recordTimeoutMs: 150, connectTimeoutMs: 2000 },
      });
      const closed: number[] = [];
      const frames: string[] = [];
      channel.listen({
        onFrame: (frame: string): void => {
          frames.push(frame);
        },
        onClose: (): void => {
          closed.push(1);
        },
      });

      await waitUntil(() => closed.length === 1, "the unfinished record to end the connection");
      // The record never became a frame: an unfinished record is never delivered.
      expect(frames).toEqual([]);
    } finally {
      if (dribble !== undefined) clearInterval(dribble);
    }
  });

  it("aborts an upstream request that is still in flight when the stream ends", async () => {
    const probe = await serveProbe();
    probe.holdPosts = true;

    const channel = await connectHttpChannel({ origin: probe.origin });
    channel.listen(silence());
    channel.send("in flight");

    await waitUntil(() => probe.counter.posts === 1, "the POST to start");
    probe.stream?.end();

    await waitUntil(() => probe.counter.postsAbandoned === 1, "the in-flight POST to be abandoned");
    expect(probe.counter.posts).toBe(1);
  });
});
