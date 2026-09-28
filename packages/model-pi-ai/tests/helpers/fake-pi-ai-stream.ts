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
}

export function createScriptedPiAiStream(
  scripts: readonly (readonly AssistantMessageEvent[])[],
): ScriptedPiAiStream {
  const contexts: Context[] = [];
  const options: (StreamOptions | undefined)[] = [];
  let calls = 0;

  return {
    contexts,
    options,
    stream(
      _model: Model<Api>,
      context: Context,
      streamOptions?: StreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
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
