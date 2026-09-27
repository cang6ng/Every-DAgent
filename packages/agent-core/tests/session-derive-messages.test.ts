import { describe, expect, it } from "vitest";

import type { ModelMessage, ToolCall } from "../src/model/message.js";
import type { SessionEvent } from "../src/session/session-event.js";
import { createSession } from "../src/session/session.js";
import type { Session } from "../src/session/session.js";

/** turn/start, question, assistant tool call, dispatch, result, final answer, turn/end. */
function appendToolTurn(session: Session, turnId: string, question: string, result: string): void {
  const callId = `${turnId}-call-1`;
  const input = { a: 21, b: 2 };

  session.append({ type: "turn/start", turnId, data: {} });
  session.append({ type: "message/user", turnId, data: { text: question } });
  session.append({
    type: "message/assistant",
    turnId,
    data: { text: "", toolCalls: [{ callId, name: "calculator", input }] },
  });
  session.append({ type: "tool/call", turnId, data: { callId, name: "calculator", input } });
  session.append({
    type: "tool/result",
    turnId,
    data: { callId, name: "calculator", ok: true, content: result },
  });
  session.append({ type: "message/assistant", turnId, data: { text: "Done.", toolCalls: [] } });
  session.append({ type: "turn/end", turnId, data: { reason: "completed" } });
}

describe("Session.deriveMessages", () => {
  it("returns nothing for an empty session", () => {
    expect(createSession("s").deriveMessages()).toEqual([]);
  });

  it("omits turn framing and the tool dispatch record", () => {
    const session = createSession("s");
    session.append({ type: "turn/start", turnId: "t1", data: {} });
    session.append({ type: "tool/call", turnId: "t1", data: { callId: "c1", name: "echo", input: {} } });
    session.append({ type: "turn/end", turnId: "t1", data: { reason: "completed" } });

    expect(session.deriveMessages()).toEqual([]);
  });

  it("projects a user message", () => {
    const session = createSession("s");
    session.append({ type: "message/user", turnId: "t1", data: { text: "21 x 2?" } });

    expect(session.deriveMessages()).toEqual([{ role: "user", text: "21 x 2?" }]);
  });

  it("projects a text-only assistant message with no tool calls", () => {
    const session = createSession("s");
    session.append({ type: "message/assistant", turnId: "t1", data: { text: "Hello.", toolCalls: [] } });

    expect(session.deriveMessages()).toEqual([
      { role: "assistant", text: "Hello.", toolCalls: [] },
    ]);
  });

  it("projects a whole tool round trip in order", () => {
    const session = createSession("s");
    appendToolTurn(session, "t1", "Use the calculator to compute 21 x 2.", "42");

    expect(session.deriveMessages()).toEqual([
      { role: "user", text: "Use the calculator to compute 21 x 2." },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ callId: "t1-call-1", name: "calculator", input: { a: 21, b: 2 } }],
      },
      {
        role: "tool",
        results: [{ callId: "t1-call-1", name: "calculator", ok: true, content: "42" }],
      },
      { role: "assistant", text: "Done.", toolCalls: [] },
    ]);
  });

  it("keeps each tool result's own callId and preserves log order", () => {
    const session = createSession("s");
    session.append({
      type: "message/assistant",
      turnId: "t1",
      data: {
        text: "",
        toolCalls: [
          { callId: "c1", name: "first", input: {} },
          { callId: "c2", name: "second", input: {} },
        ],
      },
    });
    session.append({ type: "tool/result", turnId: "t1", data: { callId: "c2", name: "second", ok: true, content: "ok" } });
    session.append({ type: "tool/result", turnId: "t1", data: { callId: "c1", name: "first", ok: false, content: "boom" } });

    expect(session.deriveMessages()).toEqual([
      {
        role: "assistant",
        text: "",
        toolCalls: [
          { callId: "c1", name: "first", input: {} },
          { callId: "c2", name: "second", input: {} },
        ],
      },
      { role: "tool", results: [{ callId: "c2", name: "second", ok: true, content: "ok" }] },
      { role: "tool", results: [{ callId: "c1", name: "first", ok: false, content: "boom" }] },
    ]);
  });

  it("projects consecutive turns into one flat message list", () => {
    const session = createSession("s");
    appendToolTurn(session, "t1", "first", "42");
    appendToolTurn(session, "t2", "second", "43");

    const messages = session.deriveMessages();

    expect(messages).toHaveLength(8);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages[4]).toEqual({ role: "user", text: "second" });
  });

  it("is a pure projection: repeated calls agree and mutate nothing", () => {
    const session = createSession("s");
    appendToolTurn(session, "t1", "first", "42");

    const first = session.deriveMessages();
    const second = session.deriveMessages();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(session.events()).toHaveLength(7);
  });
});

describe("Session.deriveMessages isolation", () => {
  it("gives derived assistant messages their own toolCalls array", () => {
    const session = createSession("s");
    session.append({ type: "message/assistant", turnId: "t1", data: assistantData() });

    const derived = assistantMessageOf(session.deriveMessages(), 0);

    expect(derived.toolCalls).not.toBe(loggedAssistantEvent(session).data.toolCalls);

    (derived.toolCalls as ToolCall[]).push({ callId: "injected", name: "injected", input: null });

    expect(assistantMessageOf(session.deriveMessages(), 0).toolCalls).toEqual([
      { callId: "c1", name: "calculator", input: { a: 21, b: 2 } },
    ]);
  });

  it("gives derived ToolCall objects their own identity", () => {
    const session = createSession("s");
    session.append({ type: "message/assistant", turnId: "t1", data: assistantData() });

    const derived = assistantMessageOf(session.deriveMessages(), 0);

    expect(derived.toolCalls[0]).not.toBe(loggedAssistantEvent(session).data.toolCalls[0]);

    (derived.toolCalls[0] as { name: string }).name = "tampered";

    expect(assistantMessageOf(session.deriveMessages(), 0).toolCalls).toEqual([
      { callId: "c1", name: "calculator", input: { a: 21, b: 2 } },
    ]);
  });
});

/** A fresh payload per call, so no test can leak state into another. */
function assistantData(): { text: string; toolCalls: ToolCall[] } {
  return { text: "", toolCalls: [{ callId: "c1", name: "calculator", input: { a: 21, b: 2 } }] };
}

function loggedAssistantEvent(session: Session): Extract<SessionEvent, { type: "message/assistant" }> {
  const event = session.events()[0];
  if (event === undefined || event.type !== "message/assistant") {
    throw new Error("expected a message/assistant event at index 0");
  }
  return event;
}

function assistantMessageOf(
  messages: readonly ModelMessage[],
  index: number,
): Extract<ModelMessage, { role: "assistant" }> {
  const message = messages[index];
  if (message === undefined || message.role !== "assistant") {
    throw new Error(`expected an assistant message at index ${index}`);
  }
  return message;
}
