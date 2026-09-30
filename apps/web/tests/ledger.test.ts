/**
 * The ledger of one connection, and who is allowed to move it.
 *
 * A record the socket took and has not flushed is retained work: it is counted
 * while it is in flight and given back when the socket drains. Both halves can
 * happen after the connection has already ended — a drain arrives late, a write
 * ends the connection before it returns — and neither may move a ledger that has
 * been retired. The two counterexamples below are exactly those two
 * continuations, and the invariant they protect is that a closed connection's
 * ledger stays `(0, 0)`.
 *
 * The ledger lives inside the binding, so this file observes the real one: the
 * factory is wrapped for the length of these tests, and every ledger a binding
 * creates is kept. Nothing else about the module changes.
 */

import { ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProtocolChannel } from "@every-dagent/protocol";

import { encodeSseRecord, utf8Length, type HttpBinding, type WebLimits } from "../src/index.js";
import { createLedger, type Ledger } from "../src/transport/ledger.js";

import { openRawPeer, startBinding, waitUntil, type RawPeer } from "./helpers/raw-peer.js";

const observed = vi.hoisted(() => ({ ledgers: [] as Ledger[] }));

vi.mock("../src/transport/ledger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/transport/ledger.js")>();
  return {
    ...original,
    createLedger: (): Ledger => {
      const ledger = original.createLedger();
      observed.ledgers.push(ledger);
      return ledger;
    },
  };
});

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

/**
 * A socket that takes every data record without flushing it, and hands the test
 * the drain the binding armed for it — the continuation a real socket would run
 * later, under the test's control instead of the kernel's.
 */
function stalled(run: (drains: (() => void)[]) => Promise<void>, onRecord?: (record: string) => void): Promise<void> {
  const drains: (() => void)[] = [];
  const originalWrite = ServerResponse.prototype.write;
  const originalOnce = ServerResponse.prototype.once;

  ServerResponse.prototype.write = function (this: ServerResponse, chunk: unknown, ...rest: never[]): boolean {
    const accepted = (originalWrite as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
    const record = String(chunk);
    if (!record.startsWith("data:")) return accepted;
    onRecord?.(record);
    return false;
  };
  (ServerResponse.prototype as unknown as { once: unknown }).once = function (
    this: ServerResponse,
    event: string,
    listener: () => void,
  ): unknown {
    if (event === "drain") drains.push(listener);
    return originalOnce.call(this, event, listener);
  };

  return run(drains).finally(() => {
    ServerResponse.prototype.write = originalWrite;
    ServerResponse.prototype.once = originalOnce;
  });
}

interface Rig {
  readonly binding: HttpBinding;
  readonly channel: ProtocolChannel;
  readonly peer: RawPeer;
  readonly ledger: Ledger;
}

/** One established connection, with the ledger the binding gave it. */
async function openOne(limits: Partial<WebLimits> = {}): Promise<Rig> {
  const before = observed.ledgers.length;
  const { binding, channels } = await startBinding({ limits });
  open.push(binding);
  const peer = await openRawPeer(binding.origin);
  await waitUntil(() => channels.length === 1, "the channel to attach");

  const channel = channels[0];
  const ledger = observed.ledgers.at(-1);
  if (channel === undefined || ledger === undefined || observed.ledgers.length !== before + 1) {
    throw new Error("the binding did not make exactly one ledger for one connection");
  }
  return { binding, channel, peer, ledger };
}

describe("the ledger", () => {
  it("counts what it retains and gives back exactly what it counted", () => {
    const ledger = createLedger();
    expect([ledger.frames, ledger.bytes, ledger.retired]).toEqual([0, 0, false]);

    ledger.retain(ledger.generation, 1, 12);
    ledger.retain(ledger.generation, 1, 30);
    expect([ledger.frames, ledger.bytes]).toEqual([2, 42]);

    ledger.release(ledger.generation, 1, 12);
    expect([ledger.frames, ledger.bytes]).toEqual([1, 30]);
    ledger.release(ledger.generation, 1, 30);
    expect([ledger.frames, ledger.bytes]).toEqual([0, 0]);
  });

  it("refuses every call once it is retired, whatever generation it presents", () => {
    const ledger = createLedger();
    const held = ledger.generation;
    ledger.retain(held, 1, 12);
    expect([ledger.frames, ledger.bytes]).toEqual([1, 12]);

    ledger.retire();
    expect([ledger.frames, ledger.bytes, ledger.retired]).toEqual([0, 0, true]);

    // The two continuations that outlive a connection, and the generation that
    // was live when they were issued — they are all speaking for a ledger that
    // no longer exists.
    ledger.release(held, 1, 12);
    ledger.retain(held, 1, 12);
    ledger.release(ledger.generation, 1, 12);
    expect([ledger.frames, ledger.bytes]).toEqual([0, 0]);

    // And retiring again is not a way back in.
    ledger.retire();
    expect([ledger.frames, ledger.bytes, ledger.retired]).toEqual([0, 0, true]);
    ledger.retain(ledger.generation, 5, 500);
    expect([ledger.frames, ledger.bytes]).toEqual([0, 0]);
  });

  it("refuses a holder whose generation has been retired under it", () => {
    const ledger = createLedger();
    const stale = ledger.generation;
    expect(ledger.generation).toBe(stale);
    ledger.retire();
    expect(ledger.generation).toBe(stale + 1);

    ledger.retain(stale, 1, 1);
    expect([ledger.frames, ledger.bytes]).toEqual([0, 0]);
  });
});

describe("a connection's ledger", () => {
  it("counts the record in flight, in the bytes the socket was given", async () => {
    const rig = await openOne({ drainTimeoutMs: 2000 });
    const record = encodeSseRecord("payload");

    await stalled(async () => {
      rig.channel.send("payload");
      // One record, and its encoded size — not the size of the frame it wraps.
      expect([rig.ledger.frames, rig.ledger.bytes]).toEqual([1, utf8Length(record)]);
    });

    rig.peer.close();
  });

  it("stays empty when a drain arrives after the connection closed", async () => {
    const rig = await openOne({ drainTimeoutMs: 2000 });

    await stalled(async (drains) => {
      rig.channel.send("payload");
      expect([rig.ledger.frames, rig.ledger.bytes]).toEqual([1, utf8Length(encodeSseRecord("payload"))]);

      // The connection ends with the record still on the books, and the ledger
      // is retired — it owes nothing, and it is final.
      rig.channel.close();
      expect([rig.ledger.frames, rig.ledger.bytes, rig.ledger.retired]).toEqual([0, 0, true]);

      // The drain the socket was always going to fire, arriving after the end.
      expect(drains).toHaveLength(1);
      drains[0]?.();
      expect([rig.ledger.frames, rig.ledger.bytes]).toEqual([0, 0]);
    });

    rig.peer.close();
  });

  it("stays empty when the write itself ends the connection", async () => {
    const rig = await openOne({ drainTimeoutMs: 2000 });

    await stalled(
      async () => {
        // The write is what ends the connection: closing inside it is the
        // reentrancy that used to put the record back on a retired ledger.
        rig.channel.send("payload");
        expect([rig.ledger.frames, rig.ledger.bytes, rig.ledger.retired]).toEqual([0, 0, true]);
      },
      () => {
        rig.channel.close();
      },
    );

    // A closed connection stays closed, and its ledger stays empty.
    expect(() => {
      rig.channel.send("more");
    }).toThrow();
    expect([rig.ledger.frames, rig.ledger.bytes]).toEqual([0, 0]);
    rig.peer.close();
  });
});
