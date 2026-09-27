import { describe, expect, it } from "vitest";

import { createSession } from "../src/session/session.js";
import type { Session } from "../src/session/session.js";
import type { SessionEvent } from "../src/session/session-event.js";

describe("createSession", () => {
  it("keeps the id it was created with", () => {
    expect(createSession("session-1").id).toBe("session-1");
  });

  it("starts with an empty log", () => {
    expect(createSession("session-1").events()).toEqual([]);
  });
});

describe("Session.append", () => {
  it("assigns a contiguous seq starting at zero", () => {
    const session = createSession("s");

    const first = session.append({ type: "turn/start", turnId: "t1", data: {} });
    const second = session.append({ type: "message/user", turnId: "t1", data: { text: "hi" } });
    const third = session.append({ type: "turn/end", turnId: "t1", data: { reason: "completed" } });

    expect([first.seq, second.seq, third.seq]).toEqual([0, 1, 2]);
    expect(session.events()).toHaveLength(3);
  });

  it("keeps seq aligned with the log length", () => {
    const session = createSession("s");

    const event = session.append({ type: "turn/start", turnId: "t1", data: {} });

    expect(event.seq).toBe(session.events().length - 1);
  });

  it("returns the recorded event, carrying the caller's turnId", () => {
    const session = createSession("s");

    const event = session.append({ type: "message/user", turnId: "turn-7", data: { text: "hello" } });

    expect(event.type).toBe("message/user");
    expect(event.turnId).toBe("turn-7");
    expect(event.data).toEqual({ text: "hello" });
  });

  it("stamps a numeric time that never goes backwards", () => {
    const session = createSession("s");
    session.append({ type: "turn/start", turnId: "t1", data: {} });
    session.append({ type: "message/user", turnId: "t1", data: { text: "hi" } });

    const times = session.events().map((event) => event.time);

    expect(times.every((time) => typeof time === "number")).toBe(true);
    expect(times[1]).toBeGreaterThanOrEqual(times[0]);
  });

  it("shares one turnId across every event of a turn", () => {
    const session = createSession("s");
    session.append({ type: "turn/start", turnId: "t1", data: {} });
    session.append({ type: "message/user", turnId: "t1", data: { text: "hi" } });
    session.append({ type: "turn/end", turnId: "t1", data: { reason: "completed" } });

    expect(session.events().map((event) => event.turnId)).toEqual(["t1", "t1", "t1"]);
  });
});

describe("Session immutability", () => {
  it("freezes the recorded event and its data", () => {
    const session = createSession("s");

    const event = session.append({ type: "message/user", turnId: "t1", data: { text: "hi" } });

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.data)).toBe(true);
  });

  // Covers the fields the shallow copy actually detaches. Nested unknown
  // payloads (a tool call's `input`) stay by reference and are not isolated here.
  it("detaches the recorded payload's flat fields from the caller's object", () => {
    const session = createSession("s");
    const data = { text: "original" };
    session.append({ type: "message/user", turnId: "t1", data });

    data.text = "tampered";

    expect(session.deriveMessages()).toEqual([{ role: "user", text: "original" }]);
  });

  it("hands out a fresh frozen snapshot rather than the internal log", () => {
    const session = createSession("s");
    session.append({ type: "turn/start", turnId: "t1", data: {} });

    const first = session.events();
    const second = session.events();

    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it("keeps history intact when a returned snapshot is mutated", () => {
    const session = createSession("s");
    session.append({ type: "turn/start", turnId: "t1", data: {} });

    const snapshot = session.events() as SessionEvent[];

    expect(() => snapshot.push(snapshot[0])).toThrow();
    expect(session.events()).toHaveLength(1);
  });

  it("detaches the tool calls of a recorded assistant step from the caller's array", () => {
    const session = createSession("s");
    const toolCalls = [{ callId: "c1", name: "echo", input: { text: "hi" } }];
    session.append({ type: "message/assistant", turnId: "t1", data: { text: "", toolCalls } });

    // The caller keeps its own array and may do what it likes with it: what the log
    // recorded is a copy, not that array.
    toolCalls.push({ callId: "c2", name: "echo", input: { text: "second" } });

    expect(recordedCalls(session)).toHaveLength(1);
    // The call record is copied too; its `input` stays by reference, which is the
    // isolation boundary the rest of the Core uses.
    expect(recordedCalls(session)[0]?.input).toBe(toolCalls[0]?.input);
  });
});

/** The tool calls the log recorded for its first assistant step. */
function recordedCalls(session: Session): readonly { readonly input: unknown }[] {
  const [event] = session.events();
  return event?.type === "message/assistant" ? event.data.toolCalls : [];
}

describe("SessionEvent narrowing", () => {
  it("exposes each payload through its own event type", () => {
    const session = createSession("s");
    session.append({ type: "message/user", turnId: "t1", data: { text: "hi" } });
    session.append({
      type: "tool/result",
      turnId: "t1",
      data: { callId: "c1", name: "echo", ok: false, content: "boom" },
    });

    expect(session.events().map(describeEvent)).toEqual(["user:hi", "tool:echo:false"]);
  });
});

/**
 * Reading type-specific fields here is a compile-time assertion: a wrong field
 * for a given event type fails `tsc`, and the switch has no default so a new
 * event type cannot be added without being handled.
 */
function describeEvent(event: SessionEvent): string {
  switch (event.type) {
    case "turn/start":
      return `turn-start:${event.turnId}`;
    case "message/user":
      return `user:${event.data.text}`;
    case "tool/call":
      return `call:${event.data.name}`;
    case "tool/result":
      return `tool:${event.data.name}:${String(event.data.ok)}`;
    case "message/assistant":
      return `assistant:${event.data.text}:${String(event.data.toolCalls.length)}`;
    case "turn/end":
      return `turn-end:${event.data.reason}`;
  }
}
