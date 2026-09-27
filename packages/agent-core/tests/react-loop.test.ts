import { describe, expect, it } from "vitest";

import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import { createAgentLoop } from "../src/loop/agent-loop.js";
import type { ModelEvent } from "../src/model/model-client.js";
import { createAgentRuntime } from "../src/runtime/agent-runtime.js";
import { createSession } from "../src/session/session.js";
import type { SessionEvent } from "../src/session/session-event.js";
import type { Session } from "../src/session/session.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { createEchoTool } from "./helpers/fake-echo-tool.js";
import { createFakeModelClient } from "./helpers/fake-model-client.js";

const SYSTEM_PROMPT = "You are a test agent.";

/**
 * The DoD script: the first call asks for the echo tool, the second one answers.
 * The answer arrives as two deltas, so a step that overwrote instead of
 * concatenating them would not produce "Echo: hello".
 */
function echoScript(): ModelEvent[][] {
  return [
    [
      { type: "tool-call", call: { callId: "call-1", name: "echo", input: { text: "hello" } } },
      { type: "done" },
    ],
    [
      { type: "text-delta", text: "Echo: " },
      { type: "text-delta", text: "hello" },
      { type: "done" },
    ],
  ];
}

function assistantSteps(session: Session): Extract<SessionEvent, { type: "message/assistant" }>["data"][] {
  return session.events().flatMap((event) => (event.type === "message/assistant" ? [event.data] : []));
}

describe("minimal ReAct turn", () => {
  it("runs user → model → tool → tool result → model → final answer", async () => {
    const session = createSession("s-1");
    const tools = createToolRegistry();
    tools.register(createEchoTool());
    const client = createFakeModelClient(echoScript());
    const runtime = createAgentRuntime({
      loop: createAgentLoop({
        modelClient: client,
        tools,
        contextBuilder: createDefaultContextBuilder(SYSTEM_PROMPT),
      }),
    });

    const result = await runtime.run({ session, text: "hello", userId: "user-1" });

    expect(result.text).toBe("Echo: hello");

    const events = session.events();
    expect(events.map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "message/assistant",
      "tool/call",
      "tool/result",
      "message/assistant",
      "turn/end",
    ]);
    // One turn, one id: every event carries the id the runtime handed back.
    expect(new Set(events.map((event) => event.turnId))).toEqual(new Set([result.turnId]));
    // The tool step records the call and no text; the last step carries the answer.
    expect(assistantSteps(session)).toEqual([
      { text: "", toolCalls: [{ callId: "call-1", name: "echo", input: { text: "hello" } }] },
      { text: "Echo: hello", toolCalls: [] },
    ]);

    expect(client.requests).toHaveLength(2);
    expect(client.requests[0].systemPrompt).toBe(SYSTEM_PROMPT);
    expect(client.requests[0].tools.map((schema) => schema.name)).toEqual(["echo"]);
    expect(client.requests[0].messages).toEqual([{ role: "user", text: "hello" }]);
    // The second step is asked again from scratch, this time with the tool result
    // already projected back in from the log.
    expect(client.requests[1].messages).toEqual([
      { role: "user", text: "hello" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ callId: "call-1", name: "echo", input: { text: "hello" } }],
      },
      { role: "tool", results: [{ callId: "call-1", name: "echo", ok: true, content: "hello" }] },
    ]);
    // The final answer reaches the log after the last request that produced it.
    expect(session.deriveMessages()).toEqual([
      ...client.requests[1].messages,
      { role: "assistant", text: "Echo: hello", toolCalls: [] },
    ]);
  });

  it("chains two tool steps before answering", async () => {
    const session = createSession("s-1");
    const tools = createToolRegistry();
    const echo = createEchoTool();
    tools.register(echo);
    const client = createFakeModelClient([
      [
        { type: "tool-call", call: { callId: "call-1", name: "echo", input: { text: "one" } } },
        { type: "done" },
      ],
      [
        { type: "tool-call", call: { callId: "call-2", name: "echo", input: { text: "two" } } },
        { type: "done" },
      ],
      [{ type: "text-delta", text: "one two" }, { type: "done" }],
    ]);
    const runtime = createAgentRuntime({
      loop: createAgentLoop({
        modelClient: client,
        tools,
        contextBuilder: createDefaultContextBuilder(SYSTEM_PROMPT),
      }),
    });

    const result = await runtime.run({ session, text: "echo twice", userId: "user-1" });

    expect(result.text).toBe("one two");
    expect(client.requests).toHaveLength(3);
    expect(echo.calls).toHaveLength(2);

    expect(session.events().map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "message/assistant",
      "tool/call",
      "tool/result",
      "message/assistant",
      "tool/call",
      "tool/result",
      "message/assistant",
      "turn/end",
    ]);
    expect(new Set(session.events().map((event) => event.turnId))).toEqual(new Set([result.turnId]));
    expect(echo.calls.map((call) => call.input)).toEqual([{ text: "one" }, { text: "two" }]);

    // The third step is asked with both tool round trips already in history.
    expect(client.requests[2].messages).toEqual([
      { role: "user", text: "echo twice" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ callId: "call-1", name: "echo", input: { text: "one" } }],
      },
      { role: "tool", results: [{ callId: "call-1", name: "echo", ok: true, content: "one" }] },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ callId: "call-2", name: "echo", input: { text: "two" } }],
      },
      { role: "tool", results: [{ callId: "call-2", name: "echo", ok: true, content: "two" }] },
    ]);
  });

  it("executes the tool once, with the runtime context", async () => {
    const session = createSession("s-1");
    const tools = createToolRegistry();
    const echo = createEchoTool();
    tools.register(echo);
    const signal = new AbortController().signal;
    const client = createFakeModelClient(echoScript());
    const runtime = createAgentRuntime({
      loop: createAgentLoop({
        modelClient: client,
        tools,
        contextBuilder: createDefaultContextBuilder(SYSTEM_PROMPT),
      }),
    });

    await runtime.run({ session, text: "hello", userId: "user-1", signal });

    expect(echo.calls).toHaveLength(1);
    const [record] = echo.calls;
    expect(record.input).toEqual({ text: "hello" });
    expect(record.context.sessionId).toBe("s-1");
    expect(record.context.userId).toBe("user-1");
    // One RuntimeContext for the whole turn: the model and the tool share it, and
    // it carries the very signal the caller passed in.
    expect(record.context.signal).toBe(signal);
    expect(client.contexts).toHaveLength(2);
    expect(client.contexts[0]).toBe(record.context);
    expect(client.contexts[1]).toBe(record.context);
  });
});
