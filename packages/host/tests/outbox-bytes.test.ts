/**
 * The outbox is bounded in the bytes a frame really occupies.
 *
 * A frame is carried as UTF-8, so a string of emoji costs two to four times
 * what its JavaScript length suggests. A bound checked against code units
 * would let a connection hold several times the memory this limit promises —
 * and the limit exists precisely to bound what a slow or absent reader costs.
 */

import { describe, expect, it } from "vitest";

import { sendFrame } from "../src/connection.js";
import { HOST_LIMITS } from "../src/limits.js";
import type { ConnectionState, HostState } from "../src/state.js";
import { createConnection } from "../src/connection.js";
import type { ProtocolChannel, ProtocolChannelListener } from "@every-dagent/protocol";

/** A channel that accepts everything: the queue is what this test drives. */
function quietChannel(): ProtocolChannel {
  return {
    send(): void {
      // Nothing reads it; the pump is never allowed to run in this test.
    },
    listen(_listener: ProtocolChannelListener): () => void {
      return () => undefined;
    },
    close(): void {
      // Closing is the host's own bookkeeping here.
    },
  };
}

function stateWith(connection: ConnectionState): HostState {
  return {
    connections: new Set([connection]),
  } as unknown as HostState;
}

describe("the host outbox", () => {
  it("counts the UTF-8 bytes a frame really occupies, not its code units", () => {
    const connection = createConnection(quietChannel(), []);
    const state = stateWith(connection);
    // 1024 astral characters: 2 code units each in memory, 4 bytes each on the
    // wire. The two measures differ by a factor of two for this payload.
    const frame = JSON.stringify({ text: "🙂".repeat(1024) });
    const frameBytes = Buffer.byteLength(frame, "utf8");
    const frameUnits = frame.length;
    expect(frameBytes).toBeGreaterThan(frameUnits);

    // Sent synchronously, so nothing drains: the queue is exactly what these
    // calls put in it until the bound refuses one. Closing the connection
    // clears the queue, so the last admitted total is what is remembered here.
    let accepted = 0;
    let admittedBytes = 0;
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      sendFrame(state, connection, frame);
      if (connection.closed) break;
      accepted += 1;
      admittedBytes = connection.outboxBytes;
    }

    expect(connection.closed).toBe(true);
    expect(admittedBytes).toBe(accepted * frameBytes);
    expect(admittedBytes).toBeLessThanOrEqual(HOST_LIMITS.maxOutboxBytes);
    expect(admittedBytes + frameBytes).toBeGreaterThan(HOST_LIMITS.maxOutboxBytes);
    // A code-unit bound would have admitted noticeably more frames: this is the
    // check that the byte measure is the one actually enforced.
    expect(accepted).toBeLessThan(Math.floor(HOST_LIMITS.maxOutboxBytes / frameUnits));
  });
});
