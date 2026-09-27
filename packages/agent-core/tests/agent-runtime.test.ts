import { describe, expect, it } from "vitest";

import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import { createAgentLoop } from "../src/loop/agent-loop.js";
import type { ModelClient, ModelEvent } from "../src/model/model-client.js";
import { createAgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { createSession } from "../src/session/session.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { createFakeModelClient } from "./helpers/fake-model-client.js";

/** A reply that answers without asking for any tool. */
function answerReply(text: string): ModelEvent[] {
  return [{ type: "text-delta", text }, { type: "done" }];
}

function runtimeFor(modelClient: ModelClient): AgentRuntime {
  return createAgentRuntime({
    loop: createAgentLoop({
      modelClient,
      tools: createToolRegistry(),
      contextBuilder: createDefaultContextBuilder(),
    }),
  });
}

describe("AgentRuntime.run", () => {
  it("frames one turn around a plain answer", async () => {
    const session = createSession("s-1");
    const client = createFakeModelClient([answerReply("plain answer")]);

    const result = await runtimeFor(client).run({ session, text: "hi" });

    const events = session.events();
    expect(events.map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "message/assistant",
      "turn/end",
    ]);
    // One turn, one id: every event carries the id the runtime handed back.
    expect(new Set(events.map((event) => event.turnId))).toEqual(new Set([result.turnId]));
    expect(events.find((event) => event.type === "turn/end")?.data).toEqual({ reason: "completed" });
    expect(events.find((event) => event.type === "message/assistant")?.data).toEqual({
      text: "plain answer",
      toolCalls: [],
    });
    expect(result.text).toBe("plain answer");
    // A plain answer costs exactly one model call.
    expect(client.requests).toHaveLength(1);
  });

  it("gives each run its own turnId and appends the second turn after the first", async () => {
    const session = createSession("s-1");
    const client = createFakeModelClient([answerReply("first answer"), answerReply("second answer")]);
    const runtime = runtimeFor(client);

    const first = await runtime.run({ session, text: "first question" });
    const second = await runtime.run({ session, text: "second question" });

    expect(first.text).toBe("first answer");
    expect(second.text).toBe("second answer");
    expect(first.turnId).not.toBe(second.turnId);

    const events = session.events();
    expect(events).toHaveLength(8);
    expect(events.map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "message/assistant",
      "turn/end",
      "turn/start",
      "message/user",
      "message/assistant",
      "turn/end",
    ]);
    // Each turn keeps its own id on every event it wrote.
    expect(new Set(events.slice(0, 4).map((event) => event.turnId))).toEqual(new Set([first.turnId]));
    expect(new Set(events.slice(4).map((event) => event.turnId))).toEqual(new Set([second.turnId]));
    // The second turn is appended after the first, so the projection stays flat.
    expect(session.deriveMessages()).toEqual([
      { role: "user", text: "first question" },
      { role: "assistant", text: "first answer", toolCalls: [] },
      { role: "user", text: "second question" },
      { role: "assistant", text: "second answer", toolCalls: [] },
    ]);
  });
});
