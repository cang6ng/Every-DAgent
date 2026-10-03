import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessageEvent,
  Context,
  JsonObject,
  Model,
  StreamOptions,
} from "@earendil-works/pi-ai";

import type { PiAiStreamSource } from "../../src/pi-ai-client.js";

/**
 * A complete pi-ai `Model` for tests. The adapter only passes its metadata through
 * (protocol, provider, id, base URL), so nothing here has to be reachable.
 */
export const TEST_MODEL: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://provider.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

/**
 * A pi-ai registry that replays scripted event streams instead of calling a provider.
 *
 * The adapter exists to be precise about which of pi-ai's events become which Core
 * events and which ones become throws, so the tests drive it with the event
 * sequences themselves rather than through a provider's behavior.
 */
export interface ScriptedPiAiStream extends PiAiStreamSource {
  /** Every request context it was handed, in call order. */
  readonly contexts: readonly Context[];
  /** Every options object it was handed, in call order. */
  readonly options: readonly (StreamOptions | undefined)[];
  /** Every model it was handed, in call order. */
  readonly models: readonly Model<Api>[];
}

export function createScriptedPiAiStream(
  scripts: readonly (readonly AssistantMessageEvent[])[],
): ScriptedPiAiStream {
  const contexts: Context[] = [];
  const options: (StreamOptions | undefined)[] = [];
  const models: Model<Api>[] = [];
  let calls = 0;

  return {
    contexts,
    options,
    models,
    stream(
      model: Model<Api>,
      context: Context,
      streamOptions?: StreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      models.push(model);
      contexts.push(context);
      options.push(streamOptions);

      const script = scripts[calls];
      calls += 1;
      if (script === undefined) {
        throw new Error(`scripted pi-ai stream: no script for call #${calls}`);
      }

      return replay(script);
    },
  };
}

async function* replay(
  events: readonly AssistantMessageEvent[],
): AsyncGenerator<AssistantMessageEvent> {
  yield* events;
}

/** What a provider emits for a plain text answer. */
export function textScript(text: string): AssistantMessageEvent[] {
  const partial = fauxAssistantMessage(text);

  return [
    { type: "start", partial },
    { type: "text_start", contentIndex: 0, partial },
    { type: "text_delta", contentIndex: 0, delta: text, partial },
    { type: "text_end", contentIndex: 0, content: text, partial },
    { type: "done", reason: "stop", message: partial },
  ];
}

/**
 * What a provider emits for a tool call, arguments arriving in pieces: the adapter
 * must report the call once, complete, and never as deltas.
 */
export function toolCallScript(
  callId: string,
  name: string,
  arguments_: JsonObject,
): AssistantMessageEvent[] {
  const call = fauxToolCall(name, arguments_, { id: callId });
  const partial = fauxAssistantMessage([call], { stopReason: "toolUse" });
  const json = JSON.stringify(arguments_);

  return [
    { type: "start", partial },
    { type: "toolcall_start", contentIndex: 0, partial },
    { type: "toolcall_delta", contentIndex: 0, delta: json.slice(0, 4), partial },
    { type: "toolcall_delta", contentIndex: 0, delta: json.slice(4), partial },
    { type: "toolcall_end", contentIndex: 0, toolCall: call, partial },
    { type: "done", reason: "toolUse", message: partial },
  ];
}

/** What a provider emits when the answer was cut off at the token limit. */
export function truncatedScript(text: string): AssistantMessageEvent[] {
  const partial = fauxAssistantMessage(text, { stopReason: "length" });

  return [
    { type: "start", partial },
    { type: "text_delta", contentIndex: 0, delta: text, partial },
    { type: "done", reason: "length", message: partial },
  ];
}

/** What a provider emits when the request failed after the stream had started. */
export function errorScript(errorMessage: string): AssistantMessageEvent[] {
  return [
    {
      type: "error",
      reason: "error",
      error: fauxAssistantMessage("", { stopReason: "error", errorMessage }),
    },
  ];
}

/** What pi-ai emits when the caller's own signal ended the request. */
export function abortedScript(): AssistantMessageEvent[] {
  return [
    {
      type: "error",
      reason: "aborted",
      error: fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "request aborted" }),
    },
  ];
}

/**
 * A provider client that builds a body, runs the caller's `onPayload` hook, and
 * only then "sends" it — which is what pi-ai's own adapters do.
 *
 * `sent` counts the requests that got past the hook, so a test can prove that a
 * refused cap stopped the request before the network rather than after it. A hook
 * that throws is reported the way pi-ai reports one: as an ordinary `error`
 * terminal quoting the thrown text, which is why the adapter has to keep its own
 * typed failure in a closure instead of reading the SDK's words back.
 */
export interface RewriteSource extends PiAiStreamSource {
  /** How many requests got past the payload hook. */
  readonly sent: number;
}

export function createRewriteSource(
  rewrite: (payload: Record<string, unknown>) => Record<string, unknown>,
): RewriteSource {
  const source = {
    sent: 0,
    async *stream(
      model: Model<Api>,
      _context: Context,
      streamOptions?: StreamOptions,
    ): AsyncGenerator<AssistantMessageEvent> {
      const built = rewrite({
        model: model.id,
        messages: [],
        stream: true,
        max_tokens: streamOptions?.maxTokens,
      });

      try {
        await streamOptions?.onPayload?.(built, model);
      } catch (error) {
        yield {
          type: "error",
          reason: "error",
          error: fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
          }),
        };
        return;
      }

      source.sent += 1;
      const answer = fauxAssistantMessage("ok");
      yield { type: "start", partial: answer };
      yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: answer };
      yield { type: "text_end", contentIndex: 0, content: "ok", partial: answer };
      yield { type: "done", reason: "stop", message: answer };
    },
  };

  return source as RewriteSource;
}
