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

import { connectHttpChannel, startHttpBinding, utf8Length, wrapFrame, type HttpBinding } from "../src/index.js";

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

/** Lets real time pass: these tests are about clocks, not about promises. */
async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
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

  it("treats another spelling of loopback as another origin", async () => {
    const { binding } = await startBinding();
    open.push(binding);
    const port = new URL(binding.origin).port;

    const create = (origin: string): Promise<Response> =>
      fetch(`${binding.origin}/connections`, {
        method: "POST",
        headers: { "content-type": "application/json", [TRANSPORT_HEADER]: "1", origin },
        body: "{}",
      });

    // Same scheme, same host, same port: this binding's own origin.
    expect((await create(binding.origin)).status).toBe(201);
    // `localhost` and `127.0.0.1` are different origins to a browser, and a page
    // that the binding never named does not become same-origin by spelling the
    // same address differently.
    expect((await create(`http://localhost:${port}`)).status).toBe(403);
    // A different port is a different origin, whatever the host says.
    expect((await create(`http://127.0.0.1:${Number(port) + 1}`)).status).toBe(403);
    // So is a different scheme.
    expect((await create(`https://127.0.0.1:${port}`)).status).toBe(403);
  });

  it("refuses a value that is a URL rather than an origin", async () => {
    const { binding } = await startBinding();
    open.push(binding);
    const port = new URL(binding.origin).port;

    const create = (origin: string): Promise<Response> =>
      fetch(`${binding.origin}/connections`, {
        method: "POST",
        headers: { "content-type": "application/json", [TRANSPORT_HEADER]: "1", origin },
        body: "{}",
      });

    // Every one of these serialises to this binding's own origin, and not one of
    // them is an origin: a browser's `Origin` is a scheme, a host and a port,
    // and nothing else. A value that has to be shortened before it matches is a
    // URL wearing this origin's prefix.
    const urls = [
      `${binding.origin}/`,
      `${binding.origin}/path`,
      `${binding.origin}/../connections`,
      `${binding.origin}?query=1`,
      `${binding.origin}#fragment`,
      `http://user:pass@127.0.0.1:${port}`,
      `http://user@127.0.0.1:${port}`,
      `HTTP://127.0.0.1:${port}`,
    ];
    for (const origin of urls) {
      expect((await create(origin)).status, origin).toBe(403);
    }

    // And the binding's own origin is still the origin it admits.
    expect((await create(binding.origin)).status).toBe(201);
  });

  it("admits another origin only when it is on the allowlist", async () => {
    const { binding } = await startBinding({ originAllowlist: ["http://localhost:1234"] });
    open.push(binding);

    const response = await fetch(`${binding.origin}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", [TRANSPORT_HEADER]: "1", origin: "http://localhost:1234" },
      body: "{}",
    });

    expect(response.status).toBe(201);
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

  /**
   * The delays of the timers that are still scheduled when `run` returns.
   *
   * `setTimeout` is patched for the length of the attempt, so a deadline that
   * nobody stopped is still on the books when the attempt is over — which is the
   * only way to see a timer that nothing waits on any more. A timer that fires
   * in the meantime takes itself off.
   */
  async function clocksLeftBehind(run: () => Promise<void>): Promise<number[]> {
    const live = new Map<ReturnType<typeof setTimeout>, number>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;

    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const entry: { handle: ReturnType<typeof setTimeout> | undefined } = { handle: undefined };
      const wrapped = (...inner: unknown[]): void => {
        if (entry.handle !== undefined) live.delete(entry.handle);
        handler(...inner);
      };
      entry.handle = realSet(wrapped, delay, ...args);
      live.set(entry.handle, delay ?? 0);
      return entry.handle;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
      if (handle !== undefined) live.delete(handle);
      return realClear(handle as never);
    }) as typeof globalThis.clearTimeout;

    try {
      await run();
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
    return [...live.values()];
  }

  it("stops the establishment clock however the attempt ends", async () => {
    // Every way an establishment can end, with a budget that is its own: a
    // refused create, a create that answers with something that is not a
    // connection, a server that never answers at all, and one that works. None
    // of them may leave the attempt's deadline scheduled.
    const budget = 700;

    const refusedPort = await serve((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end("{}");
    });
    const malformedPort = await serve((_request, response) => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end("{}");
    });
    const silentPort = await serve(() => undefined);
    const { binding, channels } = await startBinding();
    open.push(binding);

    const failures: { readonly what: string; readonly message: string; readonly left: number[] }[] = [];
    for (const [what, origin] of [
      ["a refused create", `http://127.0.0.1:${refusedPort}`],
      ["a create that describes nothing", `http://127.0.0.1:${malformedPort}`],
      ["a server that never answers", `http://127.0.0.1:${silentPort}`],
    ] as const) {
      let thrown: unknown;
      const left = await clocksLeftBehind(async () => {
        thrown = await connectHttpChannel({ origin, limits: { connectTimeoutMs: budget } }).catch(
          (error: unknown) => error,
        );
      });
      failures.push({ what, message: thrown instanceof Error ? thrown.message : String(thrown), left });
    }

    expect(failures[0]?.message).toContain("503");
    expect(failures[1]?.message).toContain("did not describe");
    expect(failures[2]?.message).not.toBe("");
    for (const failure of failures) {
      expect(failure.left, `${failure.what} left a deadline behind`).not.toContain(budget);
    }

    // And the attempt that succeeds: the clock it started on ends with the
    // attempt, not later, and the connection it established is unaffected by it.
    let channel: ProtocolChannel | undefined;
    const connected = await clocksLeftBehind(async () => {
      channel = await connectHttpChannel({ origin: binding.origin, limits: { connectTimeoutMs: budget } });
    });
    expect(connected).not.toContain(budget);

    const received: string[] = [];
    let closed = 0;
    await waitUntil(() => channels.length === 1, "the host side to attach");
    channels[0]?.listen({ onFrame: (frame: string) => received.push(frame), onClose: () => (closed += 1) });
    try {
      // Past the budget the attempt started with: the deadline was stopped with
      // the attempt, so the connection it established is still carrying frames.
      await wait(budget + 100);
      channel?.send("still here");
      await waitUntil(() => received.length === 1, "the frame to arrive");
      expect(received).toEqual(["still here"]);
      expect(closed).toBe(0);
    } finally {
      channel?.close();
    }
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

  it("gives every stage of establishing a connection the same budget", async () => {
    // Each stage stalls in its own way. The create is never answered, the body
    // never finishes, the stream's headers never arrive, and the stream opens
    // and then says nothing — and all four draw on one deadline, measured from
    // the moment the connector started. A stage that begins with a moment of it
    // left does not buy a fresh one: `pendingTtlMs` is the binding's own number
    // for how long an unclaimed connection may wait, not a second client clock.
    const stages = ["create", "body", "headers", "first byte"] as const;
    for (const stage of stages) {
      const port = await serve((request, response) => {
        if (request.url === "/connections") {
          if (stage === "create") return;
          response.writeHead(201, { "content-type": "application/json" });
          if (stage === "body") {
            response.write("{");
            return;
          }
          response.end(JSON.stringify({ connectionId: "probe", token: "probe-token" }));
          return;
        }
        if (stage === "headers") return;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
      });

      const started = Date.now();
      await expect(
        connectHttpChannel({
          origin: `http://127.0.0.1:${port}`,
          limits: { connectTimeoutMs: 150, pendingTtlMs: 5000 },
        }),
      ).rejects.toThrow();
      expect(Date.now() - started, `${stage} took longer than the one budget`).toBeLessThan(1500);
    }
  });

  it("gives a record that begins where another ended a deadline of its own", async () => {
    const probe = await serveProbe();
    const channel = await connectHttpChannel({ origin: probe.origin, limits: { recordTimeoutMs: 400 } });
    const frames: string[] = [];
    const closed: number[] = [];
    channel.listen({
      onFrame: (frame: string): void => {
        frames.push(frame);
      },
      onClose: (): void => {
        closed.push(1);
      },
    });

    try {
      probe.stream?.write('data: "old');
      // Just before the first record's deadline, one chunk finishes it and
      // starts the next one. The next record is not the first one's heir: it
      // gets the whole budget, not what was left of its predecessor's clock.
      await wait(300);
      probe.stream?.write('"\n\ndata: "new');
      await wait(200);

      expect(closed, "the new record inherited the old one's deadline").toEqual([]);

      // And nothing else arrives. The deadline the second record owns is a
      // live one: a record that only ever saw its predecessor's clock would sit
      // there with no deadline at all, which is the same as having none.
      await waitUntil(() => closed.length === 1, "the new record's own deadline");
      expect(frames).toEqual(["old"]);
    } finally {
      channel.close();
    }
  });

  it("clears a record's deadline when it finishes, and starts a fresh one next", async () => {
    const probe = await serveProbe();
    const channel = await connectHttpChannel({ origin: probe.origin, limits: { recordTimeoutMs: 250 } });
    const frames: string[] = [];
    const closed: number[] = [];
    channel.listen({
      onFrame: (frame: string): void => {
        frames.push(frame);
      },
      onClose: (): void => {
        closed.push(1);
      },
    });

    try {
      probe.stream?.write('data: "old');
      await wait(80);
      probe.stream?.write('"\n\n');
      // Well past the first record's deadline, which went with the record.
      await wait(400);
      expect(closed).toEqual([]);

      probe.stream?.write('data: "next');
      await waitUntil(() => closed.length === 1, "the next record's own deadline");
      expect(frames).toEqual(["old"]);
    } finally {
      channel.close();
    }
  });

  it("ends a record that holds nothing but comments, however often it talks", async () => {
    const probe = await serveProbe();
    const channel = await connectHttpChannel({ origin: probe.origin, limits: { recordTimeoutMs: 200 } });
    const frames: string[] = [];
    const closed: number[] = [];
    channel.listen({
      onFrame: (frame: string): void => {
        frames.push(frame);
      },
      onClose: (): void => {
        closed.push(1);
      },
    });
    // A record with no data field is still a record, and its deadline is not an
    // idle timeout: talking to it does not keep it alive.
    const dribble = setInterval(() => {
      probe.stream?.write(": next\n");
    }, 30);
    probe.stream?.write(": still open\n");

    try {
      await waitUntil(() => closed.length === 1, "the comment-only record to hit its deadline");
      expect(frames).toEqual([]);
    } finally {
      clearInterval(dribble);
      channel.close();
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

describe("the upstream budget counts what the connection still owes", () => {
  it("counts the POST that is on the wire but unanswered", async () => {
    const probe = await serveProbe();
    probe.holdPosts = true;
    const channel = await connectHttpChannel({ origin: probe.origin, limits: { queueFrames: 2 } });
    channel.listen(silence());

    try {
      channel.send("1");
      await waitUntil(() => probe.counter.posts === 1, "the first POST to be sent");
      // One frame is in the POST and one is waiting: the budget of two is
      // spent, and a third frame is not admitted just because the queue looks
      // empty.
      channel.send("2");
      expect(() => {
        channel.send("3");
      }).toThrow(/queue is full/);
    } finally {
      channel.close();
    }
  });

  it("charges the record the transport actually sends, not the frame it wraps", async () => {
    const probe = await serveProbe();
    probe.holdPosts = true;
    const channel = await connectHttpChannel({ origin: probe.origin, limits: { queueBytes: 8 } });
    channel.listen(silence());

    try {
      // Two bytes of frame, fourteen bytes once the wrapper escapes them: the
      // transport carries the wrapper, so the wrapper is what the budget pays
      // for.
      expect(utf8Length("\u0000\u0000")).toBe(2);
      expect(utf8Length(wrapFrame("\u0000\u0000"))).toBe(14);
      expect(() => {
        channel.send("\u0000\u0000");
      }).toThrow(/queue is full/);
    } finally {
      channel.close();
    }
  });

  it("refuses a frame whose record does not fit the record limit", async () => {
    const probe = await serveProbe();
    probe.holdPosts = true;
    const channel = await connectHttpChannel({ origin: probe.origin, limits: { recordBytes: 8 } });
    channel.listen(silence());

    try {
      // A two-byte frame that becomes a fourteen-byte record is a record the
      // binding would refuse on its way in; refusing it here is the difference
      // between "not sent" and "lost".
      expect(() => {
        channel.send("\u0000\u0000");
      }).toThrow(/record does not fit/);
      expect(probe.counter.posts).toBe(0);
    } finally {
      channel.close();
    }
  });
});
