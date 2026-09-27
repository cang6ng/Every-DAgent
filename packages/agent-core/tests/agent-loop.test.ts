import { describe, expect, it } from "vitest";

import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import { createAgentLoop } from "../src/loop/agent-loop.js";
import type { AgentLoop } from "../src/loop/agent-loop.js";
import type { ModelClient } from "../src/model/model-client.js";
import type { RuntimeContext } from "../src/runtime/runtime-context.js";
import type { SessionEvent } from "../src/session/session-event.js";
import { createSession } from "../src/session/session.js";
import type { Session } from "../src/session/session.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import type { ToolRegistry } from "../src/tools/tool-registry.js";
import type { Tool } from "../src/tools/tool.js";
import { createEchoTool } from "./helpers/fake-echo-tool.js";
import { createFakeModelClient } from "./helpers/fake-model-client.js";

const TURN = "turn-1";
const context: RuntimeContext = { sessionId: "session-1", signal: new AbortController().signal };

/** Writes the two events the AgentRuntime always puts in front of a turn. */
function openTurn(session: Session, text: string): void {
  session.append({ type: "turn/start", turnId: TURN, data: {} });
  session.append({ type: "message/user", turnId: TURN, data: { text } });
}

function loopFor(modelClient: ModelClient, tools: ToolRegistry): AgentLoop {
  return createAgentLoop({ modelClient, tools, contextBuilder: createDefaultContextBuilder() });
}

function assistantSteps(session: Session): Extract<SessionEvent, { type: "message/assistant" }>["data"][] {
  return session.events().flatMap((event) => (event.type === "message/assistant" ? [event.data] : []));
}

function toolResults(session: Session): Extract<SessionEvent, { type: "tool/result" }>["data"][] {
  return session.events().flatMap((event) => (event.type === "tool/result" ? [event.data] : []));
}

function valueTool(name: string, output: unknown): Tool {
  return {
    name,
    description: `Returns a fixed ${name}.`,
    inputSchema: { type: "object" },
    async execute() {
      return output;
    },
  };
}

describe("AgentLoop model steps", () => {
  it("concatenates text deltas and stops without another model call", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const client = createFakeModelClient([
      [
        { type: "text-delta", text: "a" },
        { type: "text-delta", text: "b" },
        { type: "text-delta", text: "c" },
        { type: "done" },
      ],
    ]);

    const outcome = await loopFor(client, createToolRegistry()).runTurn({ session, turnId: TURN, context });

    expect(outcome.text).toBe("abc");
    expect(client.requests).toHaveLength(1);
    expect(session.events().map((event) => event.type)).toEqual(["turn/start", "message/user", "message/assistant"]);
    expect(assistantSteps(session)).toEqual([{ text: "abc", toolCalls: [] }]);
  });

  it("treats a stream that ends without done as a complete step", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const client = createFakeModelClient([[{ type: "text-delta", text: "still complete" }]]);

    const outcome = await loopFor(client, createToolRegistry()).runTurn({ session, turnId: TURN, context });

    expect(outcome.text).toBe("still complete");
    expect(client.requests).toHaveLength(1);
    expect(assistantSteps(session)).toEqual([{ text: "still complete", toolCalls: [] }]);
  });

  it("stops consuming a step at done", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const client = createFakeModelClient([
      [
        { type: "text-delta", text: "before" },
        { type: "done" },
        { type: "text-delta", text: "after" },
      ],
    ]);

    const outcome = await loopFor(client, createToolRegistry()).runTurn({ session, turnId: TURN, context });

    expect(outcome.text).toBe("before");
    expect(assistantSteps(session)).toEqual([{ text: "before", toolCalls: [] }]);
  });
});

describe("AgentLoop tool dispatch", () => {
  it("dispatches tool calls one at a time in model order", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const tools = createToolRegistry();
    const echo = createEchoTool();
    tools.register(echo);
    const client = createFakeModelClient([
      [
        { type: "tool-call", call: { callId: "call-1", name: "echo", input: { text: "one" } } },
        { type: "tool-call", call: { callId: "call-2", name: "echo", input: { text: "two" } } },
        { type: "done" },
      ],
      [{ type: "text-delta", text: "both" }, { type: "done" }],
    ]);

    const outcome = await loopFor(client, tools).runTurn({ session, turnId: TURN, context });

    expect(outcome.text).toBe("both");
    // A call is fully settled before the next one starts; results are never batched.
    expect(session.events().map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "message/assistant",
      "tool/call",
      "tool/result",
      "tool/call",
      "tool/result",
      "message/assistant",
    ]);
    expect(echo.calls.map((call) => call.input)).toEqual([{ text: "one" }, { text: "two" }]);
    expect(toolResults(session)).toEqual([
      { callId: "call-1", name: "echo", ok: true, content: "one" },
      { callId: "call-2", name: "echo", ok: true, content: "two" },
    ]);
    expect(client.requests[1].messages).toEqual([
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "",
        toolCalls: [
          { callId: "call-1", name: "echo", input: { text: "one" } },
          { callId: "call-2", name: "echo", input: { text: "two" } },
        ],
      },
      { role: "tool", results: [{ callId: "call-1", name: "echo", ok: true, content: "one" }] },
      { role: "tool", results: [{ callId: "call-2", name: "echo", ok: true, content: "two" }] },
    ]);
  });

  it("turns a tool failure into an observation instead of an exception", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const tools = createToolRegistry();
    tools.register({
      name: "boom",
      description: "Always fails.",
      inputSchema: { type: "object" },
      async execute() {
        throw new Error("boom");
      },
    });
    const client = createFakeModelClient([
      [{ type: "tool-call", call: { callId: "call-1", name: "boom", input: {} } }, { type: "done" }],
      [{ type: "text-delta", text: "recovered" }, { type: "done" }],
    ]);

    const outcome = await loopFor(client, tools).runTurn({ session, turnId: TURN, context });

    expect(outcome.text).toBe("recovered");
    expect(client.requests).toHaveLength(2);
    expect(toolResults(session)).toEqual([{ callId: "call-1", name: "boom", ok: false, content: "boom" }]);
  });

  it("turns an unknown tool into an observation and continues", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const client = createFakeModelClient([
      [{ type: "tool-call", call: { callId: "call-1", name: "nope", input: { any: "thing" } } }, { type: "done" }],
      [{ type: "text-delta", text: "recovered" }, { type: "done" }],
    ]);

    // An empty registry: the name the model asked for does not exist.
    const outcome = await loopFor(client, createToolRegistry()).runTurn({ session, turnId: TURN, context });

    expect(outcome.text).toBe("recovered");
    expect(client.requests).toHaveLength(2);
    expect(toolResults(session)).toEqual([
      { callId: "call-1", name: "nope", ok: false, content: 'unknown tool "nope"' },
    ]);
    // The next step sees the failure as an observation, exactly like a real result.
    expect(client.requests[1].messages).toEqual([
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ callId: "call-1", name: "nope", input: { any: "thing" } }],
      },
      { role: "tool", results: [{ callId: "call-1", name: "nope", ok: false, content: 'unknown tool "nope"' }] },
    ]);
  });
});

describe("AgentLoop tool result rendering", () => {
  it("renders a non-string tool value as text", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const cases: readonly { readonly name: string; readonly output: unknown; readonly content: string }[] = [
      { name: "object", output: { ok: 1 }, content: '{"ok":1}' },
      // JSON has no notation for a bigint: without the replacer a successful result
      // would be rendered as an unserializable failure.
      { name: "bigint", output: { total: 10n }, content: '{"total":"10"}' },
      { name: "bigint-only", output: 10n, content: '"10"' },
      { name: "unserializable", output: circular, content: "<unserializable tool result>" },
    ];

    for (const { name, output, content } of cases) {
      const session = createSession("s-1");
      openTurn(session, "hi");
      const tools = createToolRegistry();
      tools.register(valueTool(name, output));
      const client = createFakeModelClient([
        [{ type: "tool-call", call: { callId: "call-1", name, input: {} } }, { type: "done" }],
        [{ type: "text-delta", text: "final" }, { type: "done" }],
      ]);

      const outcome = await loopFor(client, tools).runTurn({ session, turnId: TURN, context });

      expect(outcome.text).toBe("final");
      expect(toolResults(session)).toEqual([{ callId: "call-1", name, ok: true, content }]);
    }
  });
});
