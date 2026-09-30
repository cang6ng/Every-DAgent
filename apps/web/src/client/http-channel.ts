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
import { DEFAULT_WEB_LIMITS, FRAME_LIMIT_BYTES, RECORD_LIMIT_BYTES, type WebLimits } from "../transport/limits.js";
import { createFrameQueue } from "../transport/queue.js";

/** The transport primitives, re-exported so the browser entry is one import. */
export {
  FRAME_LIMIT_BYTES,
  RECORD_LIMIT_BYTES,
  createSseParser,
  unwrapRecord,
  utf8Length,
  wrapFrame,
};
export type { SseParser } from "../transport/framing.js";

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

/** One attempt at establishing a connection: its limits, its address, its one clock. */
interface ConnectAttempt {
  readonly limits: WebLimits;
  readonly headers: Readonly<Record<string, string>>;
  readonly origin: string;
  /** How much of the one establishment budget is left. */
  readonly budget: () => number;
  /** Aborted when that budget runs out; every stage of the attempt draws on it. */
  readonly abort: AbortController;
}

/**
 * Establishes one logical connection and returns its channel.
 *
 * It resolves only once the downstream is demonstrably live — the binding writes
 * a marker as soon as the stream exists — so a channel handed to a client is
 * never a channel that cannot receive.
 *
 * The clock belongs to the attempt, not to any one stage of it. Establishing a
 * connection runs through a create, a claim, the headers of the stream and the
 * first byte of it, and all of them draw on the same budget: a server that
 * answers each stage just in time cannot stretch the total, and a stage that
 * begins with a second left gets a second, never a fresh ten. However the
 * attempt ends — established, refused, malformed, aborted, thrown — it ends
 * here, and the timer it was started with ends here with it. A deadline left
 * behind by an attempt the binding refused would go on firing into an answer
 * that was already given.
 */
export async function connectHttpChannel(options: HttpChannelOptions): Promise<ProtocolChannel> {
  const limits: WebLimits = { ...DEFAULT_WEB_LIMITS, ...options.limits };
  const startedAt = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => {
    abort.abort();
  }, limits.connectTimeoutMs);

  try {
    return await establish({
      limits,
      headers: options.headers ?? {},
      origin: options.origin.replace(/\/$/, ""),
      budget: (): number => Math.max(0, limits.connectTimeoutMs - (Date.now() - startedAt)),
      abort,
    });
  } finally {
    clearTimeout(deadline);
  }
}

/** The establishment itself, under the one clock its caller owns. */
async function establish(attempt: ConnectAttempt): Promise<ProtocolChannel> {
  const { limits, headers: extra, origin, budget: connectBudget, abort: connectAbort } = attempt;

  const created = await fetch(`${origin}/connections`, {
    method: "POST",
    headers: { "content-type": "application/json", [TRANSPORT_HEADER]: "1", ...extra },
    body: JSON.stringify({}),
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: connectAbort.signal,
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
  const upstream: { readonly body: string; readonly bytes: number }[] = [];
  let upstreamBytes = 0;
  /** The frame a POST is carrying right now: counted until its answer arrives. */
  let inFlight: { readonly bytes: number } | undefined;
  let upstreamRunning = false;
  /** Aborted when the connection ends, so an in-flight POST does not outlive it. */
  const shutdown = new AbortController();
  let closed = false;
  let closeNotified = false;
  /** Whether the one close has already been handed to a listener. */
  let closeDelivered = false;
  let readerDone: () => void = () => undefined;
  let lastChunkAt = Date.now();
  let idleWatch: ReturnType<typeof setInterval> | undefined;
  /** Guards the deadline of one record that has started but not finished. */
  let recordWatch: ReturnType<typeof setTimeout> | undefined;
  /** Which record that deadline belongs to; `0` is no record at all. */
  let recordWatchGeneration = 0;

  function notifyClose(): void {
    if (closeNotified) return;
    const listener = listenerBox.current;
    // A connection that ended before anyone listened still owes its one close;
    // it is handed over when a listener arrives.
    if (listener === undefined) {
      closeDelivered = true;
      return;
    }
    closeNotified = true;
    try {
      listener.onClose();
    } catch {
      // The owner's own failure to react is not this transport's to report.
    }
  }

  /**
   * Ends the logical connection at both ends: the stream, every queued frame and
   * an upstream request that is still in flight. Neither direction is left
   * running on its own.
   */
  function endConnection(): void {
    if (closed) return;
    closed = true;
    upstream.length = 0;
    upstreamBytes = 0;
    inFlight = undefined;
    buffered.clear();
    if (idleWatch !== undefined) clearInterval(idleWatch);
    idleWatch = undefined;
    if (recordWatch !== undefined) clearTimeout(recordWatch);
    recordWatch = undefined;
    streamAbort.abort();
    shutdown.abort();
    notifyClose();
    readerDone();
  }

  /**
   * Watches the one record that has started and not finished.
   *
   * The deadline belongs to a record, not to the stream. When a chunk ends one
   * record and starts the next, the new record gets a deadline of its own
   * instead of inheriting what was left of the old one's — and a deadline that
   * arrives after its record ended belongs to nothing, so it can neither close
   * the record that replaced it nor the connection carrying it. A record made of
   * comments alone is a record: it started, and it is on the clock.
   */
  function watchRecord(): void {
    if (!parser.open) {
      if (recordWatch !== undefined) clearTimeout(recordWatch);
      recordWatch = undefined;
      recordWatchGeneration = 0;
      return;
    }
    if (recordWatch !== undefined && recordWatchGeneration === parser.generation) return;

    if (recordWatch !== undefined) clearTimeout(recordWatch);
    const generation = parser.generation;
    recordWatchGeneration = generation;
    recordWatch = setTimeout(() => {
      recordWatch = undefined;
      recordWatchGeneration = 0;
      if (!parser.open || parser.generation !== generation) return;
      // Heartbeats are comments: they keep the connection warm without making
      // progress on the record that is stuck, and this deadline is absolute.
      endConnection();
    }, limits.recordTimeoutMs);
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
          body: entry.body,
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any([AbortSignal.timeout(limits.postTimeoutMs), shutdown.signal]),
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
    signal: AbortSignal.any([streamAbort.signal, connectAbort.signal]),
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
        if (closeDelivered) break;
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
        watchRecord();
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
        }, connectBudget());
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

      // What the transport will actually send is the wrapped record, and the
      // record limit is about the record: a small frame that escapes into a
      // large wrapper is still a record this binding cannot carry.
      const body = wrapFrame(frame);
      const encoded = utf8Length(body);
      if (encoded > limits.recordBytes) {
        endConnection();
        throw new Error("a record does not fit the binding's limit");
      }

      // The budget is about work this connection still owes, not about the
      // queue: a POST that is on the wire but unanswered holds its frame, and
      // holds it in the bytes the transport is carrying.
      const heldFrames = upstream.length + (inFlight === undefined ? 0 : 1);
      const heldBytes = upstreamBytes + (inFlight?.bytes ?? 0);
      if (heldFrames + 1 > limits.queueFrames || heldBytes + encoded > limits.queueBytes) {
        endConnection();
        throw new Error("the upstream queue is full");
      }

      upstream.push({ body, bytes: encoded });
      upstreamBytes += encoded;
      void runUpstream();
    },

    listen(listener: ProtocolChannelListener): () => void {
      if (listenerBox.current !== undefined) throw new Error("the channel already has a listener");
      listenerBox.current = listener;

      // The connection may have ended while nobody was listening; that close is
      // owed exactly once, and this is where it is paid.
      if (closeDelivered && !closeNotified) {
        closeNotified = true;
        try {
          listener.onClose();
        } catch {
          // As above: the owner's reaction is not this transport's to report.
        }
        return (): void => {
          if (listenerBox.current === listener) listenerBox.current = undefined;
        };
      }

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
