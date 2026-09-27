import { describe, expect, it } from "vitest";

import { createSession, restoreSession } from "../src/session/session.js";
import type { SessionEvent } from "../src/session/session-event.js";

describe("restoreSession", () => {
  it("rebuilds a session from the events it recorded", () => {
    const live = createSession("s-1");
    live.append({ type: "turn/start", turnId: "t1", data: {} });
    live.append({ type: "message/user", turnId: "t1", data: { text: "hi" } });
    live.append({ type: "message/assistant", turnId: "t1", data: { text: "hello", toolCalls: [] } });

    const restored = restoreSession("s-1", live.events());

    // Byte for byte the same log, envelope included: a stored log is a record of what
    // happened, not a draft to be renumbered.
    expect(restored.events()).toEqual(live.events());
    expect(restored.deriveMessages()).toEqual(live.deriveMessages());
  });

  it("keeps the seq and time of the log instead of assigning new ones", () => {
    const live = createSession("s-1");
    const recorded = live.append({ type: "message/user", turnId: "t1", data: { text: "hi" } });

    const restored = restoreSession("s-1", live.events()).events();

    expect(restored[0]?.seq).toBe(recorded.seq);
    expect(restored[0]?.time).toBe(recorded.time);
  });

  it("freezes a restored log the way a recorded one is frozen", () => {
    const loose: SessionEvent[] = [
      { type: "message/user", turnId: "t1", seq: 0, time: 1, data: { text: "hi" } },
    ];

    const restored = restoreSession("s-1", loose);

    const [event] = restored.events();
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event?.data)).toBe(true);
  });

  it("does not keep the array it was handed", () => {
    const live = createSession("s-1");
    live.append({ type: "turn/start", turnId: "t1", data: {} });
    const handed = [...live.events()];

    const restored = restoreSession("s-1", handed);
    handed.length = 0;

    expect(restored.events()).toHaveLength(1);
  });

  it("refuses a log whose seq does not continue from zero", () => {
    const live = createSession("s-1");
    const event = live.append({ type: "turn/start", turnId: "t1", data: {} });

    expect(() => restoreSession("s-1", [{ ...event, seq: 4 }])).toThrow(/expected seq 0/);
  });

  it("refuses a log with a hole in it", () => {
    const live = createSession("s-1");
    live.append({ type: "turn/start", turnId: "t1", data: {} });
    const sparse = [...live.events()];
    sparse.length = 2;

    expect(() => restoreSession("s-1", sparse)).toThrow(/hole at seq 1/);
  });

  it("continues the log after the restored events", () => {
    const live = createSession("s-1");
    live.append({ type: "turn/start", turnId: "t1", data: {} });
    live.append({ type: "message/user", turnId: "t1", data: { text: "hi" } });

    const restored = restoreSession("s-1", live.events());
    const appended = restored.append({
      type: "message/assistant",
      turnId: "t1",
      data: { text: "hello", toolCalls: [] },
    });

    expect(appended.seq).toBe(2);
    expect(restored.events().map((event) => event.seq)).toEqual([0, 1, 2]);
  });
});
