import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  normalizeContext,
} from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  JsonObject,
  Model,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { stream as openAiCompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as anthropicMessagesStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { describe, expect, it } from "vitest";

import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import { createAgentLoop } from "../src/loop/agent-loop.js";
import { createPiAiModelClient } from "../src/model/pi-ai-client.js";
import type { PiAiStreamSource } from "../src/model/pi-ai-client.js";
import { createAgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { RuntimeEvent } from "../src/runtime/runtime-event.js";
import { createSession } from "../src/session/session.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import type { ToolRegistry } from "../src/tools/tool-registry.js";
import type { Tool } from "../src/tools/tool.js";
import { TEST_MODEL } from "./helpers/fake-pi-ai-stream.js";

const SYSTEM_PROMPT = "You are a calculator.";

/**
 * The DoD tool in test shape: it records the arguments it was given, so a test can
 * see what actually travelled through pi-ai's incremental argument assembler.
 */
function createCalculator(): { readonly tool: Tool; readonly inputs: unknown[] } {
  const inputs: unknown[] = [];

  return {
    inputs,
    tool: {
      name: "calculator",
      description: "Multiplies two integers: a * b.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      async execute(input: unknown) {
        inputs.push(input);
        const { a, b } = (input ?? {}) as { a?: unknown; b?: unknown };
        if (typeof a !== "number" || typeof b !== "number") {
          throw new Error("calculator expects { a: number, b: number }");
        }
        return a * b;
      },
    },
  };
}

function runtimeFor(client: ReturnType<typeof createPiAiModelClient>, tools: ToolRegistry): AgentRuntime {
  return createAgentRuntime({
    loop: createAgentLoop({
      modelClient: client,
      tools,
      contextBuilder: createDefaultContextBuilder(SYSTEM_PROMPT),
    }),
  });
}

/** The real pi-ai registry with a scripted provider, wired to the real Core. */
function runtimeWithFaux(responses: AssistantMessage[]): {
  readonly runtime: AgentRuntime;
  readonly tools: ToolRegistry;
  readonly calculator: { readonly inputs: unknown[] };
  readonly faux: ReturnType<typeof fauxProvider>;
} {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);

  const calculator = createCalculator();
  const tools = createToolRegistry();
  tools.register(calculator.tool);

  return {
    runtime: runtimeFor(createPiAiModelClient({ models, model: faux.getModel() }), tools),
    tools,
    calculator,
    faux,
  };
}

describe("pi-ai adapter inside the real Core", () => {
  it("answers a plain turn through pi-ai", async () => {
    const { runtime, faux } = runtimeWithFaux([fauxAssistantMessage("The answer is 42.")]);
    const session = createSession("s-1");

    const result = await runtime.run({ session, text: "say something" });

    expect(result).toMatchObject({ text: "The answer is 42.", reason: "completed" });
    expect(faux.state.callCount).toBe(1);
    expect(session.events().map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "message/assistant",
      "turn/end",
    ]);
  });

  it("runs a tool round trip on arguments pi-ai assembled from deltas", async () => {
    const { runtime, calculator, faux } = runtimeWithFaux([
      fauxAssistantMessage([fauxToolCall("calculator", { a: 21, b: 2 })], { stopReason: "toolUse" }),
      fauxAssistantMessage("21 * 2 = 42."),
    ]);
    const session = createSession("s-1");

    const result = await runtime.run({ session, text: "what is 21 * 2" });

    expect(result).toMatchObject({ text: "21 * 2 = 42.", reason: "completed" });
    // The tool ran with the parsed arguments, not with a half-assembled JSON string.
    expect(calculator.inputs).toEqual([{ a: 21, b: 2 }]);
    expect(faux.state.callCount).toBe(2);
    expect(session.events().map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "message/assistant",
      "tool/call",
      "tool/result",
      "message/assistant",
      "turn/end",
    ]);
  });

  it("sends the tool round trip back to the provider as pi-ai messages", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);

    let secondRequest: TranscriptContext | undefined;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("calculator", { a: 21, b: 2 })], { stopReason: "toolUse" }),
      (context) => {
        secondRequest = context;
        return fauxAssistantMessage("21 * 2 = 42.");
      },
    ]);

    const calculator = createCalculator();
    const tools = createToolRegistry();
    tools.register(calculator.tool);
    const session = createSession("s-1");

    await runtimeFor(createPiAiModelClient({ models, model: faux.getModel() }), tools).run({
      session,
      text: "what is 21 * 2",
    });

    // The session projection reached the provider as the call and its result, which
    // is what a second model call needs to see.
    expect(secondRequest?.messages).toEqual([
      expect.objectContaining({ role: "system", content: SYSTEM_PROMPT }),
      expect.objectContaining({ role: "user", content: "what is 21 * 2" }),
      expect.objectContaining({
        role: "assistant",
        content: [expect.objectContaining({ type: "toolCall", name: "calculator", arguments: { a: 21, b: 2 } })],
      }),
      expect.objectContaining({
        role: "toolResult",
        toolName: "calculator",
        content: [{ type: "text", text: "42" }],
        isError: false,
      }),
    ]);
  });

  it("retries an answer pi-ai reported as empty", async () => {
    const { runtime, faux } = runtimeWithFaux([
      fauxAssistantMessage(""),
      fauxAssistantMessage("second try"),
    ]);
    const session = createSession("s-1");

    const result = await runtime.run({ session, text: "say something" });

    expect(result).toMatchObject({ text: "second try", reason: "completed" });
    expect(faux.state.callCount).toBe(2);
  });

  it("keeps a tool failure an observation when the provider asked for a bad call", async () => {
    const { runtime, calculator } = runtimeWithFaux([
      // Wrong arguments on purpose: the tool refuses them, the model gets told.
      fauxAssistantMessage([fauxToolCall("calculator", { a: "twenty-one", b: 2 })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("I could not multiply that."),
    ]);
    const session = createSession("s-1");

    const result = await runtime.run({ session, text: "what is twenty-one times two" });

    expect(result.reason).toBe("completed");
    expect(calculator.inputs).toEqual([{ a: "twenty-one", b: 2 }]);
    const results = session
      .events()
      .flatMap((event) => (event.type === "tool/result" ? [event.data] : []));
    expect(results).toEqual([
      {
        callId: expect.any(String),
        name: "calculator",
        ok: false,
        content: "calculator expects { a: number, b: number }",
      },
    ]);
  });
});

type PiAiFetch = NonNullable<StreamOptions["fetch"]>;

/** One OpenAI-compatible stream chunk carrying whatever delta is given. */
function openAiChunk(delta: JsonObject, finishReason: string | null = null): string {
  const chunk = {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function sseBody(chunks: readonly string[]): string {
  return `${chunks.join("")}data: [DONE]\n\n`;
}

/** One Anthropic stream event, in the shape its own SDK parses. */
function anthropicEvent(type: string, payload: JsonObject): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** The Anthropic events for a tool call whose arguments arrive in two pieces. */
function anthropicToolCallBody(): string {
  return [
    anthropicEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    anthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "calculator", input: {} },
    }),
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"a": 2' },
    }),
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '1, "b": 2}' },
    }),
    anthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    anthropicEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 15 },
    }),
    anthropicEvent("message_stop", { type: "message_stop" }),
  ].join("");
}

/** The Anthropic events for a plain text answer. */
function anthropicTextBody(text: string): string {
  return [
    anthropicEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_2",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    anthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    anthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    anthropicEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 8 },
    }),
    anthropicEvent("message_stop", { type: "message_stop" }),
  ].join("");
}

/**
 * Answers each request with the next recorded body, and keeps what was sent.
 *
 * Only the socket is stubbed: the real pi-ai adapter, its SSE parser and its
 * tool-argument accumulator all run, which is the part of the provider path that
 * has no other way of being exercised without a credential.
 */
function stubSockets(bodies: readonly string[]): { readonly fetch: PiAiFetch; readonly sent: JsonObject[] } {
  const sent: JsonObject[] = [];
  let served = 0;

  const fetchImpl: PiAiFetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body ?? "{}")) as JsonObject);
    const body = bodies[served];
    served += 1;
    if (body === undefined) throw new Error(`stub socket: no body for request #${served}`);

    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  return { fetch: fetchImpl, sent };
}

describe("pi-ai wire adapter with a stubbed socket", () => {
  it("runs a tool round trip on arguments the real openai-completions adapter accumulated", async () => {
    const socket = stubSockets([
      sseBody([
        openAiChunk({ role: "assistant", content: "" }),
        openAiChunk({
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "calculator", arguments: "" } },
          ],
        }),
        openAiChunk({ tool_calls: [{ index: 0, function: { arguments: '{"a": 2' } }] }),
        openAiChunk({ tool_calls: [{ index: 0, function: { arguments: '1, "b": 2}' } }] }),
        openAiChunk({}, "tool_calls"),
      ]),
      sseBody([
        openAiChunk({ role: "assistant", content: "21 * 2 = " }),
        openAiChunk({ content: "42." }),
        openAiChunk({}, "stop"),
      ]),
    ]);
    const source: PiAiStreamSource = {
      stream: (model, context, options) =>
        openAiCompletionsStream(
          // The source is only ever handed an openai-completions model; the port's
          // signature is protocol-blind, this adapter is not.
          model as Model<"openai-completions">,
          normalizeContext(context),
          { ...options, fetch: socket.fetch },
        ),
    };

    const calculator = createCalculator();
    const tools = createToolRegistry();
    tools.register(calculator.tool);
    const session = createSession("s-1");
    const runtime = runtimeFor(
      createPiAiModelClient({ models: source, model: TEST_MODEL, apiKey: "unused" }),
      tools,
    );

    const result = await runtime.run({ session, text: "what is 21 * 2" });

    expect(result).toMatchObject({ text: "21 * 2 = 42.", reason: "completed" });
    // The two argument fragments arrived as one parsed object, which is the whole
    // reason the Core never sees a delta.
    expect(calculator.inputs).toEqual([{ a: 21, b: 2 }]);
    // The second request carried the projection back: the call and its result.
    expect(socket.sent).toHaveLength(2);
    const [replay] = socket.sent.slice(1);
    const messages = (replay?.messages ?? []) as readonly Record<string, unknown>[];
    // The system prompt travels as the `developer` role here: which role carries it is
    // exactly the kind of provider detail the Core leaves to pi-ai.
    expect(messages.map((message) => message.role)).toEqual([
      "developer",
      "user",
      "assistant",
      "tool",
    ]);
    expect(messages[2]).toMatchObject({
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "calculator", arguments: '{"a":21,"b":2}' } },
      ],
    });
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "42" });
  });

  it("runs the same round trip over the anthropic-messages protocol", async () => {
    const socket = stubSockets([anthropicToolCallBody(), anthropicTextBody("21 * 2 = 42.")]);
    const source: PiAiStreamSource = {
      stream: (model, context, options) =>
        anthropicMessagesStream(
          model as Model<"anthropic-messages">,
          normalizeContext(context),
          { ...options, fetch: socket.fetch },
        ),
    };

    const calculator = createCalculator();
    const tools = createToolRegistry();
    tools.register(calculator.tool);
    const session = createSession("s-1");
    const runtime = runtimeFor(
      createPiAiModelClient({ models: source, model: TEST_MODEL, apiKey: "unused" }),
      tools,
    );

    const result = await runtime.run({ session, text: "what is 21 * 2" });

    expect(result).toMatchObject({ text: "21 * 2 = 42.", reason: "completed" });
    expect(calculator.inputs).toEqual([{ a: 21, b: 2 }]);

    // Anthropic takes tool results as user content, which is exactly the provider
    // normalization the Core refuses to know about: deriveMessages stayed as it was.
    const [replay] = socket.sent.slice(1);
    const messages = (replay?.messages ?? []) as readonly Record<string, unknown>[];
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(messages[2])).toContain("toolu_1");
    expect(JSON.stringify(messages[2])).toContain("42");
  });
});

describe("pi-ai adapter cancellation", () => {
  it("closes the turn as cancelled when the signal aborts mid-answer", async () => {
    const abort = new AbortController();
    const chunks: string[] = [];
    // The provider keeps talking after the abort: the Core must stop listening at
    // its own checkpoint rather than trust the client to stop.
    const source: PiAiStreamSource = {
      stream: () =>
        (async function* () {
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: "partial",
            partial: fauxAssistantMessage("partial"),
          };
          abort.abort();
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: "after the abort",
            partial: fauxAssistantMessage("after the abort"),
          };
          yield { type: "done", reason: "stop", message: fauxAssistantMessage("after the abort") };
        })(),
    };
    const session = createSession("s-1");
    const runtime = runtimeFor(createPiAiModelClient({ models: source, model: TEST_MODEL }), createToolRegistry());

    const events: RuntimeEvent[] = [];
    for await (const event of runtime.stream({ session, text: "answer me", signal: abort.signal })) {
      events.push(event);
      if (event.type === "assistant/chunk") chunks.push(event.text);
    }

    expect(chunks).toEqual(["partial"]);
    expect(events.at(-1)).toMatchObject({ type: "turn/end", reason: "cancelled" });
    // The aborted step is not a fact about the conversation.
    expect(session.events().map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "turn/end",
    ]);
  });
});
