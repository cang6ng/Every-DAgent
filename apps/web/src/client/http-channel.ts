/**
 * The client half of the web binding: `fetch` for the upstream, a streamed SSE
 * response for the downstream, and nothing in between.
 *
 * This module is browser-safe on purpose — it uses only `fetch`, `AbortController`
 * and the web streams API, all of which Node also has — so the same code is what
 * a page would run. It never retries: a POST that fails, an SSE stream that ends,
 * a record that never finishes — each of them ends the whole logical connection,
 * and it is the client *core* above that decides what a lost connection means.
 *
 * Native `EventSource` is deliberately not used: it reconnects by itself and
 * cannot carry an `Authorization` header, and both of those would quietly
 * contradict the contract this binding exists to serve.
 */

import type { ProtocolChannel, ProtocolChannelListener } from "@every-dagent/protocol";

import { createSseParser, unwrapRecord, utf8Length, wrapFrame } from "../transport/framing.js";
import { DEFAULT_WEB_LIMITS, type WebLimits } from "../transport/limits.js";
import { createFrameQueue } from "../transport/queue.js";

export interface HttpChannelOptions {
  /** The binding's origin, e.g. `http://127.0.0.1:41234`. */
  readonly origin: string;
  /** Extra headers for both directions, e.g. a deployment's own auth. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly limits?: Partial<WebLimits>;
}

const TRANSPORT_HEADER = "x-every-dagent-transport";

interface CreatedConnection {
  readonly connectionId: string;
  readonly token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createdConnectionOf(value: unknown): CreatedConnection | undefined {
  if (!isRecord(value)) return undefined;
  const connectionId = value["connectionId"];
  const token = value["token"];
  if (typeof connectionId !== "string" || typeof token !== "string") return undefined;
  return { connectionId, token };
}

/**
 * Establishes one logical connection and returns its channel.
 *
 * It resolves only once the downstream is demonstrably live — the binding writes
 * a marker as soon as the stream exists — so a channel handed to a client is
 * never a channel that cannot receive.
 */
export async function connectHttpChannel(options: HttpChannelOptions): Promise<ProtocolChannel> {
  const limits: WebLimits = { ...DEFAULT_WEB_LIMITS, ...options.limits };
  const extra = options.headers ?? {};
  const origin = options.origin.replace(/\/$/, "");

  const created = await fetch(`${origin}/connections`, {
    method: "POST",
    headers: { "content-type": "application/json", [TRANSPORT_HEADER]: "1", ...extra },
    body: JSON.stringify({}),
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  }).then(async (response) => {
    if (response.status !== 201) throw new Error(`the binding refused the connection: ${response.status}`);
    return createdConnectionOf(await response.json());
  });
  if (created === undefined) throw new Error("the binding did not describe the connection it created");
  const connection = created;

  // The stream has its own lifetime: ending the logical connection aborts it,
  // and nothing else. An upstream POST that is already on the wire is left to
  // settle — the bytes are sent either way, aborting it mid-request only turns a
  // normal end into a reset.
  const streamAbort = new AbortController();
  const listenerBox: { current: ProtocolChannelListener | undefined } = { current: undefined };
  const buffered = createFrameQueue({ maxFrames: limits.queueFrames, maxBytes: limits.queueBytes });
  const upstream: { readonly frame: string; readonly bytes: number }[] = [];
  let upstreamBytes = 0;
  /** The frame a POST is carrying right now: counted until its answer arrives. */
  let inFlight: { readonly bytes: number } | undefined;
  let upstreamRunning = false;
  let closed = false;
  let closeNotified = false;
  let readerDone: () => void = () => undefined;
  let lastChunkAt = Date.now();
  let idleWatch: ReturnType<typeof setInterval> | undefined;

  function notifyClose(): void {
    if (closeNotified) return;
    closeNotified = true;
    try {
      listenerBox.current?.onClose();
    } catch {
      // The owner's own failure to react is not this transport's to report.
    }
  }

  /** Ends the logical connection at both ends: the stream and every queued frame. */
  function endConnection(): void {
    if (closed) return;
    closed = true;
    upstream.length = 0;
    upstreamBytes = 0;
    inFlight = undefined;
    buffered.clear();
    if (idleWatch !== undefined) clearInterval(idleWatch);
    idleWatch = undefined;
    streamAbort.abort();
    notifyClose();
    readerDone();
  }

  /** One POST at a time, in order: the upstream is a FIFO, not a race. */
  async function runUpstream(): Promise<void> {
    if (upstreamRunning) return;
    upstreamRunning = true;

    while (!closed && upstream.length > 0) {
      const entry = upstream.shift();
      if (entry === undefined) break;
      upstreamBytes -= entry.bytes;
      inFlight = entry;
      try {
        const response = await fetch(`${origin}/connections/${connection.connectionId}/frames`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${connection.token}`,
            [TRANSPORT_HEADER]: "1",
            ...extra,
          },
          body: wrapFrame(entry.frame),
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(limits.postTimeoutMs),
        });
        inFlight = undefined;
        if (response.status !== 204) {
          endConnection();
          break;
        }
      } catch {
        // A failed POST is a failed connection: this client never re-sends a
        // frame, because it cannot know whether the host saw the first one.
        endConnection();
        break;
      }
    }
    inFlight = undefined;
    upstreamRunning = false;
  }

  const response = await fetch(`${origin}/connections/${connection.connectionId}/events`, {
    headers: { accept: "text/event-stream", authorization: `Bearer ${connection.token}`, ...extra },
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: streamAbort.signal,
  });
  if (response.status !== 200 || response.body === null) {
    endConnection();
    throw new Error(`the binding refused the stream: ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/event-stream")) {
    endConnection();
    throw new Error("the binding answered the stream with something else");
  }

  const reader = response.body.getReader();
  readerDone = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  const decoder = new TextDecoder();
  const parser = createSseParser(limits.recordBytes);
  const established = { resolve: (): void => undefined, reject: (error: unknown): void => undefined };
  const establishedPromise = new Promise<void>((resolve, reject) => {
    established.resolve = resolve;
    established.reject = reject;
  });

  void (async (): Promise<void> => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        lastChunkAt = Date.now();
        for (const record of parser.feed(decoder.decode(chunk.value, { stream: true }))) {
          if (record.length === 0) continue;
          const frame = unwrapRecord(record);
          if (frame === undefined) {
            // Not a frame this transport can carry: the connection is over.
            endConnection();
            return;
          }
          const frameBytes = utf8Length(frame);
          if (frameBytes > limits.frameBytes) {
            // The same limit the binding applies on its way out, applied on the
            // way in: a frame past it is a connection that cannot be trusted.
            endConnection();
            return;
          }
          if (listenerBox.current === undefined) {
            if (!buffered.push(frame, frameBytes)) {
              endConnection();
              return;
            }
            continue;
          }
          try {
            listenerBox.current.onFrame(frame);
          } catch {
            // The owner's frame handling is its own business.
          }
        }
        if (parser.overflowed) {
          // A record that does not fit the limit means this stream's framing is
          // no longer trustworthy: the connection ends rather than resynchronize
          // on a boundary that was never really a boundary.
          endConnection();
          return;
        }
        established.resolve();
      }
    } catch {
      // A read that fails is the stream ending; the loop below reports it.
    }
    endConnection();
  })();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      establishedPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("the stream did not start in time"));
        }, limits.pendingTtlMs);
      }),
    ]);
  } catch (error) {
    endConnection();
    throw error instanceof Error ? error : new Error("the stream did not start");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  // The downstream is kept alive by the binding's heartbeat, so silence past the
  // limit means the path is gone even though no error was raised.
  idleWatch = setInterval(() => {
    if (Date.now() - lastChunkAt > limits.idleTimeoutMs) endConnection();
  }, Math.max(1000, Math.floor(limits.idleTimeoutMs / 3)));

  return {
    send(frame: string): void {
      if (typeof frame !== "string") throw new Error("frames must be strings");
      if (closed) throw new Error("the connection is closed");

      const bytes = utf8Length(frame);
      if (bytes > limits.frameBytes) {
        // A frame the binding would refuse is refused here, where the caller can
        // still tell the difference between "not sent" and "lost".
        endConnection();
        throw new Error("a frame does not fit the binding's limit");
      }

      const held = upstreamBytes + (inFlight?.bytes ?? 0);
      if (upstream.length >= limits.queueFrames || held + bytes > limits.queueBytes) {
        endConnection();
        throw new Error("the upstream queue is full");
      }

      upstream.push({ frame, bytes });
      upstreamBytes += bytes;
      void runUpstream();
    },

    listen(listener: ProtocolChannelListener): () => void {
      if (listenerBox.current !== undefined) throw new Error("the channel already has a listener");
      listenerBox.current = listener;
      for (;;) {
        const frame = buffered.shift();
        if (frame === undefined) break;
        try {
          listener.onFrame(frame);
        } catch {
          // As above: a listener that throws does not stop the frames behind it.
        }
      }
      return (): void => {
        if (listenerBox.current === listener) listenerBox.current = undefined;
      };
    },

    close(): void {
      endConnection();
    },
  };
}
