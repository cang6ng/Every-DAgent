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

import type {
  ModelClient,
  ModelEvent,
  ModelLimits,
  ModelMessage,
  ModelRequest,
  RuntimeContext,
  ToolCall,
  ToolSchema,
} from "@every-dagent/agent-core";
import {
  DEFAULT_MODEL_FRAMING,
  ModelLimitsError,
  NonRetryableModelError,
  validateModelLimits,
} from "@every-dagent/agent-core";

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
   * The output ceiling this profile is allowed to declare.
   *
   * It is a *ceiling*, not the cap of any request: every request carries its own
   * `maxOutputTokens` from the Core's budget, and that is what is sent. This
   * number only bounds what the Core may reserve — `0 < configured <= native
   * maxTokens` — so a composition can promise less than the model offers and
   * cannot promise more.
   */
  readonly maxTokens?: number;
  /**
   * Per-request timeout, passed to the provider client. What a client reports for a
   * timeout arrives as an error terminal, which this adapter turns into a throw.
   */
  readonly timeoutMs?: number;
}

/**
 * A model API whose request body this adapter cannot prove carries the right cap.
 *
 * It is refused at the composition that would have used it — the adapter does not
 * become an executable ModelClient for a profile whose output cap it cannot
 * enforce — and never negotiated down: the contract is that the provider's own
 * output cap equals the request's reserve, and an API this adapter has no
 * serializer evidence for is one where it cannot say that.
 */
export class UnsupportedPiAiProfileError extends NonRetryableModelError {}

/**
 * The provider APIs this adapter has serializer evidence for.
 *
 * For each one: the field names its request body may carry an output cap in, and
 * the set of names that would be a *different* cap if they appeared. The check
 * below is written against these two lists rather than against a predicted
 * `compat` decision, so a pi-ai that changes which field it writes is caught by
 * comparing the body it really built — not by re-deriving its logic here.
 *
 * This table is also the adapter's profile admission: an API that is not in it has
 * no evidence behind it, and a model that names one cannot become an executable
 * profile. Two spellings of the same OpenAI-compatible protocol are the same
 * entry, because they are the same serializer: which of the two field names it
 * writes is decided by pi-ai, and the payload guard accepts either.
 */
const AUDITED_PROFILES: Readonly<
  Record<string, { readonly capFields: readonly string[]; readonly conflicting: readonly string[] }>
> = Object.freeze({
  "anthropic-messages": {
    capFields: ["max_tokens"],
    conflicting: ["max_tokens", "max_completion_tokens", "max_output_tokens"],
  },
  "openai-completions": {
    capFields: ["max_tokens", "max_completion_tokens"],
    conflicting: ["max_tokens", "max_completion_tokens", "max_output_tokens"],
  },
});

/** A positive whole number of tokens, which is the only usable cap. */
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** What the adapter has to know to run: the capability, and the audited shape. */
interface BoundedProfile {
  readonly limits: ModelLimits;
  readonly cap: {
    readonly capFields: readonly string[];
    readonly conflicting: readonly string[];
  };
}

/**
 * The capability this adapter declares, read from the model it will really call,
 * and the profile it will run it under.
 *
 * Every question that can be answered from the model's own metadata is answered
 * here, before there is a client to hand out: are the limits usable, is the
 * configured ceiling a cap below the model's own maximum, and — the one that
 * decides whether this is an *executable* profile at all — is the API one whose
 * request body this adapter can prove carries the request's own output cap. A
 * model that fails any of them is refused at construction rather than admitted
 * and refused later: a composition that cannot enforce the cap must not be able
 * to reach `ready` and record a run first.
 *
 * Nothing here looks at the model's *name*, nothing reaches the network, and
 * nothing consults a provider.
 */
function boundedProfileOf({ model, maxTokens }: PiAiModelClientOptions): BoundedProfile {
  if (!positiveInteger(model.contextWindow)) {
    throw new ModelLimitsError("the model declares no usable context window");
  }
  if (!positiveInteger(model.maxTokens)) {
    throw new ModelLimitsError("the model declares no usable maximum output");
  }
  if (maxTokens !== undefined && (!positiveInteger(maxTokens) || maxTokens > model.maxTokens)) {
    throw new ModelLimitsError("the configured output ceiling is not a cap below the model's own maximum");
  }

  const cap = AUDITED_PROFILES[model.api as string];
  if (cap === undefined) {
    throw new UnsupportedPiAiProfileError(
      `the model API "${model.api}" is not one whose output cap this adapter can enforce`,
    );
  }

  return {
    limits: validateModelLimits({
      contextWindow: model.contextWindow,
      maxOutputTokens: maxTokens ?? model.maxTokens,
      framing: DEFAULT_MODEL_FRAMING,
    }),
    cap,
  };
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
 * - send the request's own output cap, and prove the body the provider is handed
 *   really carries it;
 * - report text and *finished* tool calls as `ModelEvent`s;
 * - turn every failure into a throw, including the ones pi-ai reports as an
 *   ordinary terminal (a truncated answer most of all) — so that a stream that
 *   merely ends can only ever mean a step that completed;
 * - retry nothing: retry is the AgentLoop's decision and would otherwise multiply.
 *
 * A model whose profile is not executable throws from here, which is the whole
 * point of the boundary: there is no `ModelClient` to compose, so no host, no
 * admitted run and no first request that has to discover it.
 */
export function createPiAiModelClient(options: PiAiModelClientOptions): ModelClient {
  const { limits, cap } = boundedProfileOf(options);
  return { limits, stream: (request, context) => stream(options, limits, cap, request, context) };
}

async function* stream(
  { models, model, apiKey, timeoutMs }: PiAiModelClientOptions,
  limits: ModelLimits,
  profile: BoundedProfile["cap"],
  request: ModelRequest,
  context: RuntimeContext,
): AsyncGenerator<ModelEvent> {
  const cap = request.maxOutputTokens;
  if (!positiveInteger(cap) || cap > limits.maxOutputTokens) {
    // This request reserved more output than this profile may ever send. It never
    // reaches the provider, and no attempt can change the answer.
    throw new NonRetryableModelError("the request's output reserve is larger than this profile allows");
  }

  // A pi-ai payload guard that fails does not fail quietly: pi-ai reports the
  // hook's exception as an ordinary `error` terminal, whose message is the SDK's
  // own text. The typed failure is kept here, in the closure that produced it, so
  // the stream's end can be classified by what actually happened rather than by
  // reading the SDK's words back.
  let refusal: NonRetryableModelError | undefined;
  const onPayload = (payload: unknown): undefined => {
    try {
      assertEnforcedCap(payload, profile, cap);
    } catch (error) {
      refusal =
        error instanceof NonRetryableModelError
          ? error
          : new NonRetryableModelError("the provider request could not be inspected");
      throw error;
    }
    return undefined;
  };

  let events: AsyncIterable<AssistantMessageEvent>;
  try {
    events = models.stream(
      model,
      {
        systemPrompt: request.systemPrompt,
        messages: toPiAiMessages(request.messages, model),
        tools: request.tools.map(toPiAiTool),
      },
      {
        signal: context.signal,
        apiKey,
        // The request's own cap, never the profile ceiling: what the Core
        // reserved for this request is what the provider is allowed to produce.
        maxTokens: cap,
        timeoutMs,
        onPayload,
        // The request layer must not retry: the AgentLoop retries whole steps, and two
        // layers retrying the same failure would multiply the attempts while hiding
        // the decision from the turn's own record. pi-ai's own default is already zero
        // retries; saying it here keeps that property from changing under the Core.
        maxRetries: 0,
      },
    );
  } catch (error) {
    throw refusal ?? localFailure(error);
  }

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
        if (refusal !== undefined) throw refusal;
        assertUsableEnd(event.message);
        yield* unreportedCalls(event.message, reported);
        yield { type: "done" };
        return;

      case "error":
        throw refusal ?? providerFailure(event.reason);

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
        throw new NonRetryableModelError(`pi-ai event this adapter does not know: ${describe(unhandled)}`);
      }
    }
  }

  // pi-ai reports every failure through a terminal event, so a stream that ends
  // without one is broken — and the Core reads a silent end as a completed step,
  // which makes this the one failure it must never be handed.
  throw refusal ?? new NonRetryableModelError("the provider stream ended without a done or error event");
}

/**
 * The decision this adapter exists to make, taken on the body pi-ai really built.
 *
 * A payload is acceptable only when exactly one cap field from the profile's list
 * is present and its value is the request's own reserve. A missing cap means the
 * provider picks its own; a second one means two numbers disagree about the
 * answer; a different value means the reserve the Core enforced is not the
 * reserve that was sent. All three are the same failure, and it happens before
 * `fetch`.
 */
function assertEnforcedCap(
  payload: unknown,
  profile: { readonly capFields: readonly string[] },
  cap: number,
): void {
  if (typeof payload !== "object" || payload === null) {
    throw new NonRetryableModelError("the provider request is not a body this adapter can inspect");
  }

  const carried = profile.capFields.filter((field) => capabilityField(payload, field) !== undefined);
  if (carried.length !== 1) {
    throw new NonRetryableModelError("the provider request does not carry exactly one enforceable output cap");
  }
  if (capabilityField(payload, carried[0] as string) !== cap) {
    throw new NonRetryableModelError("the provider request's output cap is not the one this request reserved");
  }
}

/**
 * One field of a payload, read only if reading it cannot run code.
 *
 * The payload is pi-ai's own object, built a moment ago — but the guard's whole
 * value is that it checks the thing that is about to be sent, so it reads the way
 * this codebase reads untrusted shapes: from the property's own data descriptor.
 * An accessor is reported as present-and-not-the-cap, which is a refusal.
 */
function capabilityField(payload: object, name: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(payload, name);
  } catch {
    return UNREADABLE;
  }
  if (descriptor === undefined) return undefined;
  if (descriptor.get !== undefined || descriptor.set !== undefined) return UNREADABLE;
  return descriptor.value;
}

/** A payload property that would have to run to be read. */
const UNREADABLE: unique symbol = Symbol("every-dagent.capability-unreadable");

/**
 * A local failure raised while building the request, in this adapter's own words.
 *
 * A recorded call whose arguments are not the JSON object every wire format
 * requires is a request this adapter cannot send — deterministically, whatever the
 * provider would have said. It is reported as such instead of being retried, and
 * the provider's rejection is never what a caller sees.
 */
function localFailure(error: unknown): NonRetryableModelError {
  if (error instanceof NonRetryableModelError) return error;
  return new NonRetryableModelError("the request could not be sent to the provider");
}

/**
 * A provider failure, in fixed words.
 *
 * Nothing of the provider's own report travels: no body, header, cause,
 * credential, URL or stack. The reason is classified by the terminal pi-ai
 * reported — an abort is an abort — and everything else is one safe failure.
 * Whether a failure may be retried is not decided here: this adapter has no
 * trusted transient signal to offer, so it offers the Core the safe default.
 */
function providerFailure(reason: "aborted" | "error"): NonRetryableModelError {
  return new NonRetryableModelError(
    reason === "aborted" ? "the provider request was aborted" : "the provider request failed",
  );
}

/** A short, provider-free description of an event shape this adapter does not know. */
function describe(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const type = Object.getOwnPropertyDescriptor(value, "type")?.value;
    if (typeof type === "string") return JSON.stringify(type);
  }
  return typeof value;
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
 *
 * Every message here is written by this adapter. The terminal message's own
 * `errorMessage` is provider text and is never quoted, however useful it looks.
 */
function assertUsableEnd(message: AssistantMessage): void {
  switch (message.stopReason) {
    case "stop":
    case "toolUse":
      return;
    case "length":
      throw new NonRetryableModelError("pi-ai response was truncated: the model hit its output token limit");
    case "pending":
      throw new NonRetryableModelError("pi-ai response ended while its stop reason was still pending");
    case "deferred":
      throw new NonRetryableModelError("pi-ai returned a deferred response, which this Core does not support");
    case "aborted":
      throw new NonRetryableModelError("pi-ai response was aborted");
    case "error":
      throw new NonRetryableModelError("pi-ai response failed");
    default: {
      // Exhaustive on purpose: a stop reason this adapter has never seen must not be
      // read as a usable answer, and a new one has to stop the build to be noticed.
      const unhandled: never = message.stopReason;
      throw new NonRetryableModelError(`pi-ai stop reason this adapter does not know: ${describe(unhandled)}`);
    }
  }
}

/** Whether a value is the JSON object a tool call's arguments have to be. */
function isArgumentsObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  throw new NonRetryableModelError(`tool call "${call.name}" has input that is not a JSON object`);
}

/** pi-ai wants usage on a replayed assistant message; a replay has none to report. */
function noUsage(): Usage {
  return {
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
