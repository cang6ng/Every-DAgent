/**
 * The last thing between a built request and a provider: ownership, then an
 * independent check.
 *
 * A ContextBuilder is a seam, and a seam is a place where the Core stops
 * knowing what happened. Everything before this file trusts that whatever was
 * built is what the builder meant to build; this file does not. It takes the
 * candidate apart into this Core's own frozen data — so nothing the builder
 * holds afterwards can change what was measured — and then re-derives, from the
 * session itself, what the request is allowed to contain and what it may cost.
 *
 * The two halves answer different questions:
 *
 * `ownModelRequest` answers "is this a request at all?" — a shape the Core can
 * represent, measure, and hand to an adapter without anyone running code.
 *
 * `assertModelRequestFits` answers "is this still *this* conversation?" — the
 * composition's fixed context is present, the current turn's user input and
 * call identities are intact, history is whole turns rather than fragments, the
 * only change to a tool result is the truncation the selector is allowed to
 * make, and the whole thing costs no more than the budget allows. A custom
 * builder that adds context is welcome to; it is charged for it, and it may not
 * pay for it by rewriting something that was already true.
 */

import {
  ContextBudgetError,
  InvalidModelRequestError,
} from "../errors.js";
import type { ModelMessage, ToolCall, ToolResult } from "../model/message.js";
import type { ModelRequest, ToolSchema } from "../model/model-client.js";
import type { SessionEvent } from "../session/session-event.js";
import { estimateRequestCost } from "./context-estimator.js";
import type { FixedContext } from "./context-builder.js";
import { isLegalTruncation, projectSessionTurns, projectTurn } from "./context-selection.js";
import { defineModelBudget, validateModelLimits, type ModelLimits } from "./model-budget.js";
import { ownJsonValue, stableJSON } from "./stable-json.js";

function refuse(what: string): InvalidModelRequestError {
  return new InvalidModelRequestError(what);
}

/** Runs a structural read, turning anything it throws into one fixed refusal. */
function reading<T>(what: string, act: () => T): T {
  try {
    return act();
  } catch (error) {
    if (error instanceof InvalidModelRequestError) throw error;
    throw refuse(`${what} is not a value this Core can read`);
  }
}

interface Fields {
  readonly names: readonly string[];
  read(name: string): unknown;
}

/**
 * The own, enumerable, readable properties of a plain object.
 *
 * An accessor is not a value: reading one would run code that the measurement
 * below would then be reporting on. Non-enumerable properties are invisible to
 * every wire format, so they are ignored rather than refused.
 */
function fieldsOf(value: unknown, what: string): Fields {
  return reading(what, () => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw refuse(`${what} is not an object`);
    }
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      throw refuse(`${what} has a prototype JSON cannot reproduce`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw refuse(`${what} carries symbol-keyed data`);

    const names: string[] = [];
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || descriptor.enumerable !== true) continue;
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw refuse(`${what} has a property that would have to run to be read`);
      }
      if (descriptor.value === undefined) continue;
      names.push(name);
    }

    return {
      names,
      // An absent property is a property the sender did not send, which is what
      // the optional fields of a request mean. A present one is read from its own
      // descriptor again, so what is validated is what is copied.
      read: (name: string): unknown => Object.getOwnPropertyDescriptor(value, name)?.value,
    };
  });
}

/** Refuses a field that is present but not the shape the type requires. */
function onlyKeys(fields: Fields, allowed: readonly string[], what: string): void {
  for (const name of fields.names) {
    if (!allowed.includes(name)) throw refuse(`${what} has a field this Core does not send: ${name}`);
  }
}

function textField(fields: Fields, name: string, what: string): string {
  const value = fields.read(name);
  if (typeof value !== "string") throw refuse(`${what} has no text`);
  return value;
}

function ownedToolCalls(value: unknown, what: string): readonly ToolCall[] {
  if (!Array.isArray(value)) throw refuse(`${what} is not a list of tool calls`);
  return Object.freeze(
    value.map((call, index) => {
      const callFields = fieldsOf(call, `${what} ${index}`);
      onlyKeys(callFields, ["callId", "name", "input"], `${what} ${index}`);
      return Object.freeze({
        callId: textField(callFields, "callId", `${what} ${index}`),
        name: textField(callFields, "name", `${what} ${index}`),
        input: ownJsonValue(callFields.read("input"), `${what} ${index}`),
      });
    }),
  );
}

function ownedToolResults(value: unknown, what: string): readonly ToolResult[] {
  if (!Array.isArray(value)) throw refuse(`${what} is not a list of tool results`);
  return Object.freeze(
    value.map((result, index) => {
      const resultFields = fieldsOf(result, `${what} ${index}`);
      onlyKeys(resultFields, ["callId", "name", "ok", "content"], `${what} ${index}`);
      const ok = resultFields.read("ok");
      if (typeof ok !== "boolean") throw refuse(`${what} ${index} has no outcome`);
      return Object.freeze({
        callId: textField(resultFields, "callId", `${what} ${index}`),
        name: textField(resultFields, "name", `${what} ${index}`),
        ok,
        content: textField(resultFields, "content", `${what} ${index}`),
      });
    }),
  );
}

function ownMessage(value: unknown, what: string): ModelMessage {
  const fields = fieldsOf(value, what);
  const role = fields.read("role");

  switch (role) {
    case "user":
      onlyKeys(fields, ["role", "text"], what);
      return Object.freeze({ role: "user", text: textField(fields, "text", what) });
    case "assistant":
      onlyKeys(fields, ["role", "text", "toolCalls"], what);
      return Object.freeze({
        role: "assistant",
        text: textField(fields, "text", what),
        toolCalls: ownedToolCalls(fields.read("toolCalls"), `${what}'s tool calls`),
      });
    case "tool":
      onlyKeys(fields, ["role", "results"], what);
      return Object.freeze({
        role: "tool",
        results: ownedToolResults(fields.read("results"), `${what}'s results`),
      });
    default:
      throw refuse(`${what} has a role no model message has`);
  }
}

/** The tools a request declares, owned and frozen. */
function ownToolSchemas(value: unknown, what: string): readonly ToolSchema[] {
  if (!Array.isArray(value)) throw refuse(`${what} is not a list of tools`);
  return Object.freeze(
    value.map((tool, index) => {
      const fields = fieldsOf(tool, `${what} ${index}`);
      onlyKeys(fields, ["name", "description", "inputSchema"], `${what} ${index}`);
      return Object.freeze({
        name: textField(fields, "name", `${what} ${index}`),
        description: textField(fields, "description", `${what} ${index}`),
        inputSchema: ownJsonValue(fields.read("inputSchema"), `${what} ${index}`),
      });
    }),
  );
}

/**
 * The composition's fixed context, as this Core's own frozen copy.
 *
 * Read once per model step, before the builder runs, so that the context the
 * request is checked against and the context the selector built from are the
 * same object rather than two readings of a registry that could have changed in
 * between.
 */
export function ownFixedContext(fixed: FixedContext): FixedContext {
  const fields = fieldsOf(fixed, "the fixed context");
  const systemPrompt = fields.read("systemPrompt");
  if (systemPrompt !== undefined && typeof systemPrompt !== "string") {
    throw refuse("the fixed context's system prompt is not text");
  }
  return Object.freeze({
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    tools: ownToolSchemas(fields.read("tools"), "the fixed context's tools"),
  });
}

/**
 * Takes ownership of a builder's candidate, and settles its output cap.
 *
 * `maxOutputTokens` is passed in rather than read from the candidate, and it is
 * written last: the cap is the Core's number, derived from the model's declared
 * capability, and a builder — which is exactly the thing this guard exists to
 * not trust — does not get to choose how much output the model may produce.
 *
 * Fields this Core does not know are kept, deep-copied, so that a future
 * retrieval source can carry extra provider-neutral context through the same
 * seam. They are kept as JSON, which is also what makes them measurable: what
 * cannot be represented cannot be charged for, and what cannot be charged for
 * may not travel.
 */
export function ownModelRequest(candidate: ModelRequest, maxOutputTokens: number): ModelRequest {
  if (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw refuse("the budget reserved an output cap that is not a positive whole number");
  }

  const fields = fieldsOf(candidate, "the context builder's request");
  const extras: Record<string, unknown> = {};
  for (const name of fields.names) {
    if (name === "systemPrompt" || name === "messages" || name === "tools" || name === "maxOutputTokens") continue;
    extras[name] = ownJsonValue(fields.read(name), `the request's ${name}`);
  }

  const systemPrompt = fields.read("systemPrompt");
  if (systemPrompt !== undefined && typeof systemPrompt !== "string") {
    throw refuse("the request's system prompt is not text");
  }

  const messages = fields.read("messages");
  if (!Array.isArray(messages)) throw refuse("the request has no list of messages");

  return Object.freeze({
    ...extras,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    messages: Object.freeze(messages.map((message, index) => ownMessage(message, `message ${index}`))),
    tools: ownToolSchemas(fields.read("tools"), "the request's tools"),
    maxOutputTokens,
  });
}

/** The session a request claims to be built from. */
export interface GuardTurn {
  readonly events: readonly SessionEvent[];
  readonly turnId: string;
}

export interface GuardInput {
  readonly limits: ModelLimits;
  readonly fixed: FixedContext;
  /**
   * The loaded window and the open turn, when the request is being built for a
   * real turn. Left out, the guard still holds the request to the budget and to
   * the fixed context, but cannot compare it with the conversation — which is
   * exactly the admission preflight, where no conversation is loaded yet.
   */
  readonly turn?: GuardTurn;
}

/**
 * The independent final guard: the request about to be sent, checked against
 * the budget and against the conversation it claims to be.
 *
 * It runs before every provider invocation, including every retry, and it
 * rebuilds its own view of the budget rather than accepting one from its
 * caller: a guard handed the numbers it is supposed to be checking would only
 * prove that its caller and it agreed.
 */
export function assertModelRequestFits(request: ModelRequest, input: GuardInput): void {
  const limits = reading("the model's limits", () => validateModelLimits(input.limits));
  const budget = defineModelBudget(limits);

  if (request.maxOutputTokens !== budget.reservedOutput) {
    throw refuse("the request's output cap is not the budget's reserved output");
  }

  assertFixedContextPresent(request, input.fixed);

  if (input.turn !== undefined) assertFaithfulToTurn(request, input.turn);

  const cost = estimateRequestCost(request, limits);
  if (cost > budget.maxInputCost) throw new ContextBudgetError("request");
}

/**
 * Whether the composition's own system prompt and tools survived the builder.
 *
 * Tools are compared by value, not by object identity: a builder that copies a
 * schema unchanged has not changed what the model is offered. Extra tools and a
 * longer system prompt are permitted — adding context is what a builder is for —
 * while removing or rewriting what the composition declared is not, because a
 * request that quietly drops a tool is a request whose model cannot call it.
 */
function assertFixedContextPresent(request: ModelRequest, fixed: FixedContext): void {
  const byName = new Map<string, string>();
  for (const tool of request.tools) {
    const existing = byName.get(tool.name);
    if (existing !== undefined) throw refuse(`the request declares two tools named "${tool.name}"`);
    byName.set(tool.name, stableJSON(tool));
  }
  for (const tool of fixed.tools) {
    const declared = byName.get(tool.name);
    if (declared === undefined) throw refuse(`the request dropped the tool "${tool.name}" the session offers`);
    if (declared !== stableJSON(tool)) {
      throw refuse(`the request rewrote the tool "${tool.name}" the session offers`);
    }
  }

  if (fixed.systemPrompt !== undefined) {
    const declared = request.systemPrompt;
    if (declared === undefined || !declared.startsWith(fixed.systemPrompt)) {
      throw refuse("the request replaced the system prompt the composition declared");
    }
  }
}

/**
 * Whether the request is still the conversation it was built for.
 *
 * Read as three parts, which is the only order the conversation can be in: any
 * extra context a builder prepended, the newest complete turns it chose to
 * keep, and the current turn. The current turn is matched message for message,
 * with the sole allowance that a tool result may be the original's own prefix
 * plus the marker that says so. The historical part must be whole turns —
 * whatever precedes them may be anything, but it may not be a message the
 * session already produced, because a duplicated or half-spliced session
 * message is history pretending to be context.
 */
function assertFaithfulToTurn(request: ModelRequest, turn: GuardTurn): void {
  const turns = projectSessionTurns(turn.events);
  const current = turns.at(-1);
  if (current === undefined || current.turnId !== turn.turnId) {
    throw refuse("the loaded window has no open turn to build a request for");
  }
  if (current.complete) throw refuse("the loaded window's turn is already closed");

  const history = turns.slice(0, -1);
  const projected = history.map((entry) => projectTurn(entry).messages);
  const expected = projectTurn(current).messages;

  if (request.messages.length < expected.length) {
    throw refuse("the request does not carry the current turn");
  }
  const split = request.messages.length - expected.length;
  matchCurrentRun(expected, request.messages.slice(split));

  let remainder = request.messages.slice(0, split);
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const messages = projected[index] as readonly ModelMessage[];
    if (remainder.length < messages.length) break;
    const tail = remainder.slice(remainder.length - messages.length);
    if (!tail.every((message, position) => stableJSON(message) === stableJSON(messages[position]))) break;
    remainder = remainder.slice(0, remainder.length - messages.length);
  }

  if (remainder.length === 0) return;
  const sessionMessages = new Set<string>();
  for (const messages of projected) for (const message of messages) sessionMessages.add(stableJSON(message));
  for (const message of remainder) {
    if (sessionMessages.has(stableJSON(message))) {
      throw refuse("the request repeats a session message outside the complete turn it belongs to");
    }
  }
}

/** One current-turn projection, matched message for message. */
function matchCurrentRun(expected: readonly ModelMessage[], actual: readonly ModelMessage[]): void {
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index] as ModelMessage;
    const got = actual[index] as ModelMessage;
    if (want.role !== got.role) throw refuse("the request does not carry the current turn as it happened");

    if (want.role === "user" && got.role === "user") {
      if (want.text !== got.text) throw refuse("the request changed the current user input");
      continue;
    }

    if (want.role === "assistant" && got.role === "assistant") {
      if (want.text !== got.text) throw refuse("the request changed what the model was recorded to have said");
      if (want.toolCalls.length !== got.toolCalls.length) {
        throw refuse("the request does not carry the current turn's calls as they happened");
      }
      for (let call = 0; call < want.toolCalls.length; call += 1) {
        const wanted = want.toolCalls[call] as ToolCall;
        const found = got.toolCalls[call] as ToolCall;
        if (wanted.callId !== found.callId || wanted.name !== found.name) {
          throw refuse("the request changed a tool call's identity");
        }
        if (stableJSON(wanted.input) !== stableJSON(found.input)) {
          throw refuse("the request changed a tool call's arguments");
        }
      }
      continue;
    }

    if (want.role === "tool" && got.role === "tool") {
      const wanted = want.results[0] as ToolResult;
      const found = got.results[0] as ToolResult;
      if (wanted.callId !== found.callId || wanted.name !== found.name || wanted.ok !== found.ok) {
        throw refuse("the request changed a tool result's identity");
      }
      if (found.content === wanted.content) continue;
      if (!isLegalTruncation(wanted.content, found.content)) {
        throw refuse("the request rewrote a tool result instead of truncating it");
      }
      continue;
    }

    throw refuse("the request does not carry the current turn as it happened");
  }
}
