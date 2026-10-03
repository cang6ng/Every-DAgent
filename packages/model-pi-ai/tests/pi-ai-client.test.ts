import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessageEvent, JsonObject } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL_FRAMING, defineModelBudget } from "@every-dagent/agent-core";
import type { ModelClient, ModelEvent, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";

import { UnsupportedPiAiProfileError, createPiAiModelClient } from "../src/pi-ai-client.js";
import {
  abortedScript,
  createRewriteSource,
  createScriptedPiAiStream,
  errorScript,
  TEST_MODEL as MODEL,
  textScript,
  toolCallScript,
  truncatedScript,
} from "./helpers/fake-pi-ai-stream.js";

const context: RuntimeContext = { sessionId: "s-1", signal: new AbortController().signal };

function clientFor(scripts: readonly (readonly AssistantMessageEvent[])[]): {
  readonly client: ModelClient;
  readonly source: ReturnType<typeof createScriptedPiAiStream>;
} {
  const source = createScriptedPiAiStream(scripts);
  return { client: createPiAiModelClient({ models: source, model: MODEL }), source };
}

async function collect(client: ModelClient, request: ModelRequest): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of client.stream(request, context)) events.push(event);
  return events;
}

/** The capability this adapter declares for the test model. */
const CLIENT_LIMITS = {
  contextWindow: MODEL.contextWindow,
  maxOutputTokens: MODEL.maxTokens,
  framing: DEFAULT_MODEL_FRAMING,
};

/** A request whose reserve is this profile's own: `R = min(4096, 1024)`. */
function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    messages: [{ role: "user", text: "hi" }],
    tools: [],
    maxOutputTokens: defineModelBudget(CLIENT_LIMITS).reservedOutput,
    ...overrides,
  };
}

describe("PiAiModelClient model events", () => {
  it("reports an answer as its text deltas and one done", async () => {
    const { client } = clientFor([textScript("the answer")]);

    const events = await collect(client, request());

    expect(events).toEqual([
      { type: "text-delta", text: "the answer" },
      { type: "done" },
    ]);
  });

  it("hands over a tool call once it is assembled, not as deltas", async () => {
    const { client } = clientFor([toolCallScript("call-1", "calculator", { a: 21, b: 2 })]);

    const events = await collect(client, request());

    expect(events).toEqual([
      { type: "tool-call", call: { callId: "call-1", name: "calculator", input: { a: 21, b: 2 } } },
      { type: "done" },
    ]);
  });

  it("does not report the same call twice when the terminal message repeats it", async () => {
    const { client } = clientFor([toolCallScript("call-1", "calculator", { a: 21, b: 2 })]);

    const events = await collect(client, request());

    expect(events.filter((event) => event.type === "tool-call")).toHaveLength(1);
  });

  it("reports a call that only shows up in the terminal message", async () => {
    const block = fauxToolCall("calculator", { a: 21, b: 2 }, { id: "call-1" });
    const message = fauxAssistantMessage([block], { stopReason: "toolUse" });
    // No toolcall_end at all: a source that names its calls only at the end must not
    // have them dropped — the Core would read "text and no calls" as a finished answer.
    const { client } = clientFor([
      [{ type: "start", partial: message }, { type: "done", reason: "toolUse", message }],
    ]);

    const events = await collect(client, request());

    expect(events).toEqual([
      { type: "tool-call", call: { callId: "call-1", name: "calculator", input: { a: 21, b: 2 } } },
      { type: "done" },
    ]);
  });

  it("keeps arguments that are not an object exactly as the model produced them", async () => {
    // Valid JSON, wrong shape: spreading an array into `{0: ..., 1: ...}` would invent
    // arguments the model never gave, and the tool is the layer that gets to reject them.
    const block = {
      type: "toolCall" as const,
      id: "call-1",
      name: "calculator",
      arguments: [21, 2] as unknown as JsonObject,
    };
    const partial = fauxAssistantMessage([block], { stopReason: "toolUse" });
    const { client } = clientFor([
      [
        { type: "start", partial },
        { type: "toolcall_end", contentIndex: 0, toolCall: block, partial },
        { type: "done", reason: "toolUse", message: partial },
      ],
    ]);

    const events = await collect(client, request());

    expect(events[0]).toEqual({
      type: "tool-call",
      call: { callId: "call-1", name: "calculator", input: [21, 2] },
    });
  });

  it("detaches the tool call from the provider's accumulator", async () => {
    const call = fauxToolCall("calculator", { a: 21, b: 2 }, { id: "call-1" });
    const partial = fauxAssistantMessage([call], { stopReason: "toolUse" });
    const { client } = clientFor([
      [
        { type: "start", partial },
        { type: "toolcall_end", contentIndex: 0, toolCall: call, partial },
        { type: "done", reason: "toolUse", message: partial },
      ],
    ]);

    const events = await collect(client, request());
    // pi-ai's `partial` is a live accumulator: whatever it does next must not reach
    // what the Core already recorded.
    (call.arguments as Record<string, unknown>).a = 999;

    expect(events[0]).toEqual({
      type: "tool-call",
      call: { callId: "call-1", name: "calculator", input: { a: 21, b: 2 } },
    });
  });

  it("ignores thinking deltas", async () => {
    const thinking = fauxAssistantMessage([fauxThinking("let me think")]);
    const answer = fauxAssistantMessage("the answer");
    const { client } = clientFor([
      [
        { type: "start", partial: thinking },
        { type: "thinking_start", contentIndex: 0, partial: thinking },
        { type: "thinking_delta", contentIndex: 0, delta: "let me think", partial: thinking },
        { type: "thinking_end", contentIndex: 0, content: "let me think", partial: thinking },
        { type: "text_delta", contentIndex: 1, delta: "the answer", partial: answer },
        { type: "done", reason: "stop", message: answer },
      ],
    ]);

    const events = await collect(client, request());

    expect(events).toEqual([
      { type: "text-delta", text: "the answer" },
      { type: "done" },
    ]);
  });
});

describe("PiAiModelClient failures", () => {
  it("throws when the answer was truncated", async () => {
    const { client } = clientFor([truncatedScript("half an ans")]);

    await expect(collect(client, request())).rejects.toThrow(/truncated/);
  });

  it("reports a provider error terminal without quoting the provider", async () => {
    const { client } = clientFor([errorScript("upstream is on fire")]);

    // What the provider said is not what a caller sees: the failure is this
    // adapter's own fixed classification, and the provider's bytes stay out of it.
    await expect(collect(client, request())).rejects.toThrow("the provider request failed");
  });

  it("keeps a credential that a provider echoed out of the failure", async () => {
    const { client } = clientFor([errorScript("bad key sk-secret-token rejected")]);

    const failure = await collect(client, request()).catch((error: unknown) => error);

    expect(String(failure)).not.toContain("sk-secret-token");
  });

  it("throws when the request was aborted", async () => {
    const { client } = clientFor([abortedScript()]);

    await expect(collect(client, request())).rejects.toThrow(/aborted/);
  });

  it("throws when the stream ends without a terminal event", async () => {
    // A silent end is the one failure the Core cannot tell from a completed step.
    const { client } = clientFor([[{ type: "text_delta", contentIndex: 0, delta: "half", partial: fauxAssistantMessage("half") }]]);

    await expect(collect(client, request())).rejects.toThrow(/without a done or error event/);
  });

  it("throws on the stop reasons the Core has no meaning for", async () => {
    // The terminal event's own `reason` is a narrower union than a message's stop
    // reason, and the message is the authoritative one — so it is what gets judged.
    for (const stopReason of ["pending", "deferred"] as const) {
      const message = fauxAssistantMessage("text", { stopReason });
      const { client } = clientFor([
        [
          { type: "start", partial: message },
          { type: "text_delta", contentIndex: 0, delta: "text", partial: message },
          { type: "done", reason: "stop", message },
        ],
      ]);

      await expect(collect(client, request())).rejects.toThrow(new RegExp(stopReason));
    }
  });
});

describe("PiAiModelClient requests", () => {
  it("sends the session projection as pi-ai messages and tools", async () => {
    const { client, source } = clientFor([textScript("ok")]);
    const tools = [
      {
        name: "calculator",
        description: "Adds two numbers.",
        inputSchema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
      },
    ];

    await collect(
      client,
      request({
        systemPrompt: "You are terse.",
        tools,
        messages: [
          { role: "user", text: "what is 21 x 2" },
          {
            role: "assistant",
            text: "",
            toolCalls: [{ callId: "call-1", name: "calculator", input: { a: 21, b: 2 } }],
          },
          { role: "tool", results: [{ callId: "call-1", name: "calculator", ok: true, content: "42" }] },
          { role: "tool", results: [{ callId: "call-2", name: "boom", ok: false, content: "it broke" }] },
        ],
      }),
    );

    const [sent] = source.contexts;
    expect(sent?.systemPrompt).toBe("You are terse.");
    expect(sent?.tools).toEqual([
      {
        name: "calculator",
        description: "Adds two numbers.",
        parameters: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
      },
    ]);
    expect(sent?.messages).toHaveLength(4);
    expect(sent?.messages[0]).toEqual({ role: "user", content: "what is 21 x 2", timestamp: expect.any(Number) });
    expect(sent?.messages[1]).toMatchObject({
      role: "assistant",
      // A step that only asked for a tool has no text block to send.
      content: [{ type: "toolCall", id: "call-1", name: "calculator", arguments: { a: 21, b: 2 } }],
      api: "openai-completions",
      provider: "test",
      model: "test-model",
      stopReason: "toolUse",
      usage: { input: 0, output: 0, totalTokens: 0 },
    });
    expect(sent?.messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "calculator",
      content: [{ type: "text", text: "42" }],
      isError: false,
    });
    // A failed tool stays a result, marked as one, so the model can react to it.
    expect(sent?.messages[3]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-2",
      isError: true,
      content: [{ type: "text", text: "it broke" }],
    });
  });

  it("keeps the assistant text of a step that answered", async () => {
    const { client, source } = clientFor([textScript("ok")]);

    await collect(
      client,
      request({
        messages: [{ role: "assistant", text: "I looked it up", toolCalls: [] }],
      }),
    );

    expect(source.contexts[0]?.messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "I looked it up" }],
      stopReason: "stop",
    });
  });

  it("passes the turn's signal, the credential and an explicit no-retry to pi-ai", async () => {
    const source = createScriptedPiAiStream([textScript("ok")]);
    const client = createPiAiModelClient({
      models: source,
      model: MODEL,
      apiKey: "test-key",
      timeoutMs: 30_000,
    });

    const sent = request();

    await collect(client, sent);

    // pi-ai's own default is already zero retries; the adapter states it so the
    // property cannot change under the Core without this test noticing.
    expect(source.options[0]).toMatchObject({
      signal: context.signal,
      maxRetries: 0,
      apiKey: "test-key",
      // The request's own reserve — never a profile ceiling.
      maxTokens: sent.maxOutputTokens,
      timeoutMs: 30_000,
    });
  });

  it("sends the request's own cap, not the profile's ceiling", async () => {
    const source = createScriptedPiAiStream([textScript("ok")]);
    const client = createPiAiModelClient({ models: source, model: MODEL, maxTokens: 512 });

    await collect(client, request({ maxOutputTokens: 128 }));

    expect(source.options[0]?.maxTokens).toBe(128);
  });

  it("refuses a request whose reserve is larger than the profile allows", async () => {
    const source = createScriptedPiAiStream([textScript("ok")]);
    const client = createPiAiModelClient({ models: source, model: MODEL });

    await expect(collect(client, request({ maxOutputTokens: MODEL.maxTokens + 1 }))).rejects.toThrow(
      /larger than this profile allows/,
    );
    expect(source.contexts).toHaveLength(0);
  });

  it("declares the model's own finite capability", () => {
    const { client } = clientFor([textScript("ok")]);

    expect(client.limits).toEqual(CLIENT_LIMITS);
  });

  it("refuses a configured ceiling above the model's own maximum", () => {
    expect(() =>
      createPiAiModelClient({
        models: createScriptedPiAiStream([]),
        model: MODEL,
        maxTokens: MODEL.maxTokens + 1,
      }),
    ).toThrow(/ceiling/);
  });

  it("refuses a model that declares no usable capability", () => {
    const broken = { ...MODEL, contextWindow: Number.POSITIVE_INFINITY };

    expect(() =>
      createPiAiModelClient({ models: createScriptedPiAiStream([]), model: broken }),
    ).toThrow(/context window/);
  });

  it("refuses a model API whose output cap it cannot enforce", async () => {
    const source = createScriptedPiAiStream([textScript("ok")]);
    const unaudited = { ...MODEL, api: "openai-responses" as typeof MODEL.api };
    const client = createPiAiModelClient({ models: source, model: unaudited });

    await expect(collect(client, request())).rejects.toThrow(UnsupportedPiAiProfileError);
    // No provider call, and above all no provider payload.
    expect(source.contexts).toHaveLength(0);
  });

  it("refuses a payload whose cap is not the one the request reserved", async () => {
    // The provider client is handed the request's cap; a source that rewrites it
    // before sending is exactly what the payload guard exists to catch, and no
    // request may reach the network on a body the Core did not reserve.
    const source = createRewriteSource((payload) => ({ ...payload, max_tokens: 7 }));

    await expect(collect(createPiAiModelClient({ models: source, model: MODEL }), request())).rejects.toThrow(
      /output cap/,
    );
    expect(source.sent).toBe(0);
  });

  it("refuses a payload that carries two caps", async () => {
    const cap = request().maxOutputTokens;
    const source = createRewriteSource((payload) => ({
      ...payload,
      max_tokens: cap,
      max_completion_tokens: cap,
    }));

    await expect(collect(createPiAiModelClient({ models: source, model: MODEL }), request())).rejects.toThrow(
      /exactly one enforceable output cap/,
    );
    expect(source.sent).toBe(0);
  });

  it("refuses a payload that dropped the cap", async () => {
    const source = createRewriteSource((payload) => {
      const { max_tokens: _cap, max_completion_tokens: _other, ...rest } = payload;
      void _cap;
      void _other;
      return rest;
    });

    await expect(collect(createPiAiModelClient({ models: source, model: MODEL }), request())).rejects.toThrow(
      /exactly one enforceable output cap/,
    );
    expect(source.sent).toBe(0);
  });

  it("lets an audited payload through untouched", async () => {
    const source = createRewriteSource((payload) => payload);

    await expect(collect(createPiAiModelClient({ models: source, model: MODEL }), request())).resolves.toEqual([
      { type: "text-delta", text: "ok" },
      { type: "done" },
    ]);
    expect(source.sent).toBe(1);
  });

  it("refuses to replay a recorded call whose input is not an object", async () => {
    const { client } = clientFor([textScript("ok")]);

    const replay = collect(
      client,
      request({
        messages: [
          {
            role: "assistant",
            text: "",
            toolCalls: [{ callId: "call-1", name: "calculator", input: "twenty-one" }],
          },
        ],
      }),
    );

    // Better a local message than the provider's rejection of a malformed request.
    await expect(replay).rejects.toThrow(/not a JSON object/);
  });

  it("leaves the credential to pi-ai when none is given", async () => {
    const { client, source } = clientFor([textScript("ok")]);

    await collect(client, request());

    expect(source.options[0]?.apiKey).toBeUndefined();
  });
});
