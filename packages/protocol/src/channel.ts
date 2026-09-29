/**
 * The transport-neutral channel port, frozen by SPEC §15.
 *
 * Types only — no HTTP, SSE, WebSocket, stdio or IPC lives here. A binding
 * hands an established `ProtocolChannel` to the Host/Client; everything about
 * how frames physically travel stays outside the protocol package.
 */

/** Receives one complete wire frame (a string holding one JSON message). */
export interface ProtocolChannelListener {
  onFrame(frame: string): void;
  onClose(): void;
}

/**
 * A bidirectional frame conduit between one logical client connection and the
 * Host. Carries all five message kinds; knows nothing about their meaning.
 *
 * Contract highlights (SPEC §15.1): frames are delivered in send order per
 * direction, `send` only queues into a bounded buffer (it never means the
 * peer received or acted), the listener is installed before any protocol
 * traffic, and `onClose` fires at most once.
 */
export interface ProtocolChannel {
  /** Queues one frame for delivery; throws synchronously when the channel cannot accept it. */
  send(frame: string): void;
  /**
   * Installs the channel's single active listener and returns a disposer that
   * removes it. Installing while another listener is active is an error.
   */
  listen(listener: ProtocolChannelListener): () => void;
  /** Idempotently closes the channel; late sends fail rather than vanish. */
  close(): void;
}
