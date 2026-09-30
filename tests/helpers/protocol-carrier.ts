/**
 * A pair of in-memory `ProtocolChannel`s that behaves like a transport.
 *
 * The host's own test channel is deliberately dumber than the contract: frames
 * cross synchronously and nothing is bounded. This one is the counterpart the
 * integration tests need — every frame is forced through a JSON round trip,
 * delivery is asynchronous and ordered per direction, both directions are
 * bounded by real UTF-8 bytes, and closing either side ends the logical
 * connection at both. It also knows nothing about the protocol: only strings.
 *
 * A `drop` hook turns it into a lossy transport, which is the only way to test
 * what a client does when an answer never arrives.
 */

import type { ProtocolChannel, ProtocolChannelListener } from "@every-dagent/protocol";

export type Direction = "client-to-host" | "host-to-client";

export interface CarrierLimits {
  readonly maxFrames: number;
  readonly maxBytes: number;
}

export interface CarrierOptions {
  readonly limits?: Partial<CarrierLimits>;
  /** Returns true to let a frame vanish: the delivery that never happens. */
  readonly drop?: (direction: Direction, frame: string) => boolean;
}

export interface CarrierFrame {
  readonly direction: Direction;
  readonly frame: string;
  readonly dropped: boolean;
}

export interface CarrierPair {
  readonly clientSide: ProtocolChannel;
  readonly hostSide: ProtocolChannel;
  /** Every frame either side handed over, in order, with what became of it. */
  readonly log: readonly CarrierFrame[];
  /** Frames that were dropped by the lossy hook, in order. */
  readonly dropped: readonly { readonly direction: Direction; readonly frame: string }[];
  /** The bytes each direction is currently holding, as queues. */
  readonly queued: { readonly clientToHost: number; readonly hostToClient: number };
  /** Resolves once nothing is queued and nothing is on its way. */
  settled(): Promise<void>;
}

const DEFAULT_LIMITS: CarrierLimits = Object.freeze({ maxFrames: 64, maxBytes: 8 * 1024 * 1024 });

/** The real byte length of one frame, which is what a transport budget is made of. */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

interface Entry {
  readonly frame: string;
  /** What this entry cost when it was queued; released exactly as it was charged. */
  readonly bytes: number;
}

export function createCarrierPair(options: CarrierOptions = {}): CarrierPair {
  const limits: CarrierLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const dropped: { direction: Direction; frame: string }[] = [];
  const log: CarrierFrame[] = [];

  const state: {
    clientListener?: ProtocolChannelListener;
    hostListener?: ProtocolChannelListener;
    clientClosed: boolean;
    hostClosed: boolean;
    notified: boolean;
    clientQueue: Entry[];
    hostQueue: Entry[];
    clientBytes: number;
    hostBytes: number;
    pumping: boolean;
  } = {
    clientClosed: false,
    hostClosed: false,
    notified: false,
    clientQueue: [],
    hostQueue: [],
    clientBytes: 0,
    hostBytes: 0,
    pumping: false,
  };

  /** The JSON boundary, enforced even here: only text crosses, and it is re-parsed. */
  function asFrame(frame: string): string {
    if (typeof frame !== "string") throw new Error("frames must be strings");
    const parsed: unknown = JSON.parse(JSON.stringify(frame));
    if (typeof parsed !== "string") throw new Error("a frame must survive a JSON round trip as a string");
    return parsed;
  }

  function endLogically(): void {
    state.clientClosed = true;
    state.hostClosed = true;
    state.clientQueue.length = 0;
    state.hostQueue.length = 0;
    state.clientBytes = 0;
    state.hostBytes = 0;
    if (state.notified) return;
    state.notified = true;
    state.clientListener?.onClose();
    state.hostListener?.onClose();
  }

  function schedulePump(): void {
    if (state.pumping) return;
    state.pumping = true;
    queueMicrotask(() => {
      pump();
    });
  }

  /**
   * Empties both queues.
   *
   * Each direction is drained in the same turn, and neither can be left behind:
   * a queue that still holds a frame wakes the pump itself instead of waiting for
   * some later `send` that may never come. Delivery is one entry at a time, so
   * each entry is released exactly once, with the bytes it was charged.
   */
  function pump(): void {
    for (;;) {
      const fromClient = take("client-to-host");
      const fromHost = take("host-to-client");
      if (fromClient === undefined && fromHost === undefined) break;
      if (fromClient !== undefined && !state.hostClosed) state.hostListener?.onFrame(fromClient);
      if (fromHost !== undefined && !state.clientClosed) state.clientListener?.onFrame(fromHost);
    }
    state.pumping = false;
    // A listener can queue more while being delivered to; those frames are the
    // same turn's business when the loop saw them, and the next turn's otherwise.
    if (state.clientQueue.length > 0 || state.hostQueue.length > 0) schedulePump();
  }

  function take(direction: Direction): string | undefined {
    const queue = direction === "client-to-host" ? state.clientQueue : state.hostQueue;
    const entry = queue.shift();
    if (entry === undefined) return undefined;
    if (direction === "client-to-host") state.clientBytes -= entry.bytes;
    else state.hostBytes -= entry.bytes;
    return entry.frame;
  }

  function send(direction: Direction, frame: string): void {
    const queue = direction === "client-to-host" ? state.clientQueue : state.hostQueue;
    const bytes = direction === "client-to-host" ? state.clientBytes : state.hostBytes;
    const closed = direction === "client-to-host" ? state.clientClosed : state.hostClosed;
    const peerClosed = direction === "client-to-host" ? state.hostClosed : state.clientClosed;
    const listener = direction === "client-to-host" ? state.hostListener : state.clientListener;

    if (closed) throw new Error("this side of the connection is closed");
    if (peerClosed) throw new Error("the peer has gone away");
    if (listener === undefined) throw new Error("the listener must be installed before any traffic");

    const copy = asFrame(frame);
    if (options.drop?.(direction, copy) === true) {
      dropped.push({ direction, frame: copy });
      log.push({ direction, frame: copy, dropped: true });
      return;
    }
    log.push({ direction, frame: copy, dropped: false });

    const cost = utf8Length(copy);
    if (queue.length >= limits.maxFrames || bytes + cost > limits.maxBytes) {
      // A transport that cannot take the frame must say so, and the connection
      // ends: silently dropping it would leave the peer believing a state it
      // does not have.
      endLogically();
      throw new Error("the connection's send queue is full");
    }

    queue.push({ frame: copy, bytes: cost });
    if (direction === "client-to-host") state.clientBytes += cost;
    else state.hostBytes += cost;
    schedulePump();
  }

  function listen(side: "client" | "host", listener: ProtocolChannelListener): () => void {
    if (side === "client") {
      if (state.clientListener !== undefined) throw new Error("the channel already has a listener");
      if (state.clientClosed) throw new Error("the channel is closed");
      state.clientListener = listener;
      return (): void => {
        if (state.clientListener === listener) state.clientListener = undefined;
      };
    }
    if (state.hostListener !== undefined) throw new Error("the channel already has a listener");
    if (state.hostClosed) throw new Error("the channel is closed");
    state.hostListener = listener;
    return (): void => {
      if (state.hostListener === listener) state.hostListener = undefined;
    };
  }

  const clientSide: ProtocolChannel = {
    send: (frame: string): void => {
      send("client-to-host", frame);
    },
    listen: (listener: ProtocolChannelListener): (() => void) => listen("client", listener),
    close: (): void => {
      endLogically();
    },
  };

  const hostSide: ProtocolChannel = {
    send: (frame: string): void => {
      send("host-to-client", frame);
    },
    listen: (listener: ProtocolChannelListener): (() => void) => listen("host", listener),
    close: (): void => {
      endLogically();
    },
  };

  return {
    clientSide,
    hostSide,
    log,
    dropped,
    get queued(): { readonly clientToHost: number; readonly hostToClient: number } {
      return { clientToHost: state.clientBytes, hostToClient: state.hostBytes };
    },
    async settled(): Promise<void> {
      for (;;) {
        const idle =
          state.clientQueue.length === 0 &&
          state.hostQueue.length === 0 &&
          !state.pumping;
        if (idle) return;
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    },
  };
}
