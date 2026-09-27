import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  JsonObject,
  Message,
  Model,
  StreamOptions,
  Tool as ToolDefinition,
  ToolCall as PiAiToolCall,
  TSchema,
  Usage,
} from "@earendil-works/pi-ai";

import type { RuntimeContext } from "../runtime/runtime-context.js";
import type { ModelMessage, ToolCall } from "./message.js";
import type { ModelClient, ModelEvent, ModelRequest, ToolSchema } from "./model-client.js";

/**
 * The slice of pi-ai's model registry this adapter calls: one streaming request.
 *
 * Narrowed to the one member it uses so the adapter says exactly what it depends
 * on — and so a test can drive it with scripted events instead of a provider. The
 * integration tests hand it pi-ai's real `Models`, so a change to that signature
 * fails the typecheck there rather than at a real request.
 */
export interface PiAiStreamSource {
  stream(
    model: Model<Api>,
    context: Context,
    options?: StreamOptions,
  ): AsyncIterable<AssistantMessageEvent>;
}

export interface PiAiModelClientOptions {
  /** The registry the model belongs to. */
  readonly models: PiAiStreamSource;
  /** The model to call: it carries the wire protocol (`api`) and its `baseUrl`. */
  readonly model: Model<Api>;
  /**
   * Request credential. Left out, pi-ai resolves one from its own credential store
   * or the provider's environment variables — the Core never reads credentials, and
   * nothing here ever logs them.
   */
  readonly apiKey?: string;
  /**
   * Output cap. Left out, the provider client's own default applies — pi-ai only
   * falls back to the model's declared `maxTokens` on its `streamSimple` path.
   */
  readonly maxTokens?: number;
  /**
   * Per-request timeout, passed to the provider client. What a client reports for a
   * timeout arrives as an error terminal, which this adapter turns into a throw.
   */
  readonly timeoutMs?: number;
}

/**
 * The pi-ai-backed ModelClient — the only place where the Core's provider-neutral
 * vocabulary meets a real provider.
 *
 * It owns no protocol: pi-ai speaks OpenAI-compatible and Anthropic, assembles
 * tool-call argument deltas, and merges the consecutive tool results a provider
 * expects. What is left to do here is the part pi-ai leaves to its caller:
 *
 * - turn a `ModelRequest` into the request shape pi-ai asks for;
 * - report text and *finished* tool calls as `ModelEvent`s;
 * - turn every failure into a throw, including the ones pi-ai reports as an
 *   ordinary terminal (a truncated answer most of all) — so that a stream that
 *   merely ends can only ever mean a step that completed;
 * - retry nothing: retry is the AgentLoop's decision and would otherwise multiply.
 */
export function createPiAiModelClient(options: PiAiModelClientOptions): ModelClient {
  return { stream: (request, context) => stream(options, request, context) };
}

async function* stream(
  { models, model, apiKey, maxTokens, timeoutMs }: PiAiModelClientOptions,
  request: ModelRequest,
  context: RuntimeContext,
): AsyncGenerator<ModelEvent> {
  const events = models.stream(
    model,
    {
      systemPrompt: request.systemPrompt,
      messages: toPiAiMessages(request.messages, model),
      tools: request.tools.map(toPiAiTool),
    },
    {
      signal: context.signal,
      apiKey,
      maxTokens,
      timeoutMs,
      // The request layer must not retry: the AgentLoop retries whole steps, and two
      // layers retrying the same failure would multiply the attempts while hiding
      // the decision from the turn's own record. pi-ai's own default is already zero
      // retries; saying it here keeps that property from changing under the Core.
      maxRetries: 0,
    },
  );

  const reported = new Set<string>();

  for await (const event of events) {
    switch (event.type) {
      case "text_delta":
        yield { type: "text-delta", text: event.delta };
        break;

      case "toolcall_end":
        reported.add(event.toolCall.id);
        yield { type: "tool-call", call: finishedCall(event.toolCall) };
        break;

      case "done":
        // A `done` is not automatically a usable answer: it may be a truncation or a
        // deferred response, which the Core has no way to represent and must not
        // mistake for an answer that finished.
        assertUsableEnd(event.message);
        yield* unreportedCalls(event.message, reported);
        yield { type: "done" };
        return;

      case "error":
        throw requestFailure(event.reason, event.error);

      case "start":
      case "text_start":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
        // pi-ai's own bookkeeping. Argument deltas are pi-ai's to assemble, and
        // thinking is not part of the Phase 1 event vocabulary.
        break;

      default: {
        // Written to be exhaustive: this assignment only compiles while every other
        // variant is handled, so a new pi-ai event stops the build instead of being
        // dropped at runtime.
        const unhandled: never = event;
        throw new Error(`pi-ai event this adapter does not know: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  // pi-ai reports every failure through a terminal event, so a stream that ends
  // without one is broken — and the Core reads a silent end as a completed step,
  // which makes this the one failure it must never be handed.
  throw new Error("pi-ai stream ended without a done or error event");
}

/**
 * The calls the terminal message names that were never reported as they were built.
 *
 * pi-ai's own adapters finish every call before `done`, so this yields nothing for
 * them — but the Core reads "text and no calls" as a finished answer, and a call
 * that only showed up at the end must not be dropped on the floor.
 */
function* unreportedCalls(
  message: AssistantMessage,
  reported: ReadonlySet<string>,
): Generator<ModelEvent> {
  for (const block of message.content) {
    if (block.type !== "toolCall" || reported.has(block.id)) continue;
    yield { type: "tool-call", call: finishedCall(block) };
  }
}

/**
 * A tool call pi-ai finished assembling, in the Core's shape.
 *
 * `arguments` is copied at the top level when it is the object the wire formats
 * require: pi-ai's `partial` is a live accumulator, and what the Core keeps must not
 * be reachable from it. Anything else the model produced travels exactly as it came
 * — turning `[1, 2]` into `{0: 1, 1: 2}` would invent arguments the model never
 * gave. Nested values stay by reference, like every other payload the Core keeps.
 */
function finishedCall(call: PiAiToolCall): ToolCall {
  const input: unknown = call.arguments;

  return {
    callId: call.id,
    name: call.name,
    input: isArgumentsObject(input) ? { ...input } : input,
  };
}

/**
 * Judged the terminal event's own verdict.
 *
 * `length` is the truncation case: the model was cut off, and a partial answer that
 * looks like a finished one is worse than no answer. The rest cannot reach a `done`
 * in a well-behaved stream; if one does, it is reported rather than swallowed.
 */
function assertUsableEnd(message: AssistantMessage): void {
  switch (message.stopReason) {
    case "stop":
    case "toolUse":
      return;
    case "length":
      throw new Error("pi-ai response was truncated: the model hit its output token limit");
    case "pending":
      throw new Error("pi-ai response ended while its stop reason was still pending");
    case "deferred":
      throw new Error("pi-ai returned a deferred response, which Phase 1 does not support");
    case "aborted":
      throw new Error(`pi-ai response was aborted: ${errorDetail(message)}`);
    case "error":
      throw new Error(`pi-ai response failed: ${errorDetail(message)}`);
    default: {
      // Exhaustive on purpose: a stop reason this adapter has never seen must not be
      // read as a usable answer, and a new one has to stop the build to be noticed.
      const unhandled: never = message.stopReason;
      throw new Error(`pi-ai stop reason this adapter does not know: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Whether a value is the JSON object a tool call's arguments have to be. */
function isArgumentsObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestFailure(reason: "aborted" | "error", message: AssistantMessage): Error {
  if (reason === "aborted") return new Error(`pi-ai request was aborted: ${errorDetail(message)}`);
  return new Error(`pi-ai request failed: ${errorDetail(message)}`);
}

function errorDetail(message: AssistantMessage): string {
  return message.errorMessage ?? "the provider gave no error message";
}

/** The session projection, in the shape pi-ai sends to a provider. */
function toPiAiMessages(messages: readonly ModelMessage[], model: Model<Api>): Message[] {
  return messages.flatMap((message): Message[] => {
    switch (message.role) {
      case "user":
        return [{ role: "user", content: message.text, timestamp: Date.now() }];

      case "assistant":
        return [
          {
            role: "assistant",
            // A replay is text plus the calls it made; a step that only asked for a
            // tool carries an empty text block, which providers reject as content.
            content: [
              ...(message.text === "" ? [] : [{ type: "text" as const, text: message.text }]),
              ...message.toolCalls.map((call) => ({
                type: "toolCall" as const,
                id: call.callId,
                name: call.name,
                arguments: toArguments(call),
              })),
            ],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: noUsage(),
            stopReason: message.toolCalls.length > 0 ? "toolUse" : "stop",
            // pi-ai's message types want a time; the session log keeps its own, and
            // this one marks when the request was built.
            timestamp: Date.now(),
          },
        ];

      case "tool":
        // One result message per result, which is also the shape a provider expects:
        // merging consecutive results is pi-ai's job, not this projection's.
        return message.results.map((result) => ({
          role: "toolResult" as const,
          toolCallId: result.callId,
          toolName: result.name,
          content: [{ type: "text" as const, text: result.content }],
          isError: !result.ok,
          timestamp: Date.now(),
        }));
    }
  });
}

/**
 * The arguments of a recorded tool call, in the shape the wire formats require.
 *
 * The Core keeps `input` opaque, so a call a model produced is always an object
 * here; anything else would be rejected by the provider with a far worse message
 * than this one.
 */
function toArguments(call: ToolCall): JsonObject {
  if (isArgumentsObject(call.input)) return call.input;
  throw new Error(`tool call "${call.name}" has input that is not a JSON object`);
}

/** pi-ai wants usage on a replayed assistant message; a replay has none to report. */
function noUsage(): Usage {  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * The Core's tool schema as pi-ai declares tools.
 *
 * `inputSchema` is opaque to the Core by design, and a TypeBox schema is plain
 * JSON, so the declared schema travels as it is.
 */
function toPiAiTool(schema: ToolSchema): ToolDefinition {
  return {
    name: schema.name,
    description: schema.description,
    parameters: schema.inputSchema as TSchema,
  };
}
