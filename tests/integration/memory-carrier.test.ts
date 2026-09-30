/**
 * The memory carrier's own contract.
 *
 * This is the fixture the integration tests lean on to prove the client and the
 * host do not depend on one transport, so its delivery guarantees have to hold
 * under their own tests: both directions drain without waiting for another
 * `send`, the byte budget is real UTF-8 bytes, every entry is charged and
 * released once, and every way it ends does so exactly once.
 */

import { describe, expect, it } from "vitest";

import type { ProtocolChannelListener } from "@every-dagent/protocol";

import { createCarrierPair, type CarrierPair } from "../helpers/protocol-carrier.js";

function collector(): { readonly frames: string[]; readonly closed: number[]; readonly listener: ProtocolChannelListener } {
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

function connected(options: Parameters<typeof createCarrierPair>[0] = {}): {
  readonly pair: CarrierPair;
  readonly atHost: ReturnType<typeof collector>;
  readonly atClient: ReturnType<typeof collector>;
} {
  const pair = createCarrierPair(options);
  const atHost = collector();
  const atClient = collector();
  pair.hostSide.listen(atHost.listener);
  pair.clientSide.listen(atClient.listener);
  return { pair, atHost, atClient };
}

describe("delivery", () => {
  it("drains both directions in the same turn, without another send to wake it", async () => {
    const { pair, atHost, atClient } = connected();

    pair.clientSide.send("upstream");
    pair.hostSide.send("downstream");

    await pair.settled();
    expect(atHost.frames).toEqual(["upstream"]);
    expect(atClient.frames).toEqual(["downstream"]);
  });

  it("keeps draining the direction that still has frames", async () => {
    const { pair, atHost } = connected();

    // A burst one way, and nothing the other way to wake the pump.
    for (let index = 0; index < 8; index += 1) pair.clientSide.send(`frame-${index}`);

    await pair.settled();
    expect(atHost.frames).toEqual([
      "frame-0",
      "frame-1",
      "frame-2",
      "frame-3",
      "frame-4",
      "frame-5",
      "frame-6",
      "frame-7",
    ]);
  });

  it("keeps each direction's FIFO order", async () => {
    const { pair, atHost, atClient } = connected();

    pair.clientSide.send("up-1");
    pair.hostSide.send("down-1");
    pair.clientSide.send("up-2");
    pair.hostSide.send("down-2");

    await pair.settled();
    expect(atHost.frames).toEqual(["up-1", "up-2"]);
    expect(atClient.frames).toEqual(["down-1", "down-2"]);
  });

  it("carries a frame a listener sends while it is being delivered to", async () => {
    const pair = createCarrierPair();
    const atClient = collector();
    const replies: string[] = [];
    pair.hostSide.listen({
      onFrame: (frame: string): void => {
        replies.push(frame);
        pair.hostSide.send(`echo:${frame}`);
      },
      onClose: (): void => undefined,
    });
    pair.clientSide.listen(atClient.listener);

    pair.clientSide.send("hello");

    await pair.settled();
    expect(replies).toEqual(["hello"]);
    expect(atClient.frames).toEqual(["echo:hello"]);
  });

  it("carries awkward frames exactly", async () => {
    const { pair, atHost, atClient } = connected();
    const awkward = 'a "frame" \\ with a lone surrogate \ud800, an emoji 🚀 and a newline\ninside';

    pair.clientSide.send(awkward);
    pair.hostSide.send(awkward);

    await pair.settled();
    expect(atHost.frames[0]).toBe(awkward);
    expect(atClient.frames[0]).toBe(awkward);
  });
});

describe("the byte budget", () => {
  it("counts UTF-8 bytes, not code units", async () => {
    const { pair } = connected({ limits: { maxBytes: 5 } });

    // One CJK character is three UTF-8 bytes, however short the string looks.
    expect(() => {
      pair.clientSide.send("中");
    }).not.toThrow();
    expect(() => {
      pair.clientSide.send("中中");
    }).toThrow();
  });

  it("accepts exactly the limit and refuses the next byte", async () => {
    const atLimit = connected({ limits: { maxBytes: 6 } });
    expect(() => {
      atLimit.pair.clientSide.send("ééé");
    }).not.toThrow();

    const overLimit = connected({ limits: { maxBytes: 6 } });
    expect(() => {
      overLimit.pair.clientSide.send("éééé");
    }).toThrow();
  });

  it("refuses one frame past the frame limit and accepts the one at it", async () => {
    const atLimit = connected({ limits: { maxFrames: 2, maxBytes: 1024 } });
    expect(() => {
      atLimit.pair.clientSide.send("one");
      atLimit.pair.clientSide.send("two");
    }).not.toThrow();

    const overLimit = connected({ limits: { maxFrames: 2, maxBytes: 1024 } });
    expect(() => {
      overLimit.pair.clientSide.send("one");
      overLimit.pair.clientSide.send("two");
      overLimit.pair.clientSide.send("three");
    }).toThrow();
  });

  it("returns its bytes to zero once everything is delivered", async () => {
    const { pair } = connected({ limits: { maxBytes: 64 } });

    for (let round = 0; round < 3; round += 1) {
      pair.clientSide.send("中文");
      pair.hostSide.send("🚀");
      await pair.settled();
      expect(pair.queued).toEqual({ clientToHost: 0, hostToClient: 0 });
    }
  });

  it("ends the connection when a frame does not fit", async () => {
    const { pair, atClient } = connected({ limits: { maxBytes: 4 } });

    expect(() => {
      pair.clientSide.send("中中");
    }).toThrow();

    expect(atClient.closed).toHaveLength(1);
    expect(() => {
      pair.hostSide.send("anything");
    }).toThrow();
  });
});

describe("ending", () => {
  it("tells both sides exactly once, however it is ended", async () => {
    const first = connected();
    first.pair.clientSide.close();
    first.pair.clientSide.close();
    first.pair.hostSide.close();
    expect(first.atClient.closed).toHaveLength(1);
    expect(first.atHost.closed).toHaveLength(1);

    const second = connected();
    second.pair.hostSide.close();
    expect(second.atClient.closed).toHaveLength(1);
    expect(second.atHost.closed).toHaveLength(1);
  });

  it("delivers nothing after it has ended", async () => {
    const { pair, atClient } = connected();
    pair.clientSide.send("queued");
    pair.clientSide.close();

    await pair.settled();
    expect(atClient.frames).toEqual([]);
    expect(() => {
      pair.clientSide.send("too late");
    }).toThrow();
  });

  it("refuses traffic before the receiving side is listening", () => {
    const pair = createCarrierPair();
    // Nobody is listening on the host side yet, so a client's frame would have
    // nowhere to go — and this fixture refuses to let it vanish.
    expect(() => {
      pair.clientSide.send("nobody is listening");
    }).toThrow(/listener must be installed/);
  });
});
