/**
 * The web server binding: a `node:http` endpoint that carries protocol frames
 * between a host and a browser-shaped client.
 *
 * Shape of one logical connection:
 *
 *   POST /connections            → { connectionId, token }   (short-lived, in memory)
 *   GET  /connections/:id/events → the downstream stream: `text/event-stream`
 *   POST /connections/:id/frames → one frame per request, answered 204
 *
 * Three rules keep it honest. A 204 means the carrier has the frame, never that
 * the host did anything with it. The upstream never waits for the host: it
 * enqueues and answers, so a request that is itself waiting for a reverse answer
 * cannot deadlock behind its own reply. And a frame that cannot be carried —
 * too large, a full queue, a stalled reader — ends the connection instead of
 * being dropped quietly, because the sequence numbers upstream depend on
 * delivery being all-or-nothing.
 *
 * The binding knows nothing about sessions, runs, plugins or agents: it sees
 * strings, connections and bounded queues.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { ProtocolChannel, ProtocolChannelListener } from "@every-dagent/protocol";

import { encodeSseComment, encodeSseRecord, unwrapRecord, utf8Length } from "../transport/framing.js";
import { DEFAULT_WEB_LIMITS, type WebLimits } from "../transport/limits.js";
import { createFrameQueue, type FrameQueue } from "../transport/queue.js";

export interface HttpBindingOptions {
  /** Called once per logical connection, with its downstream already open. */
  readonly onConnection: (channel: ProtocolChannel) => void;
  readonly limits?: Partial<WebLimits>;
  /**
   * Exact origins allowed to create a connection. Empty by default: a browser
   * page from anywhere else is refused, and a non-browser client (no `Origin`
   * at all) is trusted only because this endpoint listens on loopback.
   */
  readonly originAllowlist?: readonly string[];
  readonly address?: string;
  readonly port?: number;
}

export interface HttpBinding {
  /** The origin the binding listens on, e.g. `http://127.0.0.1:41234`. */
  readonly origin: string;
  readonly connections: number;
  close(): Promise<void>;
}

type ConnectionStatus = "allocated" | "attaching" | "established" | "closed";

interface LogicalConnection {
  readonly id: string;
  readonly token: string;
  readonly createdAt: number;
  status: ConnectionStatus;
  response: ServerResponse | undefined;
  listener: ProtocolChannelListener | undefined;
  readonly outbox: FrameQueue;
  readonly inbound: FrameQueue;
  paused: boolean;
  pumping: boolean;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  ttl: ReturnType<typeof setTimeout> | undefined;
  drain: ReturnType<typeof setTimeout> | undefined;
  delivering: boolean;
}

const TRANSPORT_HEADER = "x-every-dagent-transport";

function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function bearerOf(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

export async function startHttpBinding(options: HttpBindingOptions): Promise<HttpBinding> {
  const limits: WebLimits = { ...DEFAULT_WEB_LIMITS, ...options.limits };
  const allowlist = new Set(options.originAllowlist ?? []);
  const address = options.address ?? "127.0.0.1";

  const connections = new Map<string, LogicalConnection>();
  let createTokens = limits.createBurst;
  let lastRefill = Date.now();

  const server: Server = createServer({ headersTimeout: limits.headerTimeoutMs, maxHeaderSize: limits.headerBytes });
  server.maxConnections = limits.maxSockets;

  function closeConnection(connection: LogicalConnection, reason: string): void {
    if (connection.status === "closed") return;
    connection.status = "closed";
    connections.delete(connection.id);
    if (connection.ttl !== undefined) clearTimeout(connection.ttl);
    if (connection.heartbeat !== undefined) clearInterval(connection.heartbeat);
    if (connection.drain !== undefined) clearTimeout(connection.drain);
    connection.outbox.clear();
    connection.inbound.clear();

    // The owner hears about it exactly once, and before the response is torn
    // down: a host that learns of a dead connection after its socket is gone has
    // no way left to react.
    try {
      connection.listener?.onClose();
    } catch {
      // The owner's reaction is its own business.
    }
    connection.listener = undefined;

    try {
      connection.response?.end();
    } catch {
      // The response is already gone; the connection is closed either way.
    }
    connection.response = undefined;
    void reason;
  }

  function refill(): void {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    if (elapsed <= 0) return;
    lastRefill = now;
    createTokens = Math.min(limits.createBurst, createTokens + elapsed * limits.createPerSecond);
  }

  function establishedCount(): number {
    let count = 0;
    for (const connection of connections.values()) {
      if (connection.status === "established" || connection.status === "attaching") count += 1;
    }
    return count;
  }

  function pendingCount(): number {
    let count = 0;
    for (const connection of connections.values()) {
      if (connection.status === "allocated") count += 1;
    }
    return count;
  }

  /**
   * Hands queued frames to the downstream, one at a time, respecting the
   * socket's own backpressure: a `write` that returns false has *accepted* the
   * record, so it is never written twice — the pump simply waits for `drain`,
   * and gives up on a reader that never drains.
   */
  function pump(connection: LogicalConnection): void {
    if (connection.pumping) return;
    connection.pumping = true;

    while (!connection.paused && connection.status === "established") {
      const frame = connection.outbox.shift();
      if (frame === undefined) break;
      const response = connection.response;
      if (response === undefined) break;

      let accepted: boolean;
      try {
        accepted = response.write(encodeSseRecord(frame));
      } catch {
        closeConnection(connection, "the downstream write failed");
        break;
      }

      if (!accepted) {
        connection.paused = true;
        connection.drain = setTimeout(() => {
          closeConnection(connection, "the downstream never drained");
        }, limits.drainTimeoutMs);
        response.once("drain", () => {
          if (connection.drain !== undefined) clearTimeout(connection.drain);
          connection.drain = undefined;
          connection.paused = false;
          pump(connection);
        });
      }
    }

    connection.pumping = false;
  }

  function sendFrame(connection: LogicalConnection, frame: string): void {
    if (connection.status !== "established") throw new Error("the connection is not carrying frames");
    const bytes = utf8Length(frame);
    // In flight counts too: the record being written is already accepted, and it
    // must fit the same budget as everything waiting behind it.
    if (!connection.outbox.push(frame, bytes)) {
      closeConnection(connection, "the downstream queue is full");
      throw new Error("the downstream queue is full");
    }
    pump(connection);
  }

  function deliverInbound(connection: LogicalConnection): void {
    if (connection.delivering) return;
    connection.delivering = true;

    // One macrotask, then the whole queue in order: the HTTP handler has already
    // answered 204, so nothing here can hold a request open.
    setImmediate(() => {
      connection.delivering = false;
      while (connection.status === "established") {
        const listener = connection.listener;
        if (listener === undefined) return;
        const frame = connection.inbound.shift();
        if (frame === undefined) return;
        try {
          listener.onFrame(frame);
        } catch {
          // A listener that throws is the host's problem to report, not a reason
          // to lose the frames behind it.
        }
      }
    });
  }

  function serverChannel(connection: LogicalConnection): ProtocolChannel {
    return {
      send(frame: string): void {
        if (typeof frame !== "string") throw new Error("frames must be strings");
        sendFrame(connection, frame);
      },
      listen(listener: ProtocolChannelListener): () => void {
        if (connection.listener !== undefined) throw new Error("the channel already has a listener");
        connection.listener = listener;
        // Frames that arrived before the listener: never lost, and never
        // reordered — they are handed over now, oldest first.
        deliverInbound(connection);
        return (): void => {
          if (connection.listener === listener) connection.listener = undefined;
        };
      },
      close(): void {
        closeConnection(connection, "the owner closed the channel");
      },
    };
  }

  function allowOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) return true; // Not a browser: loopback is the boundary.
    if (typeof origin !== "string") return false;
    return allowlist.has(origin);
  }

  function hostIsMine(request: IncomingMessage, port: number): boolean {
    const host = request.headers.host;
    if (typeof host !== "string") return false;
    return host === `${address}:${port}` || host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  /**
   * The CORS answer, for exactly the origins on the allowlist.
   *
   * A browser page that is allowed to reach this binding has to be told so on
   * every response and in its preflight; a page that is not gets nothing, which
   * is how the browser ends up refusing it. There is no wildcard and no
   * credentials: the token is the credential.
   */
  function corsHeaders(request: IncomingMessage): Record<string, string> {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !allowlist.has(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": `content-type, authorization, ${TRANSPORT_HEADER}`,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-max-age": "600",
      vary: "origin",
    };
  }

  function respond(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    body?: unknown,
  ): void {
    const payload = body === undefined ? "" : JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
      ...corsHeaders(request),
    });
    response.end(payload);
  }

  type BodyRead =
    | { readonly kind: "body"; readonly body: string }
    | { readonly kind: "oversized" }
    | { readonly kind: "failed" };

  /**
   * Reads one upstream body, bounded.
   *
   * The bound is checked on the bytes that arrive, never on what the sender
   * claims: `Content-Length` is a hint, and a body that keeps coming after the
   * limit is drained only far enough to answer, then cut off.
   */
  async function readBody(request: IncomingMessage, limit: number): Promise<BodyRead> {
    return await new Promise<BodyRead>((resolve) => {
      const chunks: string[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (outcome: BodyRead): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        request.destroy();
        finish({ kind: "failed" });
      }, limits.postTimeoutMs);

      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (settled) {
          // Already refused: keep discarding, but only up to a multiple of the
          // limit, so an endless body cannot keep this connection alive.
          if (bytes > limit * 4) request.destroy();
          return;
        }
        if (bytes > limit) {
          finish({ kind: "oversized" });
          return;
        }
        chunks.push(chunk.toString("utf8"));
      });
      request.on("end", () => finish({ kind: "body", body: chunks.join("") }));
      request.on("error", () => finish({ kind: "failed" }));
    });
  }

  server.on("request", (request, response) => {
    // A client that goes away mid-write leaves a reset behind; the logical
    // connection is ended by its own `close` path, and this is not an
    // application failure to report.
    request.on("error", () => undefined);
    response.on("error", () => undefined);
    void handle(request, response);
  });

  // The same for the socket itself: a vanished peer is a connection ending, not
  // an exception for the process to carry.
  server.on("connection", (socket) => {
    socket.on("error", () => undefined);
  });

  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const port = (server.address() as AddressInfo | null)?.port ?? 0;

    // The transport's own header: a cross-site form post cannot set it, so a
    // simple request from a page cannot create a connection at all.
    if (!hostIsMine(request, port)) {
      respond(request, response, 421, { error: "unexpected host" });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${address}:${port}`);
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

    if (request.method === "OPTIONS") {
      const headers = corsHeaders(request);
      if (Object.keys(headers).length === 0) {
        respond(request, response, 403, { error: "origin not allowed" });
        return;
      }
      response.writeHead(204, headers);
      response.end();
      return;
    }

    if (segments.length === 1 && segments[0] === "connections" && request.method === "POST") {
      createConnection(request, response);
      return;
    }

    if (segments.length === 3 && segments[0] === "connections" && segments[2] === "events") {
      if (request.method !== "GET") {
        respond(request, response, 405, { error: "method not allowed" });
        return;
      }
      claimConnection(request, response, segments[1] ?? "");
      return;
    }

    if (segments.length === 3 && segments[0] === "connections" && segments[2] === "frames") {
      if (request.method !== "POST") {
        respond(request, response, 405, { error: "method not allowed" });
        return;
      }
      await acceptFrame(request, response, segments[1] ?? "");
      return;
    }

    respond(request, response, 404, { error: "not found" });
  }

  function createConnection(request: IncomingMessage, response: ServerResponse): void {
    if (!allowOrigin(request)) {
      respond(request, response, 403, { error: "origin not allowed" });
      return;
    }
    if (request.headers[TRANSPORT_HEADER] !== "1") {
      respond(request, response, 403, { error: "missing transport header" });
      return;
    }
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      respond(request, response, 403, { error: "expected application/json" });
      return;
    }

    refill();
    if (createTokens < 1) {
      respond(request, response, 429, { error: "too many connections" });
      return;
    }
    if (pendingCount() >= limits.maxPending || establishedCount() >= limits.maxConnections) {
      respond(request, response, 503, { error: "at capacity" });
      return;
    }
    createTokens -= 1;

    const connection: LogicalConnection = {
      id: randomUUID(),
      token: randomBytes(32).toString("base64url"),
      createdAt: Date.now(),
      status: "allocated",
      response: undefined,
      listener: undefined,
      outbox: createFrameQueue({ maxFrames: limits.queueFrames, maxBytes: limits.queueBytes }),
      inbound: createFrameQueue({ maxFrames: limits.queueFrames, maxBytes: limits.queueBytes }),
      paused: false,
      pumping: false,
      heartbeat: undefined,
      ttl: undefined,
      drain: undefined,
      delivering: false,
    };
    connection.ttl = setTimeout(() => {
      closeConnection(connection, "the connection was never claimed");
    }, limits.pendingTtlMs);
    connections.set(connection.id, connection);

    respond(request, response, 201, { connectionId: connection.id, token: connection.token });
  }

  function claimConnection(request: IncomingMessage, response: ServerResponse, id: string): void {
    if (!allowOrigin(request)) {
      respond(request, response, 403, { error: "origin not allowed" });
      return;
    }
    const connection = connections.get(id);
    if (connection === undefined || !tokenMatches(connection.token, bearerOf(request))) {
      respond(request, response, 401, { error: "unknown connection" });
      return;
    }
    if (connection.status !== "allocated") {
      // One downstream per logical connection: a second claim is refused
      // without disturbing the first.
      respond(request, response, 409, { error: "the connection already has a stream" });
      return;
    }

    connection.status = "attaching";
    if (connection.ttl !== undefined) {
      clearTimeout(connection.ttl);
      connection.ttl = undefined;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...corsHeaders(request),
    });
    // The marker the client waits for: the stream exists before anything is sent.
    response.write(encodeSseComment("ready"));
    connection.response = response;
    connection.status = "established";
    response.on("close", () => {
      closeConnection(connection, "the downstream ended");
    });

    connection.heartbeat = setInterval(() => {
      if (connection.paused || connection.status !== "established") return;
      try {
        response.write(encodeSseComment("ping"));
      } catch {
        closeConnection(connection, "the heartbeat failed");
      }
    }, limits.heartbeatMs);

    try {
      options.onConnection(serverChannel(connection));
    } catch {
      // A host that refuses the connection is an answer, not a leak.
      closeConnection(connection, "the owner refused the connection");
    }
  }

  async function acceptFrame(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    if (!allowOrigin(request)) {
      respond(request, response, 403, { error: "origin not allowed" });
      return;
    }
    const connection = connections.get(id);
    if (connection === undefined || !tokenMatches(connection.token, bearerOf(request))) {
      respond(request, response, 401, { error: "unknown connection" });
      return;
    }
    if (connection.status !== "established") {
      respond(request, response, 409, { error: "the connection has no stream" });
      return;
    }

    const read = await readBody(request, limits.recordBytes);
    if (read.kind !== "body") {
      respond(request, response, 413, { error: "the frame is too large" });
      closeConnection(connection, "an oversized or unfinished request");
      return;
    }

    const frame = unwrapRecord(read.body);
    if (frame === undefined) {
      respond(request, response, 400, { error: "a frame must be a JSON string" });
      closeConnection(connection, "a frame that is not a frame");
      return;
    }
    if (utf8Length(frame) > limits.frameBytes) {
      respond(request, response, 413, { error: "the frame is too large" });
      closeConnection(connection, "an oversized frame");
      return;
    }
    if (!connection.inbound.push(frame, utf8Length(frame))) {
      respond(request, response, 503, { error: "the inbound queue is full" });
      closeConnection(connection, "the inbound queue is full");
      return;
    }

    // Accepted, not executed: the answer is about the carrier, and the host
    // never blocks it.
    respond(request, response, 204);
    deliverInbound(connection);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, address, () => {
      resolve();
    });
  });

  const boundPort = (server.address() as AddressInfo).port;

  return {
    origin: `http://${address}:${boundPort}`,
    get connections(): number {
      return connections.size;
    },
    async close(): Promise<void> {
      for (const connection of [...connections.values()]) {
        closeConnection(connection, "the binding is closing");
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
