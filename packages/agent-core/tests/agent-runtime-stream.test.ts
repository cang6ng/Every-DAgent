import { describe, expect, it, vi } from "vitest";

import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import { MAX_STEPS, createAgentLoop } from "../src/loop/agent-loop.js";
import type { ModelClient, ModelEvent } from "../src/model/model-client.js";
import { createAgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { RuntimeEvent } from "../src/runtime/runtime-event.js";
import type { SessionEvent } from "../src/session/session-event.js";
import { createSession } from "../src/session/session.js";
import type { Session } from "../src/session/session.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import type { ToolRegistry } from "../src/tools/tool-registry.js";
import { createEchoTool } from "./helpers/fake-echo-tool.js";
import {
  createFakeModelClient,
  failingReply,
} from "./helpers/fake-model-client.js";

function runtimeFor(modelClient: ModelClient, tools: ToolRegistry = createToolRegistry()): AgentRuntime {
  return createAgentRuntime({
    loop: createAgentLoop({ modelClient, tools, contextBuilder: createDefaultContextBuilder() }),
  });
}

async function collect(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function kinds(events: readonly RuntimeEvent[]): string[] {
  return events.map((event) => event.type);
}

function lastTurnEnd(session: Session): Extract<SessionEvent, { type: "turn/end" }>["data"] | undefined {
  return session.events().findLast((event) => event.type === "turn/end")?.data;
}

function answerReply(text: string): ModelEvent[] {
  return [{ type: "text-delta", text }, { type: "done" }];
}

/** The DoD script: a tool call, then the answer that uses its result. */
function echoScript(): ModelEvent[][] {
  return [
    [{ type: "tool-call", call: { callId: "call-1", name: "echo", input: { text: "hello" } } }, { type: "done" }],
    [{ type: "text-delta", text: "Echo: " }, { type: "text-delta", text: "hello" }, { type: "done" }],
  ];
}

describe("AgentRuntime.stream", () => {
  it("reports a tool turn in the order its parts happened", async () => {
    const session = createSession("s-1");
    const tools = createToolRegistry();
    tools.register(createEchoTool());
    const client = createFakeModelClient(echoScript());

    const events = await collect(runtimeFor(client, tools).stream({ session, text: "hello" }));

    expect(kinds(events)).toEqual([
      "tool/call",
      "tool/result",
      "assistant/chunk",
      "assistant/chunk",
      "turn/end",
    ]);
    // The stream is a view of one turn, and every event says which one.
    const turnIds = new Set(events.map((event) => event.turnId));
    expect(turnIds.size).toBe(1);
    expect(new Set(events.map((event) => event.sessionId))).toEqual(new Set(["s-1"]));
    expect(new Set(session.events().map((event) => event.turnId))).toEqual(turnIds);
    // A step's content is its chunks, in order: no assembled message duplicates them.
    expect(
      events
        .filter((event) => event.type === "assistant/chunk")
        .map((event) => event.text)
        .join(""),
    ).toBe("Echo: hello");
    expect(events.filter((event) => event.type === "tool/result")).toEqual([
      expect.objectContaining({ callId: "call-1", name: "echo", ok: true, content: "hello" }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "turn/end", reason: "completed" });
    expect(events.at(-1)).not.toHaveProperty("error");
    expect(lastTurnEnd(session)).toEqual({ reason: "completed" });
  });

  it("closes a plain answer as completed", async () => {
    const session = createSession("s-1");
    const client = createFakeModelClient([answerReply("plain answer")]);

    const result = await runtimeFor(client).run({ session, text: "hi" });

    expect(result).toMatchObject({ text: "plain answer", reason: "completed" });
    expect(result).not.toHaveProperty("error");
    expect(session.events().map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "message/assistant",
      "turn/end",
    ]);
  });

  it("closes the turn as error instead of throwing when the model fails", async () => {
    const session = createSession("s-1");
    const client = createFakeModelClient([
      failingReply(new Error("provider down")),
      failingReply(new Error("provider down")),
      failingReply(new Error("provider down")),
    ]);

    const result = await runtimeFor(client).run({ session, text: "hi" });

    expect(result.reason).toBe("error");
    expect(result.text).toBe("");
    expect(result.error).toContain("provider down");
    // The turn is closed as a fact, not thrown at the caller.
    expect(session.events().map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "turn/end",
    ]);
    expect(lastTurnEnd(session)).toEqual({ reason: "error", error: result.error });
  });

  it("streams the failure on the turn's own turn/end event", async () => {
    const session = createSession("s-1");
    const client = createFakeModelClient([
      failingReply(new Error("provider down")),
      failingReply(new Error("provider down")),
      failingReply(new Error("provider down")),
    ]);

    const events = await collect(runtimeFor(client).stream({ session, text: "hi" }));

    expect(kinds(events)).toEqual(["turn/end"]);
    expect(events[0]).toMatchObject({ type: "turn/end", reason: "error" });
    expect(events[0]).toHaveProperty("error", expect.stringContaining("provider down"));
  });

  it("closes a pre-aborted turn as cancelled without calling the model", async () => {
    const session = createSession("s-1");
    const abort = new AbortController();
    abort.abort();
    const client = createFakeModelClient([answerReply("never reached")]);

    const result = await runtimeFor(client).run({ session, text: "hi", signal: abort.signal });

    expect(result).toMatchObject({ text: "", reason: "cancelled" });
    expect(client.requests).toEqual([]);
    expect(session.events().map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "turn/end",
    ]);
    expect(lastTurnEnd(session)).toEqual({ reason: "cancelled" });
  });

  it("streams a cancelled turn's chunks before closing it", async () => {
    const session = createSession("s-1");
    const abort = new AbortController();
    const client = createFakeModelClient([
      async function* (): AsyncGenerator<ModelEvent> {
        yield { type: "text-delta", text: "partial" };
        abort.abort();
      },
    ]);

    const events = await collect(runtimeFor(client).stream({ session, text: "hi", signal: abort.signal }));

    expect(kinds(events)).toEqual(["assistant/chunk", "turn/end"]);
    expect(events[0]).toMatchObject({ type: "assistant/chunk", text: "partial" });
    expect(events[1]).toMatchObject({ type: "turn/end", reason: "cancelled" });
    // What the consumer saw mid-cancel is not the same as what the log kept.
    expect(session.events().map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "turn/end",
    ]);
  });

  it("closes a turn that ran out of steps as max_steps", async () => {
    const session = createSession("s-1");
    const tools = createToolRegistry();
    tools.register(createEchoTool());
    const client = createFakeModelClient(
      [
        [
          { type: "tool-call", call: { callId: "call-1", name: "echo", input: { text: "again" } } },
          { type: "done" },
        ],
      ],
      { repeatLast: true },
    );

    const events = await collect(runtimeFor(client, tools).stream({ session, text: "loop" }));

    expect(events.at(-1)).toMatchObject({ type: "turn/end", reason: "max_steps" });
    expect(lastTurnEnd(session)).toEqual({ reason: "max_steps" });
    expect(
      session.events().filter((event) => event.type === "message/assistant"),
    ).toHaveLength(MAX_STEPS);
  });

  it("produces the same log through run() and stream()", async () => {
    const tools = createToolRegistry();
    tools.register(createEchoTool());
    const viaRun = createSession("run-1");
    const viaStream = createSession("stream-1");

    await runtimeFor(createFakeModelClient(echoScript()), tools).run({ session: viaRun, text: "hello" });
    await collect(runtimeFor(createFakeModelClient(echoScript()), tools).stream({ session: viaStream, text: "hello" }));

    expect(viaStream.events().map((event) => event.type)).toEqual(
      viaRun.events().map((event) => event.type),
    );
    expect(viaStream.deriveMessages()).toEqual(viaRun.deriveMessages());
  });

  it("closes the turn even when the injected loop rejects", async () => {
    const session = createSession("s-1");
    // The Runtime owns the turn boundary, so it cannot rely on the loop it was
    // handed to be the layer that never throws.
    const runtime = createAgentRuntime({
      loop: {
        async runTurn() {
          throw new Error("loop exploded");
        },
        preflight() {},
      },
    });

    const result = await runtime.run({ session, text: "hi" });

    expect(result).toMatchObject({ text: "", reason: "error", error: "loop exploded" });
    expect(session.events().map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "turn/end",
    ]);
    expect(lastTurnEnd(session)).toEqual({ reason: "error", error: "loop exploded" });
  });

  it("lets a consumer stop listening without leaving the turn unclosed", async () => {
    const session = createSession("s-1");
    const client = createFakeModelClient([answerReply("first"), answerReply("second")]);
    const runtime = runtimeFor(client);

    const seen: RuntimeEvent[] = [];
    for await (const event of runtime.stream({ session, text: "hi" })) {
      seen.push(event);
      break;
    }

    expect(seen).toEqual([expect.objectContaining({ type: "assistant/chunk", text: "first" })]);
    // The turn was never cancelled, so it runs to the end: the log it opened closes.
    await vi.waitFor(() => {
      expect(lastTurnEnd(session)).toEqual({ reason: "completed" });
    });
    expect(session.deriveMessages()).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "first", toolCalls: [] },
    ]);
  });
});
