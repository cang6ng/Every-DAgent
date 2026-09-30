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
   * Exact origins allowed to create a connection, on top of the binding's own
   * origin. A browser page from anywhere else is refused; a non-browser client
   * (no `Origin` at all) is trusted only because this endpoint listens on
   * loopback and only ever answers a loopback peer.
   */
  readonly originAllowlist?: readonly string[];
  /** The loopback address to listen on. Anything else is refused. */
  readonly address?: string;
  readonly port?: number;
}

/** Whether an address is loopback; anything else would be reachable off the machine. */
function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "localhost" || address === "::1";
}

/** Whether a peer address is loopback, in the spellings Node reports. */
function isLoopbackPeer(remote: string | undefined): boolean {
  if (remote === undefined) return false;
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1" ||
    remote.startsWith("127.")
  );
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
  /** Whether the one close this connection will ever report has been handed to its owner. */
  closeDelivered: boolean;
  /** Whether a close is owed to an owner that was not listening when it happened. */
  closeOwed: boolean;
  paused: boolean;
  /** Bytes of a record the socket accepted but has not flushed yet. */
  inFlightBytes: number;
  pumping: boolean;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  ttl: ReturnType<typeof setTimeout> | undefined;
  drain: ReturnType<typeof setTimeout> | undefined;
  delivering: boolean;
}

const TRANSPORT_HEADER = "x-every-dagent-transport";

/**
 * Compares one presented token with the one this connection was created with.
 *
 * The comparison is on bytes, and it is length-checked on bytes: two strings of
 * the same length in JavaScript can be different lengths in UTF-8, and
 * `timingSafeEqual` throws on that — which must stay a failed authentication
 * rather than an exception that takes the process down.
 */
function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  if (expectedBytes.length !== providedBytes.length) return false;
  try {
    return timingSafeEqual(expectedBytes, providedBytes);
  } catch {
    return false;
  }
}

function bearerOf(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

export async function startHttpBinding(options: HttpBindingOptions): Promise<HttpBinding> {
  const limits: WebLimits = { ...DEFAULT_WEB_LIMITS, ...options.limits };
  const address = options.address ?? "127.0.0.1";
  if (!isLoopbackAddress(address)) {
    // A binding that could be reached from another machine is a different
    // security proposition, and v1 does not pretend to make it.
    throw new Error("the web binding listens on loopback only");
  }
  const allowlist = new Set(options.originAllowlist ?? []);

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
    // no way left to react. A connection that ended before its owner listened
    // hands the close over when it does.
    deliverClose(connection);

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
   * Writes one record, and owns the backpressure that follows.
   *
   * Every downstream write goes through here — data, the ready marker, the
   * heartbeat — so a socket that stops accepting pauses all of them, not just
   * the busiest one. A `write` that returns false has *accepted* the record, so
   * it is never written twice: the pump waits for `drain`, and gives up on a
   * reader that never drains.
   */
  function writeRecord(connection: LogicalConnection, record: string, bytes: number): void {
    const response = connection.response;
    if (response === undefined || connection.status !== "established") return;
    if (connection.paused) return;

    let accepted: boolean;
    try {
      accepted = response.write(record);
    } catch {
      closeConnection(connection, "the downstream write failed");
      return;
    }
    if (accepted) return;

    // The record is already accepted by the socket, and it stays on the books
    // until the socket drains: the budget covers what is queued *and* in flight.
    connection.paused = true;
    connection.inFlightBytes += bytes;
    connection.drain = setTimeout(() => {
      closeConnection(connection, "the downstream never drained");
    }, limits.drainTimeoutMs);
    response.once("drain", () => {
      if (connection.drain !== undefined) clearTimeout(connection.drain);
      connection.drain = undefined;
      connection.paused = false;
      connection.inFlightBytes -= bytes;
      pump(connection);
    });
  }

  /** Hands queued frames to the downstream, one at a time, through the one write path. */
  function pump(connection: LogicalConnection): void {
    if (connection.pumping) return;
    connection.pumping = true;

    while (!connection.paused && connection.status === "established") {
      const frame = connection.outbox.shift();
      if (frame === undefined) break;
      const record = encodeSseRecord(frame);
      const bytes = utf8Length(record);
      if (bytes > limits.recordBytes) {
        closeConnection(connection, "a record does not fit the binding's limit");
        break;
      }
      writeRecord(connection, record, bytes);
    }

    connection.pumping = false;
  }

  function sendFrame(connection: LogicalConnection, frame: string): void {
    if (connection.status !== "established") throw new Error("the connection is not carrying frames");
    const bytes = utf8Length(frame);
    if (bytes > limits.frameBytes) {
      // A frame the binding cannot carry is a connection it cannot serve, and
      // saying so here is the only honest answer: truncating it would change
      // what the protocol sees.
      closeConnection(connection, "a frame does not fit the binding's limit");
      throw new Error("a frame does not fit the binding's limit");
    }
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
        // A connection that ended before this listener existed still owes it the
        // one close it will ever get.
        if (connection.closeOwed || connection.closeDelivered) {
          deliverClose(connection);
          return (): void => {
            if (connection.listener === listener) connection.listener = undefined;
          };
        }
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

  /**
   * Hands the one close to the owner, now or when it starts listening.
   *
   * A connection that ended before anyone was listening is not a connection
   * whose close can be skipped: the owner would be holding a channel that looks
   * alive and never tells it otherwise.
   */
  function deliverClose(connection: LogicalConnection): void {
    if (connection.closeDelivered) return;
    const listener = connection.listener;
    if (listener === undefined) {
      connection.closeOwed = true;
      return;
    }
    connection.closeDelivered = true;
    try {
      listener.onClose();
    } catch {
      // The owner's reaction is its own business.
    }
  }

  /**
   * Whether this request may act on the binding, judged by its `Origin`.
   *
   * A page is allowed when it comes from the binding's own origin or from the
   * configured allowlist — exact matches, never a suffix or a wildcard. An
   * opaque origin (`null`) is refused outright: it is what a sandboxed or
   * `data:` document has, and it is not a deployment this binding serves. A
   * request with no `Origin` at all is not a browser, and the loopback peer
   * check is what stands behind it.
   */
  function allowOrigin(request: IncomingMessage, port: number): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    if (typeof origin !== "string" || origin === "null") return false;
    if (allowlist.has(origin)) return true;
    return origin === `http://${address}:${port}` || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
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
  function corsHeaders(request: IncomingMessage, port: number): Record<string, string> {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !allowOrigin(request, port)) return {};
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
    const port = (server.address() as AddressInfo | null)?.port ?? 0;
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
      ...corsHeaders(request, port),
    });
    response.end(payload);
  }

  type BodyRead =
    | { readonly kind: "body"; readonly body: string }
    | { readonly kind: "oversized" }
    | { readonly kind: "malformed" }
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
      // One decoder across the whole body: a frame's bytes may be split anywhere,
      // and decoding each chunk on its own would corrupt any multi-byte
      // character that straddles a boundary. Invalid UTF-8 is refused rather
      // than replaced with something the sender never wrote.
      const decoder = new TextDecoder("utf-8", { fatal: true });
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
        try {
          chunks.push(decoder.decode(chunk, { stream: true }));
        } catch {
          finish({ kind: "malformed" });
        }
      });
      request.on("end", () => {
        if (settled) return;
        try {
          chunks.push(decoder.decode());
        } catch {
          finish({ kind: "malformed" });
          return;
        }
        finish({ kind: "body", body: chunks.join("") });
      });
      request.on("error", () => finish({ kind: "failed" }));
    });
  }

  server.on("request", (request, response) => {
    // A client that goes away mid-write leaves a reset behind; the logical
    // connection is ended by its own `close` path, and this is not an
    // application failure to report.
    request.on("error", () => undefined);
    response.on("error", () => undefined);
    void handle(request, response).catch(() => {
      // One request failing is one request: it ends safely, and the binding
      // keeps serving. Nothing about the failure travels back to the caller.
      try {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }
        response.end();
      } catch {
        // The response is already gone; there is nothing left to end.
      }
    });
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
    if (!isLoopbackPeer(request.socket.remoteAddress)) {
      // Listening on loopback is not the same as answering only loopback.
      respond(request, response, 403, { error: "loopback only" });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${address}:${port}`);
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

    if (request.method === "OPTIONS") {
      const headers = corsHeaders(request, port);
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
    const port = (server.address() as AddressInfo | null)?.port ?? 0;
    if (!allowOrigin(request, port)) {
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
      closeDelivered: false,
      closeOwed: false,
      paused: false,
      inFlightBytes: 0,
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
    const port = (server.address() as AddressInfo | null)?.port ?? 0;
    if (!allowOrigin(request, port)) {
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
    if (establishedCount() >= limits.maxConnections) {
      // Declared but unclaimed connections do not hold a slot; claiming one does.
      // The check and the move happen together, so two claims cannot both pass.
      respond(request, response, 503, { error: "at capacity" });
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
      ...corsHeaders(request, port),
    });
    connection.response = response;
    connection.status = "established";
    // The marker the client waits for: the stream exists before anything is
    // sent — and it obeys the same backpressure as everything else.
    const ready = encodeSseComment("ready");
    writeRecord(connection, ready, utf8Length(ready));
    response.on("close", () => {
      closeConnection(connection, "the downstream ended");
    });

    connection.heartbeat = setInterval(() => {
      if (connection.status !== "established") return;
      // A heartbeat that skipped the write path would be a second, unbounded way
      // to write to a socket that has already stopped accepting.
      const ping = encodeSseComment("ping");
      writeRecord(connection, ping, utf8Length(ping));
    }, limits.heartbeatMs);

    try {
      options.onConnection(serverChannel(connection));
    } catch {
      // A host that refuses the connection is an answer, not a leak.
      closeConnection(connection, "the owner refused the connection");
    }
  }

  async function acceptFrame(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const port = (server.address() as AddressInfo | null)?.port ?? 0;
    if (!allowOrigin(request, port)) {
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
    if (read.kind === "malformed") {
      respond(request, response, 400, { error: "the body is not valid UTF-8" });
      closeConnection(connection, "a body that is not valid UTF-8");
      return;
    }
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
