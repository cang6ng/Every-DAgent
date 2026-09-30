/**
 * The binding's behavior: who may connect, what a 204 means, and how a
 * connection ends.
 *
 * The security checks are the binding's own boundary — loopback, exact host, an
 * explicit origin allowlist and a transport header a cross-site form cannot
 * set — and they are tested here rather than assumed. The delivery checks are
 * about honesty: a 204 is the carrier's answer, never the host's, and a frame
 * that cannot be carried ends the connection instead of vanishing.
 */

import { request } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { ProtocolChannel } from "@every-dagent/protocol";

import { wrapFrame } from "../src/index.js";

import { createCredentials, openRawPeer, startBinding, waitUntil } from "./helpers/raw-peer.js";

const TRANSPORT_HEADER = "x-every-dagent-transport";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const binding of open.splice(0)) await binding.close();
});

async function bindingWithHost(): Promise<{
  readonly origin: string;
  readonly channels: ProtocolChannel[];
  readonly binding: { close(): Promise<void> };
}> {
  const { binding, channels } = await startBinding();
  open.push(binding);
  return { origin: binding.origin, channels, binding };
}

describe("creating a connection", () => {
  it("answers with an opaque id and a token, and never caches", async () => {
    const { origin } = await bindingWithHost();

    const response = await fetch(`${origin}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", [TRANSPORT_HEADER]: "1" },
      body: "{}",
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { connectionId: string; token: string };
    expect(body.connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.token.length).toBeGreaterThan(32);
  });

  it("refuses a create without the transport header", async () => {
    const { origin } = await bindingWithHost();

    const response = await fetch(`${origin}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(403);
  });

  it("refuses a create that is not JSON", async () => {
    const { origin } = await bindingWithHost();

    const response = await fetch(`${origin}/connections`, {
      method: "POST",
      headers: { "content-type": "text/plain", [TRANSPORT_HEADER]: "1" },
      body: "hello",
    });

    expect(response.status).toBe(403);
  });

  it("refuses an origin that is not on the allowlist, and accepts one that is", async () => {
    const { binding, channels } = await startBinding({ originAllowlist: ["http://allowed.example"] });
    open.push(binding);
    channels.length = 0;

    const refused = await fetch(`${binding.origin}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", [TRANSPORT_HEADER]: "1", origin: "http://evil.example" },
      body: "{}",
    });
    const allowed = await fetch(`${binding.origin}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", [TRANSPORT_HEADER]: "1", origin: "http://allowed.example" },
      body: "{}",
    });

    expect(refused.status).toBe(403);
    expect(allowed.status).toBe(201);
  });

  it("refuses a request addressed to another host", async () => {
    const { origin } = await bindingWithHost();
    const port = new URL(origin).port;

    // `fetch` will not let a caller forge `Host`, so this one goes over the
    // wire the way a confused or hostile client would send it.
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/connections",
          headers: {
            host: "somewhere.example",
            "content-type": "application/json",
            [TRANSPORT_HEADER]: "1",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      outgoing.on("error", reject);
      outgoing.end("{}");
    });

    expect(status).toBe(421);
  });
});

describe("claiming the stream", () => {
  it("refuses a claim with the wrong token or an unknown id", async () => {
    const { origin } = await bindingWithHost();
    const credentials = await createCredentials(origin);

    const wrongToken = await fetch(`${origin}/connections/${credentials.connectionId}/events`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    const unknownId = await fetch(`${origin}/connections/00000000-0000-0000-0000-000000000000/events`, {
      headers: { authorization: `Bearer ${credentials.token}` },
    });

    expect(wrongToken.status).toBe(401);
    expect(unknownId.status).toBe(401);
  });

  it("gives a connection exactly one downstream", async () => {
    const { origin, channels } = await bindingWithHost();
    const credentials = await createCredentials(origin);

    const peer = await openRawPeer(origin, { reuse: credentials });

    const second = await fetch(`${origin}/connections/${credentials.connectionId}/events`, {
      headers: { authorization: `Bearer ${credentials.token}` },
    });

    expect(second.status).toBe(409);
    expect(channels).toHaveLength(1);
    peer.close();
  });

  it("writes a ready marker before anything else", async () => {
    const { origin } = await bindingWithHost();
    const peer = await openRawPeer(origin);

    await waitUntil(() => peer.raw.length > 0, "the ready marker");
    expect(peer.raw.slice(0, 9)).toBe(": ready\n\n");
    peer.close();
  });

  it("ends the downstream when its token is used for another connection", async () => {
    const { origin, channels } = await bindingWithHost();
    const first = await createCredentials(origin);
    const second = await createCredentials(origin);

    const peer = await openRawPeer(origin, { reuse: first });
    const answer = await fetch(`${origin}/connections/${second.connectionId}/frames`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TRANSPORT_HEADER]: "1",
        authorization: `Bearer ${first.token}`,
      },
      body: JSON.stringify("a frame"),
    });

    expect(answer.status).toBe(401);
    expect(channels).toHaveLength(1);
    peer.close();
  });
});

describe("carrying frames", () => {
  it("delivers an upstream frame to the channel in order, and answers 204", async () => {
    const { origin, channels } = await bindingWithHost();
    const peer = await openRawPeer(origin);
    const channel = channels[0];
    expect(channel).toBeDefined();

    const received: string[] = [];
    channel?.listen({ onFrame: (frame: string) => received.push(frame), onClose: () => undefined });

    const statuses = [await peer.post("first"), await peer.post("second"), await peer.post("third")];

    expect(statuses).toEqual([204, 204, 204]);
    await waitUntil(() => received.length === 3, "the frames to arrive");
    expect(received).toEqual(["first", "second", "third"]);
    peer.close();
  });

  it("buffers frames that arrive before the channel has a listener", async () => {
    const { origin, channels } = await bindingWithHost();
    const peer = await openRawPeer(origin);
    const channel = channels[0];
    expect(channel).toBeDefined();

    // The frame is accepted while nobody is listening yet.
    expect(await peer.post("early")).toBe(204);

    const received: string[] = [];
    channel?.listen({ onFrame: (frame: string) => received.push(frame), onClose: () => undefined });
    await waitUntil(() => received.length === 1, "the buffered frame to arrive");

    expect(received).toEqual(["early"]);
    peer.close();
  });

  it("answers a body that is not a wrapped frame by ending the connection", async () => {
    const { origin } = await bindingWithHost();
    const peer = await openRawPeer(origin);

    expect(await peer.postRaw('{"kind":"host-response"}')).toBe(400);
    await waitUntil(() => peer.ended, "the downstream to end");
  });

  it("sends downstream frames in order and as wrapped records", async () => {
    const { origin, channels } = await bindingWithHost();
    const peer = await openRawPeer(origin);
    const channel = channels[0];

    channel?.send("first");
    channel?.send('second "with quotes"');

    await peer.waitForFrames(2);
    expect(peer.frames).toEqual(["first", 'second "with quotes"']);
    // The raw text really is `data: <json string>` — the wrapper is on the wire.
    expect(peer.raw).toContain('data: "first"\n\n');
    expect(peer.raw).toContain('data: "second \\"with quotes\\""\n\n');
    peer.close();
  });

  it("ends the logical connection when either side closes it", async () => {
    const { origin, channels } = await bindingWithHost();
    const peer = await openRawPeer(origin);
    const channel = channels[0];
    let closed = 0;
    channel?.listen({ onFrame: () => undefined, onClose: () => (closed += 1) });

    peer.close();

    await waitUntil(() => closed === 1, "the channel to be told");
    expect(closed).toBe(1);
  });

  it("does not wait for the host before answering upstream", async () => {
    const { origin, channels } = await bindingWithHost();
    const peer = await openRawPeer(origin);
    const channel = channels[0];

    // A listener that takes forever: the 204 has already been sent for each frame.
    channel?.listen({
      onFrame: () => {
        // Deliberately does nothing, and never answers.
      },
      onClose: () => undefined,
    });

    const started = Date.now();
    expect(await peer.post("a frame the host never answers")).toBe(204);
    expect(Date.now() - started).toBeLessThan(1000);
    peer.close();
  });

  it("refuses frames on a connection whose stream is gone", async () => {
    const { origin } = await bindingWithHost();
    const credentials = await createCredentials(origin);

    const answer = await fetch(`${origin}/connections/${credentials.connectionId}/frames`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TRANSPORT_HEADER]: "1",
        authorization: `Bearer ${credentials.token}`,
      },
      body: JSON.stringify("a frame"),
    });

    expect(answer.status).toBe(409);
  });

  it("decodes an upstream body whose bytes are split mid-character", async () => {
    const { origin, channels } = await bindingWithHost();
    const peer = await openRawPeer(origin);
    const channel = channels[0];
    const received: string[] = [];
    channel?.listen({
      onFrame: (frame: string): void => {
        received.push(frame);
      },
      onClose: (): void => undefined,
    });

    // The body is sent byte by byte, so every multi-byte character is split
    // across chunk boundaries; one decoder has to put it back together.
    const frame = 'a phrase in Chinese: 中文字符 and an emoji: 🚀';
    const body = wrapFrame(frame);
    const bytes = new TextEncoder().encode(body);
    const port = Number(new URL(origin).port);
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: `/connections/${peer.connectionId}/frames`,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${peer.token}`,
            "x-every-dagent-transport": "1",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      outgoing.on("error", reject);
      for (const byte of bytes) outgoing.write(Buffer.from([byte]));
      outgoing.end();
    });

    expect(status).toBe(204);
    await waitUntil(() => received.length === 1, "the frame to arrive");
    expect(received[0]).toBe(frame);
    peer.close();
  });

  it("refuses a body that is not valid UTF-8", async () => {
    const { origin } = await bindingWithHost();
    const peer = await openRawPeer(origin);

    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        {
          host: "127.0.0.1",
          port: Number(new URL(origin).port),
          method: "POST",
          path: `/connections/${peer.connectionId}/frames`,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${peer.token}`,
            "x-every-dagent-transport": "1",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      outgoing.on("error", reject);
      // A lone continuation byte cannot begin a character.
      outgoing.end(Buffer.from([0x22, 0x80, 0x22]));
    });

    expect(status).toBe(400);
    await waitUntil(() => peer.ended, "the connection to end");
  });

  it("refuses a downstream frame that does not fit the binding's limit", async () => {
    const { binding, channels } = await startBinding({ limits: { frameBytes: 32 } });
    open.push(binding);
    const peer = await openRawPeer(binding.origin);
    await waitUntil(() => channels.length === 1, "the channel");
    const channel = channels[0];
    let closed = 0;
    channel?.listen({
      onFrame: (): void => undefined,
      onClose: (): void => {
        closed += 1;
      },
    });

    expect(() => {
      channel?.send("x".repeat(33));
    }).toThrow(/does not fit/);

    await waitUntil(() => closed === 1, "the connection to be told");
    peer.close();
  });

  it("carries the awkward frames exactly", async () => {
    const { origin, channels } = await bindingWithHost();
    const peer = await openRawPeer(origin);
    const channel = channels[0];
    const awkward = 'a "frame" with \\ backslashes, a lone surrogate \ud800 and a newline\ninside';

    const received: string[] = [];
    channel?.listen({ onFrame: (frame: string) => received.push(frame), onClose: () => undefined });
    await peer.post(awkward);
    await waitUntil(() => received.length === 1, "the awkward frame");

    const toClient = received[0];
    expect(toClient).toBe(awkward);

    channel?.send(awkward);
    await peer.waitForFrames(1);
    expect(peer.frames[0]).toBe(awkward);
    peer.close();
  });
});
