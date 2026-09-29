/**
 * The client channel: what a browser-shaped client gets from the binding.
 *
 * Everything here goes over a real socket, through the real framing, with the
 * channel the client core would use. What is checked is the transport's own
 * contract: frames arrive as strings, in order, exactly once; a listener is
 * installed before traffic; and every way a connection can end notifies the
 * owner exactly once.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { ProtocolChannel } from "@every-dagent/protocol";
import { connectHttpChannel } from "../src/index.js";

import { startBinding, waitUntil } from "./helpers/raw-peer.js";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const binding of open.splice(0)) await binding.close();
});

/**
 * One connected pair, with no listeners installed yet: each test installs the
 * ones it needs, because a channel only ever has one.
 */
async function connected(): Promise<{
  readonly channel: ProtocolChannel;
  readonly peer: ProtocolChannel;
  readonly peerClosed: number[];
}> {
  const { binding, channels } = await startBinding();
  open.push(binding);

  const channel = await connectHttpChannel({ origin: binding.origin });
  await waitUntil(() => channels.length === 1, "the binding's channel");
  const peer = channels[0];
  if (peer === undefined) throw new Error("the binding attached no channel");

  return { channel, peer, peerClosed: [] };
}

/** A listener that records what it is given. */
function collector(): { readonly frames: string[]; readonly listener: { onFrame(frame: string): void; onClose(): void }; readonly closed: number[] } {
  const frames: string[] = [];
  const closed: number[] = [];
  return {
    frames,
    closed,
    listener: {
      onFrame: (frame: string): void => {
        frames.push(frame);
      },
      onClose: (): void => {
        closed.push(1);
      },
    },
  };
}

describe("connecting", () => {
  it("resolves only once the downstream is live", async () => {
    const { binding, channels } = await startBinding();
    open.push(binding);

    const channel = await connectHttpChannel({ origin: binding.origin });

    expect(channels).toHaveLength(1);
    channel.close();
  });

  it("refuses to connect when nothing is listening", async () => {
    await expect(connectHttpChannel({ origin: "http://127.0.0.1:9" })).rejects.toThrow();
  });
});

describe("carrying frames", () => {
  it("delivers both directions in order, as strings", async () => {
    const { channel, peer } = await connected();
    const atPeer = collector();
    const atClient = collector();
    peer.listen(atPeer.listener);
    channel.listen(atClient.listener);

    for (const frame of ["one", "two", "three"]) channel.send(frame);
    for (const frame of ["answer-one", "answer-two"]) peer.send(frame);

    await waitUntil(() => atPeer.frames.length === 3 && atClient.frames.length === 2, "all five frames");
    expect(atPeer.frames).toEqual(["one", "two", "three"]);
    expect(atClient.frames).toEqual(["answer-one", "answer-two"]);
    expect(typeof atPeer.frames[0]).toBe("string");
    channel.close();
  });

  it("carries every kind of protocol message unchanged", async () => {
    const { channel, peer } = await connected();
    const shapes = [
      '{"kind":"client-request","method":"host.describe"}',
      '{"kind":"client-response","requestId":"r-1","result":{"echoed":"ok"}}',
      '{"kind":"host-response","requestId":"r-1","result":{"snapshot":{}}}',
      '{"kind":"host-event","sequence":1,"type":"session.created"}',
      '{"kind":"host-request","requestId":"h-1","method":"test.echo","timeoutMs":1000}',
    ];
    const atPeer = collector();
    peer.listen(atPeer.listener);
    channel.listen(collector().listener);

    for (const shape of shapes) channel.send(shape);
    await waitUntil(() => atPeer.frames.length === shapes.length, "the frames to arrive");

    expect(atPeer.frames).toEqual(shapes);
    channel.close();
  });

  it("handshakes with frames that contain awkward characters", async () => {
    const { channel, peer } = await connected();
    const received: string[] = [];
    peer.listen({ onFrame: (frame: string) => received.push(frame), onClose: () => undefined });
    channel.listen({ onFrame: () => undefined, onClose: () => undefined });

    const awkward = ["quote \" backslash \\ newline \n tab \t", "surrogate \ud800 pair 🚀", "unicode é ü 中文"];
    for (const frame of awkward) channel.send(frame);
    await waitUntil(() => received.length === awkward.length, "the awkward frames");

    expect(received).toEqual(awkward);
    channel.close();
  });

  it("buffers frames that arrive before the client listens", async () => {
    const { channel, peer } = await connected();

    // The binding sends before the client has a listener: those frames must be
    // waiting when it installs one, in order, rather than being lost.
    peer.send("early-one");
    peer.send("early-two");
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    const atClient = collector();
    channel.listen(atClient.listener);
    await waitUntil(() => atClient.frames.length === 2, "the buffered frames");

    expect(atClient.frames).toEqual(["early-one", "early-two"]);
    channel.close();
  });

  it("refuses a second listener", async () => {
    const { channel } = await connected();
    channel.listen({ onFrame: () => undefined, onClose: () => undefined });

    expect(() => channel.listen({ onFrame: () => undefined, onClose: () => undefined })).toThrow();
    channel.close();
  });
});

describe("ending a connection", () => {
  it("tells the owner once when the client closes", async () => {
    const { channel, peer, peerClosed } = await connected();
    const atPeer = collector();
    const atClient = collector();
    peer.listen({ onFrame: atPeer.listener.onFrame, onClose: () => peerClosed.push(1) });
    channel.listen(atClient.listener);

    channel.close();
    channel.close();

    await waitUntil(() => peerClosed.length === 1, "the binding's channel to be told");
    expect(atClient.closed).toHaveLength(1);
  });

  it("tells the owner when the binding goes away", async () => {
    const { binding, channels } = await startBinding();
    open.push(binding);
    const channel = await connectHttpChannel({ origin: binding.origin });
    await waitUntil(() => channels.length === 1, "the binding's channel");

    let notified = 0;
    channel.listen({ onFrame: () => undefined, onClose: () => (notified += 1) });

    channels[0]?.close();

    await waitUntil(() => notified === 1, "the client to be told");
    expect(notified).toBe(1);
  });

  it("refuses to send after it is closed", async () => {
    const { channel } = await connected();
    channel.listen({ onFrame: () => undefined, onClose: () => undefined });
    channel.close();

    expect(() => channel.send("a frame")).toThrow();
  });
});
