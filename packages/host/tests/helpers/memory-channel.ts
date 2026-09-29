/**
 * A loopback pair of in-memory `ProtocolChannel`s.
 *
 * Deliberately dumber than the contract allows: frames cross as strings, no
 * object is shared, there is no backpressure. It does enforce the parts a
 * sloppy fixture would hide — install the listener before any traffic, one
 * listener per channel, close exactly once, and a send into a closed peer
 * failing loudly instead of vanishing.
 *
 * Closing one end ends the logical connection at both: each side's `onClose`
 * fires once, and any later send fails. That is what a real transport does, and
 * a fixture that let the peer keep writing into a dead connection would hide
 * exactly the failure the host has to survive.
 */

import type { ProtocolChannel, ProtocolChannelListener } from "@every-dagent/protocol";

export interface MemoryChannelPair {
  readonly clientSide: ProtocolChannel;
  readonly hostSide: ProtocolChannel;
}

export function createMemoryChannelPair(): MemoryChannelPair {
  const state: {
    clientListener?: ProtocolChannelListener;
    hostListener?: ProtocolChannelListener;
    clientClosed: boolean;
    hostClosed: boolean;
  } = { clientClosed: false, hostClosed: false };

  function closeAs(side: "client" | "host"): void {
    const closed = side === "client" ? state.clientClosed : state.hostClosed;
    if (closed) return;

    if (side === "client") {
      state.clientClosed = true;
      state.clientListener?.onClose();
      state.hostClosed = true;
      state.hostListener?.onClose();
      return;
    }

    state.hostClosed = true;
    state.hostListener?.onClose();
    state.clientClosed = true;
    state.clientListener?.onClose();
  }

  function deliver(
    frame: string,
    peerClosed: boolean,
    peerListener: ProtocolChannelListener | undefined,
  ): void {
    if (typeof frame !== "string") throw new Error("frames must be strings");
    if (peerClosed) throw new Error("peer channel is closed");
    if (peerListener === undefined) throw new Error("peer listener must be installed before traffic");
    peerListener.onFrame(frame);
  }

  const clientSide: ProtocolChannel = {
    send(frame: string): void {
      if (state.clientClosed) throw new Error("client channel is closed");
      deliver(frame, state.hostClosed, state.hostListener);
    },
    listen(listener: ProtocolChannelListener): () => void {
      if (state.clientListener !== undefined) throw new Error("channel already has a listener");
      if (state.clientClosed) throw new Error("channel is closed");
      state.clientListener = listener;
      return () => {
        if (state.clientListener === listener) state.clientListener = undefined;
      };
    },
    close(): void {
      closeAs("client");
    },
  };

  const hostSide: ProtocolChannel = {
    send(frame: string): void {
      if (state.hostClosed) throw new Error("host channel is closed");
      deliver(frame, state.clientClosed, state.clientListener);
    },
    listen(listener: ProtocolChannelListener): () => void {
      if (state.hostListener !== undefined) throw new Error("channel already has a listener");
      if (state.hostClosed) throw new Error("channel is closed");
      state.hostListener = listener;
      return () => {
        if (state.hostListener === listener) state.hostListener = undefined;
      };
    },
    close(): void {
      closeAs("host");
    },
  };

  return { clientSide, hostSide };
}
