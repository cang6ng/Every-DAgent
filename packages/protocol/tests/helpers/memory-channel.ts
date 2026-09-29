/**
 * A loopback pair of in-memory `ProtocolChannel`s for testing the transport
 * contract without any network.
 *
 * The fixture is deliberately dumber than the contract allows: frames cross
 * as strings, the receiving side must JSON.parse them, there is no object
 * sharing and no backpressure. It does enforce the parts of the contract a
 * sloppy fixture would hide: install-listener-before-traffic, single
 * listener, close-once, and send failing synchronously once either end is
 * closed.
 */

import type { ProtocolChannel, ProtocolChannelListener } from "@every-dagent/protocol";

export function createMemoryChannelPair(): { clientSide: ProtocolChannel; hostSide: ProtocolChannel } {
  let clientListener: ProtocolChannelListener | undefined;
  let hostListener: ProtocolChannelListener | undefined;
  let clientClosed = false;
  let hostClosed = false;

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
      if (clientClosed) throw new Error("client channel is closed");
      deliver(frame, hostClosed, hostListener);
    },
    listen(listener: ProtocolChannelListener): () => void {
      if (clientListener !== undefined) throw new Error("channel already has a listener");
      if (clientClosed) throw new Error("channel is closed");
      clientListener = listener;
      return () => {
        if (clientListener === listener) clientListener = undefined;
      };
    },
    close(): void {
      if (clientClosed) return;
      clientClosed = true;
      clientListener?.onClose();
    },
  };

  const hostSide: ProtocolChannel = {
    send(frame: string): void {
      if (hostClosed) throw new Error("host channel is closed");
      deliver(frame, clientClosed, clientListener);
    },
    listen(listener: ProtocolChannelListener): () => void {
      if (hostListener !== undefined) throw new Error("channel already has a listener");
      if (hostClosed) throw new Error("channel is closed");
      hostListener = listener;
      return () => {
        if (hostListener === listener) hostListener = undefined;
      };
    },
    close(): void {
      if (hostClosed) return;
      hostClosed = true;
      hostListener?.onClose();
    },
  };

  return { clientSide, hostSide };
}
