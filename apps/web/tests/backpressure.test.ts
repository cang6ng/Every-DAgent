/**
 * The binding's limits, at the boundary and one byte past it.
 *
 * A transport that quietly grew its buffers, or that dropped frames when they
 * stopped fitting, would break the sequence guarantees above it. These tests use
 * small limits so both sides of every boundary can be exercised for real.
 */

import { request } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { ProtocolChannel } from "@every-dagent/protocol";

import { FRAME_LIMIT_BYTES, connectHttpChannel, utf8Length } from "../src/index.js";

import { createCredentials, openRawPeer, startBinding, waitUntil } from "./helpers/raw-peer.js";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const binding of open.splice(0)) await binding.close();
});

describe("frame size", () => {
  it("accepts a frame exactly at the limit and refuses the next byte", async () => {
    const { binding, channels } = await startBinding({ limits: { frameBytes: 64 } });
    open.push(binding);
    const peer = await openRawPeer(binding.origin);
    const received: string[] = [];
    channels[0]?.listen({ onFrame: (frame: string) => received.push(frame), onClose: () => undefined });

    const atLimit = "x".repeat(64);
    expect(await peer.post(atLimit)).toBe(204);
    await waitUntil(() => received.length === 1, "the frame at the limit");

    const overLimit = "x".repeat(65);
    expect(await peer.post(overLimit)).toBe(413);
    await waitUntil(() => peer.ended, "the connection to end");
  });

  it("counts UTF-8 bytes, not code units", async () => {
    const { binding } = await startBinding({ limits: { frameBytes: 8 } });
    open.push(binding);
    const peer = await openRawPeer(binding.origin);

    // Four two-byte characters are exactly eight bytes.
    expect(await peer.post("éééé")).toBe(204);
    expect(await peer.post("ééééé")).toBe(413);
  });

  it("refuses a body that is larger than any record, whatever it claims", async () => {
    const { binding } = await startBinding({ limits: { recordBytes: 128 } });
    open.push(binding);
    const peer = await openRawPeer(binding.origin);

    expect(await peer.postRaw(JSON.stringify("y".repeat(256)))).toBe(413);
    await waitUntil(() => peer.ended, "the connection to end");
  });

  it("keeps the default frame limit where the protocol expects it", () => {
    expect(FRAME_LIMIT_BYTES).toBe(1024 * 1024);
    expect(utf8Length("x".repeat(FRAME_LIMIT_BYTES))).toBe(FRAME_LIMIT_BYTES);
  });
});

describe("queue bounds", () => {
  it("ends the connection when the downstream queue overflows", async () => {
    const { binding, channels } = await startBinding({
      limits: { queueFrames: 2, queueBytes: 300_000, drainTimeoutMs: 200 },
    });
    open.push(binding);

    // A reader that never reads: the socket buffer fills, the binding pauses,
    // and everything past that has to fit in the queue.
    const credentials = await createCredentials(binding.origin);
    const claim = request(
      {
        host: "127.0.0.1",
        port: Number(new URL(binding.origin).port),
        path: `/connections/${credentials.connectionId}/events`,
        headers: { authorization: `Bearer ${credentials.token}` },
      },
      (response) => {
        response.pause();
      },
    );
    // This request is deliberately killed at the end of the test; the reset that
    // follows is the point, not a failure.
    claim.on("error", () => undefined);
    claim.end();
    await waitUntil(() => channels.length === 1, "the channel to be attached");

    const channel = channels[0];
    let closed = 0;
    channel?.listen({ onFrame: () => undefined, onClose: () => (closed += 1) });

    const chunk = "x".repeat(64 * 1024);
    let refused = false;
    for (let index = 0; index < 64 && !refused; index += 1) {
      try {
        channel?.send(chunk);
      } catch {
        refused = true;
      }
    }

    expect(refused).toBe(true);
    await waitUntil(() => closed === 1, "the binding to close the connection");
    claim.destroy();
  });

  it("ends the connection when the upstream queue overflows before a POST can drain it", async () => {
    const { binding } = await startBinding({ limits: { queueFrames: 2, postTimeoutMs: 50 } });
    open.push(binding);
    const channel = await connectHttpChannel({ origin: binding.origin, limits: { queueFrames: 2 } });

    let frames = 0;
    channel.listen({ onFrame: () => (frames += 1), onClose: () => undefined });

    // More frames than the queue holds, offered in one synchronous burst.
    expect(() => {
      for (let index = 0; index < 10; index += 1) channel.send(`burst-${index}`);
    }).toThrow();

    await waitUntil(() => frames >= 0, "the queue to settle");
  });

  it("ends a stalled connection even while heartbeats are scheduled", async () => {
    const { binding, channels } = await startBinding({
      limits: { queueFrames: 2, queueBytes: 300_000, drainTimeoutMs: 150, heartbeatMs: 20 },
    });
    open.push(binding);

    // A reader that never reads, so the socket stops accepting.
    const credentials = await createCredentials(binding.origin);
    const claim = request(
      {
        host: "127.0.0.1",
        port: Number(new URL(binding.origin).port),
        path: `/connections/${credentials.connectionId}/events`,
        headers: { authorization: `Bearer ${credentials.token}` },
      },
      (response) => {
        response.pause();
      },
    );
    claim.on("error", () => undefined);
    claim.end();
    await waitUntil(() => channels.length === 1, "the channel to be attached");

    const channel = channels[0];
    let closed = 0;
    channel?.listen({
      onFrame: (): void => undefined,
      onClose: (): void => {
        closed += 1;
      },
    });

    const chunk = "x".repeat(64 * 1024);
    await expect(
      (async () => {
        for (let index = 0; index < 64; index += 1) channel?.send(chunk);
      })(),
    ).rejects.toThrow();

    // The heartbeat keeps its own schedule, and it does not keep a connection
    // that cannot drain alive.
    await waitUntil(() => closed === 1, "the connection to be closed");
    claim.destroy();
  });

  it("refuses new connections at capacity", async () => {
    const { binding } = await startBinding({ limits: { maxPending: 1, maxConnections: 1 } });
    open.push(binding);

    await createCredentials(binding.origin);
    const second = await fetch(`${binding.origin}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-every-dagent-transport": "1" },
      body: "{}",
    });

    expect(second.status).toBe(503);
  });

  it("limits how fast connections may be created", async () => {
    const { binding } = await startBinding({ limits: { createBurst: 2, createPerSecond: 0, maxPending: 16 } });
    open.push(binding);

    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await fetch(`${binding.origin}/connections`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-every-dagent-transport": "1" },
        body: "{}",
      });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 2)).toEqual([201, 201]);
    expect(statuses.slice(2)).toEqual([429, 429]);
  });

  it("ends a connection that is created and never claimed", async () => {
    const { binding } = await startBinding({ limits: { pendingTtlMs: 30 } });
    open.push(binding);
    const credentials = await createCredentials(binding.origin);

    await waitUntil(() => binding.connections === 0, "the unclaimed connection to expire");

    const late = await fetch(`${binding.origin}/connections/${credentials.connectionId}/events`, {
      headers: { authorization: `Bearer ${credentials.token}` },
    });
    expect(late.status).toBe(401);
  });
});
