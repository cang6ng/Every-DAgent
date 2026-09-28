import { describe, expect, it } from "vitest";

import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import { createAgentLoop } from "../src/loop/agent-loop.js";
import type { ModelClient, ModelEvent } from "../src/model/model-client.js";
import { createAgentRuntime } from "../src/runtime/agent-runtime.js";
import { createSession } from "../src/session/session.js";
import type { Session } from "../src/session/session.js";
import { createMemorySessionStore } from "../src/session/session-store.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { createEchoTool } from "./helpers/fake-echo-tool.js";
import { createFakeModelClient } from "./helpers/fake-model-client.js";
import { unsettledToolCalls } from "../../../tests/helpers/session-lifecycle.js";

function answerReply(text: string): ModelEvent[] {
  return [{ type: "text-delta", text }, { type: "done" }];
}

function runtimeFor(modelClient: ModelClient) {
  return createAgentRuntime({
    loop: createAgentLoop({
      modelClient,
      tools: createToolRegistry(),
      contextBuilder: createDefaultContextBuilder(),
    }),
  });
}

/** Writes every event a session has that the store has not been told about yet. */
async function flush(store: ReturnType<typeof createMemorySessionStore>, session: Session, stored: number): Promise<number> {
  const events = session.events();
  await store.append(session.id, events.slice(stored));
  return events.length;
}

describe("MemorySessionStore", () => {
  it("has nothing to load for a session it never saw", async () => {
    const store = createMemorySessionStore();

    expect(await store.load("s-1")).toBeNull();
  });

  it("round-trips a session's events", async () => {
    const store = createMemorySessionStore();
    await store.create("s-1");
    const session = createSession("s-1");
    session.append({ type: "turn/start", turnId: "t1", data: {} });
    session.append({ type: "message/user", turnId: "t1", data: { text: "hi" } });

    await store.append("s-1", session.events());
    const loaded = await store.load("s-1");

    expect(loaded?.events()).toEqual(session.events());
    expect(loaded?.deriveMessages()).toEqual(session.deriveMessages());
  });

  it("keeps sessions apart", async () => {
    const store = createMemorySessionStore();
    await store.create("s-1");
    await store.create("s-2");

    const first = createSession("s-1");
    first.append({ type: "message/user", turnId: "t1", data: { text: "first" } });
    const second = createSession("s-2");
    second.append({ type: "message/user", turnId: "t2", data: { text: "second" } });

    await store.append("s-1", first.events());
    await store.append("s-2", second.events());

    expect((await store.load("s-1"))?.deriveMessages()).toEqual([{ role: "user", text: "first" }]);
    expect((await store.load("s-2"))?.deriveMessages()).toEqual([{ role: "user", text: "second" }]);
  });

  it("refuses a second declaration of the same session", async () => {
    const store = createMemorySessionStore();
    await store.create("s-1");

    await expect(store.create("s-1")).rejects.toThrow(/already in this store/);
  });

  it("refuses to append to a session it does not have", async () => {
    const store = createMemorySessionStore();

    await expect(store.append("s-1", [])).rejects.toThrow(/unknown session/);
  });

  it("refuses an append that skips events", async () => {
    const store = createMemorySessionStore();
    await store.create("s-1");
    const session = createSession("s-1");
    session.append({ type: "turn/start", turnId: "t1", data: {} });
    await store.append("s-1", session.events());

    const next = session.append({ type: "message/user", turnId: "t1", data: { text: "hi" } });

    // seq 2 while the store holds one event: the caller has lost track of what it
    // already stored, and that is its bug to fix rather than something to paper over.
    await expect(store.append("s-1", [{ ...next, seq: 2 }])).rejects.toThrow(/does not continue it/);
  });

  it("stores nothing when the batch it cannot accept is rejected", async () => {
    const store = createMemorySessionStore();
    await store.create("s-1");
    const session = createSession("s-1");
    const first = session.append({ type: "turn/start", turnId: "t1", data: {} });
    const second = session.append({ type: "message/user", turnId: "t1", data: { text: "hi" } });

    await expect(store.append("s-1", [first, { ...second, seq: 7 }])).rejects.toThrow(
      /does not continue/,
    );

    // Nothing was half-stored, so a caller that lost its place can work it out and retry.
    expect((await store.load("s-1"))?.events()).toEqual([]);
    await store.append("s-1", [first, second]);
    expect((await store.load("s-1"))?.events()).toEqual([first, second]);
  });

  it("hands out a session whose log cannot be written back through it", async () => {
    const store = createMemorySessionStore();
    await store.create("s-1");
    const session = createSession("s-1");
    session.append({ type: "message/user", turnId: "t1", data: { text: "hi" } });
    await store.append("s-1", session.events());

    const first = await store.load("s-1");
    const second = await store.load("s-1");
    // Appending to a loaded session is a local act: nothing is written back until the
    // host says so, which is what keeps storage out of the turn.
    first?.append({ type: "message/assistant", turnId: "t1", data: { text: "local", toolCalls: [] } });

    expect(first?.events()).toHaveLength(2);
    expect(second?.events()).toHaveLength(1);
    expect((await store.load("s-1"))?.events()).toHaveLength(1);
  });
});

describe("session persistence round trip (fake model, no real provider)", () => {
  it("carries a conversation across a reload, turn by turn", async () => {
    const store = createMemorySessionStore();
    const client = createFakeModelClient([answerReply("first answer"), answerReply("second answer")]);
    const runtime = runtimeFor(client);
    await store.create("s-1");

    // First turn on a fresh session, then the host flushes what that turn recorded.
    const live = createSession("s-1");
    await runtime.run({ session: live, text: "first question" });
    let stored = await flush(store, live, 0);

    // Reload from the store: the next turn starts from the recorded history, not from
    // the object that wrote it.
    const reloaded = await store.load("s-1");
    expect(reloaded).not.toBeNull();
    await runtime.run({ session: reloaded!, text: "second question" });
    stored = await flush(store, reloaded!, stored);

    // The model saw the first turn, because the reloaded session projected it.
    expect(client.requests[1]?.messages).toEqual([
      { role: "user", text: "first question" },
      { role: "assistant", text: "first answer", toolCalls: [] },
      { role: "user", text: "second question" },
    ]);
    // And the store now holds the whole conversation, in order and paired.
    const final = await store.load("s-1");
    expect(final?.deriveMessages()).toEqual([
      { role: "user", text: "first question" },
      { role: "assistant", text: "first answer", toolCalls: [] },
      { role: "user", text: "second question" },
      { role: "assistant", text: "second answer", toolCalls: [] },
    ]);
    expect(final?.events().map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(unsettledToolCalls(final!)).toEqual([]);
  });

  it("carries a tool turn across a reload with its call and result still paired", async () => {
    const store = createMemorySessionStore();
    const client = createFakeModelClient([
      [
        { type: "tool-call", call: { callId: "call-1", name: "echo", input: { text: "hello" } } },
        { type: "done" },
      ],
      [{ type: "text-delta", text: "Echo: hello" }, { type: "done" }],
      answerReply("again, answered"),
    ]);
    const tools = createToolRegistry();
    tools.register(createEchoTool());
    const runtime = createAgentRuntime({
      loop: createAgentLoop({
        modelClient: client,
        tools,
        contextBuilder: createDefaultContextBuilder(),
      }),
    });
    await store.create("s-1");

    const live = createSession("s-1");
    await runtime.run({ session: live, text: "echo hello" });
    let stored = await flush(store, live, 0);

    // The reloaded session has to be the same history — a tool call whose result went
    // missing is the one shape a provider refuses on the next request.
    const reloaded = await store.load("s-1");
    expect(reloaded?.deriveMessages()).toEqual(live.deriveMessages());
    expect(unsettledToolCalls(reloaded!)).toEqual([]);

    await runtime.run({ session: reloaded!, text: "again" });
    stored = await flush(store, reloaded!, stored);

    // The next turn was asked with the tool round trip projected back in, in order.
    expect(client.requests[2]?.messages).toEqual([
      { role: "user", text: "echo hello" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ callId: "call-1", name: "echo", input: { text: "hello" } }],
      },
      { role: "tool", results: [{ callId: "call-1", name: "echo", ok: true, content: "hello" }] },
      { role: "assistant", text: "Echo: hello", toolCalls: [] },
      { role: "user", text: "again" },
    ]);

    const final = await store.load("s-1");
    const seqs = final?.events().map((event) => event.seq) ?? [];
    // Contiguous from zero to the end: one log, both turns.
    expect(seqs).toEqual(seqs.map((_unused, index) => index));
    expect(unsettledToolCalls(final!)).toEqual([]);
    expect(stored).toBe(seqs.length);
  });
});
