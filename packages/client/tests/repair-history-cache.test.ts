/**
 * R18: the client's history cache is finite, and forgetting is honest.
 *
 * The pages a client has read are presentation state, not a store: a reader
 * scrolling through a long conversation must not grow the replica without
 * bound, and a client that has forgotten a page must say "not loaded" rather
 * than claim the history does not exist or is complete. These tests drive the
 * fold the way a page answer drives it, and assert both halves — the budget,
 * and what the remaining coverage is allowed to claim.
 */

import { describe, expect, it } from "vitest";

import type { CanonicalItem, HistoryPage } from "@every-dagent/protocol";

import { applyHistoryPage, HISTORY_CACHE_LIMITS, type HistoryMap } from "../src/fold.js";

const STORAGE = "storage-1";

function item(seq: number, text = `item ${seq}`): CanonicalItem {
  return { id: `s-1:${seq}`, turnId: "turn-1", seq, kind: "user", text };
}

interface PageParts {
  readonly sessionId?: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly atStart: boolean;
  readonly nextCursor: string | null;
  readonly items: readonly CanonicalItem[];
  readonly fenceSeq?: number;
  readonly atFence?: boolean;
}

function page(parts: PageParts): HistoryPage {
  const sessionId = parts.sessionId ?? "s-1";
  return {
    storageId: STORAGE,
    sessionId,
    generation: 1,
    historyRevision: 1,
    fenceSeq: parts.fenceSeq ?? 10_000,
    direction: "backward",
    items: parts.items,
    coverage: { fromSeq: parts.fromSeq, toSeq: parts.toSeq },
    startsAtTurnBoundary: true,
    endsAtTurnBoundary: true,
    atStart: parts.atStart,
    atFence: parts.atFence ?? false,
    nextCursor: parts.nextCursor,
  };
}

/** The number of items and bytes one map currently holds. */
function held(history: HistoryMap): { items: number; bytes: number; sessions: number } {
  let items = 0;
  let bytes = 0;
  for (const coverage of Object.values(history)) {
    for (const segment of coverage.segments) {
      items += segment.items.length;
      bytes += segment.bytes;
    }
  }
  return { items, bytes, sessions: Object.keys(history).length };
}

describe("R18 client history cache budget", () => {
  it("stays inside its item bound while one session is read backwards page by page", () => {
    let history: HistoryMap = Object.freeze({});
    const pages = HISTORY_CACHE_LIMITS.maxItems + 100;
    let floor = pages;

    // Pages of one item each, each continuing the one before it — more pages
    // than the cache may hold, so it has to forget some of them.
    for (let index = 0; index < pages; index += 1) {
      const toSeq = floor;
      floor -= 1;
      history = applyHistoryPage(
        history,
        page({ fromSeq: floor, toSeq, atStart: false, nextCursor: `cursor-${floor}`, items: [item(floor)] }),
      );
    }

    const size = held(history);
    expect(size.items).toBeLessThanOrEqual(HISTORY_CACHE_LIMITS.maxItems);

    // What remains is a smaller, contiguous window — and it says what it is:
    // not the start of the conversation, and still continuable.
    const coverage = history["s-1"];
    expect(coverage).toBeDefined();
    expect(coverage?.atStart).toBe(false);
    expect(coverage?.items.length).toBe(size.items);
    expect(coverage?.fromSeq).toBe(coverage?.items[0]?.seq);
    expect(coverage?.nextCursor).not.toBeNull();
    // The pages just read are the ones kept — the reader is walking backwards —
    // and the newest end is what was forgotten.
    expect(coverage?.toSeq).toBeLessThan(pages);
    expect(coverage?.atFence).toBe(false);

    // The traversal itself never broke: the next older page still continues the
    // loaded range instead of replacing it.
    const before = history["s-1"]?.segments.length ?? 0;
    history = applyHistoryPage(
      history,
      page({ fromSeq: coverage?.fromSeq !== undefined ? coverage.fromSeq - 1 : 0, toSeq: coverage?.fromSeq ?? 0, atStart: false, nextCursor: "next", items: [item((coverage?.fromSeq ?? 1) - 1)] }),
    );
    const after = history["s-1"];
    // Still one continued traversal — a replacement would have reset it to the
    // single arriving page — with the newest end forgotten to make room.
    expect(after?.segments.length).toBeGreaterThan(500);
    expect(after?.segments.length).toBeLessThanOrEqual(before);
    expect(after?.fromSeq).toBe((coverage?.fromSeq ?? 0) - 1);
  });

  it("stays inside its byte bound while one session is read with large items", () => {
    let history: HistoryMap = Object.freeze({});
    const payload = "x".repeat(4 * 1024);
    let floor = 300;

    for (let index = 0; index < 300; index += 1) {
      const toSeq = floor;
      floor -= 1;
      history = applyHistoryPage(
        history,
        page({
          fromSeq: floor,
          toSeq,
          atStart: false,
          nextCursor: `cursor-${floor}`,
          items: [item(floor, `${payload}-${index}`)],
        }),
      );
    }

    const size = held(history);
    expect(size.bytes).toBeLessThanOrEqual(HISTORY_CACHE_LIMITS.maxBytes);
    expect(size.items).toBeLessThan(300);
    // And the map is still one coherent coverage, not a pile of fragments.
    expect(history["s-1"]?.segments.length).toBe(size.items);
  });

  it("keeps at most its session bound, forgetting the least recently read", () => {
    let history: HistoryMap = Object.freeze({});

    for (let index = 0; index < 20; index += 1) {
      const sessionId = `s-${index}`;
      history = applyHistoryPage(
        history,
        page({
          sessionId,
          fromSeq: 0,
          toSeq: 1,
          atStart: true,
          nextCursor: null,
          items: [item(0, `item of ${sessionId}`)],
        }),
      );
    }

    expect(Object.keys(history)).toHaveLength(HISTORY_CACHE_LIMITS.maxSessions);
    // The most recent reads survive; the earliest ones are gone.
    expect(history["s-19"]).toBeDefined();
    expect(history["s-0"]).toBeUndefined();
  });

  it("reads a forgotten session back rather than pretending it has none", () => {
    let history: HistoryMap = Object.freeze({});
    for (let index = 0; index < HISTORY_CACHE_LIMITS.maxSessions + 2; index += 1) {
      history = applyHistoryPage(
        history,
        page({
          sessionId: `s-${index}`,
          fromSeq: 0,
          toSeq: 1,
          atStart: true,
          nextCursor: null,
          items: [item(0)],
        }),
      );
    }
    expect(history["s-0"]).toBeUndefined();

    // Reading it again produces exactly the page that was read — not a claim
    // that the range in between exists.
    history = applyHistoryPage(
      history,
      page({
        sessionId: "s-0",
        fromSeq: 0,
        toSeq: 1,
        atStart: true,
        nextCursor: null,
        items: [item(0, "re-read")],
      }),
    );
    expect(history["s-0"]?.items.map((entry) => (entry.kind === "user" ? entry.text : ""))).toEqual(["re-read"]);
    expect(history["s-0"]?.atStart).toBe(true);
    expect(history["s-0"]?.nextCursor).toBeNull();
  });

  it("moves the loaded window to a newer fence instead of claiming the old range complete", () => {
    let history: HistoryMap = Object.freeze({});
    history = applyHistoryPage(
      history,
      page({ fromSeq: 0, toSeq: 5, atStart: true, nextCursor: null, items: [item(1), item(2)] }),
    );
    // A newer fence arrives: what the client holds is now the newer traversal,
    // and its coverage says so rather than gluing the two together.
    history = applyHistoryPage(
      history,
      page({ fromSeq: 5, toSeq: 9, atStart: false, atFence: true, nextCursor: "more", items: [item(6)], fenceSeq: 9 }),
    );

    const coverage = history["s-1"];
    expect(coverage?.fromSeq).toBe(5);
    expect(coverage?.toSeq).toBe(9);
    expect(coverage?.atFence).toBe(true);
    expect(coverage?.fenceSeq).toBe(9);
    expect(coverage?.atStart).toBe(false);
  });

  it("does not merge a page from another fence onto what is loaded", () => {
    let history: HistoryMap = Object.freeze({});
    history = applyHistoryPage(
      history,
      page({ fromSeq: 0, toSeq: 4, atStart: true, nextCursor: null, items: [item(1)], fenceSeq: 4 }),
    );
    // A page from a different fence that happens to meet at the boundary: it is
    // a different traversal, so it replaces rather than stitching.
    history = applyHistoryPage(
      history,
      page({ fromSeq: 0, toSeq: 4, atStart: true, nextCursor: null, items: [item(2)], fenceSeq: 40 }),
    );

    expect(history["s-1"]?.fenceSeq).toBe(40);
    expect(history["s-1"]?.items.map((entry) => entry.seq)).toEqual([2]);
  });
});
