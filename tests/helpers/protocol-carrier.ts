/**
 * A pair of in-memory `ProtocolChannel`s that behaves like a transport.
 *
 * The host's own test channel is deliberately dumber than the contract: frames
 * cross synchronously and nothing is bounded. This one is the counterpart the
 * integration tests need — every frame is forced through a JSON round trip,
 * delivery is asynchronous and ordered, both directions are bounded and
 * overflow fails loudly, and closing either side ends the logical connection at
 * both. It also knows nothing about the protocol: only strings.
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
  /** Resolves when both queues are empty. */
  settled(): Promise<void>;
}

const DEFAULT_LIMITS: CarrierLimits = Object.freeze({ maxFrames: 64, maxBytes: 8 * 1024 * 1024 });

export function createCarrierPair(options: CarrierOptions = {}): CarrierPair {
  const limits: CarrierLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const dropped: { direction: Direction; frame: string }[] = [];
  const log: CarrierFrame[] = [];

  const state: {
    clientListener?: ProtocolChannelListener;
    hostListener?: ProtocolChannelListener;
    clientClosed: boolean;
    hostClosed: boolean;
    clientQueue: string[];
    hostQueue: string[];
    clientBytes: number;
    hostBytes: number;
    pumping: boolean;
  } = {
    clientClosed: false,
    hostClosed: false,
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
    if (state.clientClosed && state.hostClosed) return;
    state.clientClosed = true;
    state.hostClosed = true;
    state.clientQueue.length = 0;
    state.hostQueue.length = 0;
    state.clientBytes = 0;
    state.hostBytes = 0;
    state.clientListener?.onClose();
    state.hostListener?.onClose();
  }

  function schedulePump(): void {
    if (state.pumping) return;
    state.pumping = true;
    queueMicrotask(() => {
      state.pumping = false;
      pump();
    });
  }

  /** One frame per turn, so ordering is observable and no loop starves the host. */
  function pump(): void {
    const clientFrame = state.clientQueue.shift();
    if (clientFrame !== undefined) {
      state.clientBytes -= clientFrame.length;
      if (!state.hostClosed) state.hostListener?.onFrame(clientFrame);
      if (state.clientQueue.length > 0) schedulePump();
      return;
    }
    const hostFrame = state.hostQueue.shift();
    if (hostFrame !== undefined) {
      state.hostBytes -= hostFrame.length;
      if (!state.clientClosed) state.clientListener?.onFrame(hostFrame);
      if (state.hostQueue.length > 0) schedulePump();
    }
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

    if (queue.length >= limits.maxFrames || bytes + copy.length > limits.maxBytes) {
      // A transport that cannot take the frame must say so, and the connection
      // ends: silently dropping it would leave the peer believing a state it
      // does not have.
      endLogically();
      throw new Error("the connection's send queue is full");
    }

    queue.push(copy);
    if (direction === "client-to-host") state.clientBytes += copy.length;
    else state.hostBytes += copy.length;
    schedulePump();
  }

  function listen(
    side: "client" | "host",
    listener: ProtocolChannelListener,
  ): () => void {
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
    async settled(): Promise<void> {
      while (state.clientQueue.length > 0 || state.hostQueue.length > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    },
  };
}
