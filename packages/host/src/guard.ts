/**
 * What a managed, durable execution will not accept from a model.
 *
 * The host keeps every settled turn in a store whose records are bounded and
 * whose JSON profile is strict, so there are model outputs that could run but
 * could never be kept: a tool argument carrying `undefined`, a cycle, a `Date`,
 * a value with an accessor, or simply a step whose escaped encoding is larger
 * than one record may hold. Discovering that at commit time is too late by
 * exactly one tool call — the side effect has already happened — so the checks
 * are placed at the one seam that is *before* everything the host does with a
 * step: the model's own stream.
 *
 * Three rules shape the wrapper.
 *
 * One owned step. A tool call is taken over the moment it arrives: its
 * arguments become this host's own isolated JSON snapshot, and that snapshot is
 * what travels on — to the Core's log, to the tool, and to storage. The
 * provider's object is never read again, so a provider that mutates the call it
 * emitted (or a nested object, array or property of it) cannot change what was
 * validated, what ran, or what was recorded. The isolation is a deep copy, not
 * a freeze: freezing the provider's object would still leave the same object in
 * play. Hostile shapes are not executed for inspection either — the JSON guard
 * is descriptor-based, never reads through an accessor and never calls
 * `toJSON`.
 *
 * One validation, on every ending. A step is checked before the Core can act on
 * it — whether the stream says `done` or simply ends, because the Core's
 * contract accepts a natural EOF as a completed step. The check measures the
 * records the step will really become, with the turn's own identity, through
 * the store's own payload builder, against the store's own record bound.
 *
 * One execution input. Nothing here truncates, rewrites, drops a call or
 * weakens an argument. A step that cannot be kept whole, or whose call cannot
 * be owned as JSON, is a step that does not run: it never becomes an assistant
 * record, never declares tool calls, and therefore never reaches the registry.
 */

import type { ModelClient, ModelEvent, ModelRequest, RuntimeContext, Session, ToolCall } from "@every-dagent/agent-core";
import { validateJsonValue } from "@every-dagent/protocol";

import { stepRecordsFit } from "./repository.js";

/**
 * A step the host refused before anything depended on it.
 *
 * The message is fixed and carries no part of the offending value: it becomes
 * the failed attempt's reason, and a reason is not a place for a model's own
 * bytes.
 */
export class StepRefusedError extends Error {
  constructor(detail: string) {
    super(`the model step cannot be part of a durable conversation: ${detail}`);
    this.name = "StepRefusedError";
  }
}

/** The turn a step being streamed belongs to. */
export interface StepTurnIdentity {
  /** The turn identity the Core opened for this step, from its own log. */
  readonly turnId: string;
}

export interface StepGuardOptions {
  /** The most one encoded durable record may occupy, envelope included. */
  readonly maxRecordBytes: number;
  /**
   * Names the turn the step being streamed belongs to, or `undefined` when this
   * host is not running a turn. Resolved when the step ends, never guessed: the
   * size the step is held to is the size its records will really be written at.
   */
  readonly turnOf: () => StepTurnIdentity | undefined;
}

/**
 * The turn a session's log has open, if any.
 *
 * The Core appends `turn/start` with the turn's identity before it asks the
 * model for anything, so this is the turn the step belongs to — and it is read
 * from the log rather than from a host-side copy, which is what makes it the
 * same identity the commit will write, not a race with it.
 */
export function openTurnOf(session: Session): string | undefined {
  let open: string | undefined;
  for (const event of session.events()) {
    if (event.type === "turn/start") open = event.turnId;
    else if (event.type === "turn/end") open = undefined;
  }
  return open;
}

/**
 * One field of a provider's value, read only if reading it cannot run code.
 *
 * The value comes from the property's own data descriptor, so no `[[Get]]`
 * ever happens: an accessor would have to execute to be read, and a value that
 * cannot be read without running something is not one this host may hand to a
 * tool or write down as fact. Enumerability is required for the same reason the
 * JSON guard requires it — a property the wire's own copy would not see is not
 * part of the value. A provider is free to hand over a Proxy; a trap that
 * throws is a refusal, not a crash.
 */
function ownField(owner: unknown, name: string, what: string): unknown {
  if (owner === null || (typeof owner !== "object" && typeof owner !== "function")) {
    throw new StepRefusedError(`${what} is not an object this host can read`);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(owner, name);
  } catch {
    throw new StepRefusedError(`${what} is not an object this host can read`);
  }
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    throw new StepRefusedError(`${what} has no plain ${name}`);
  }
  return descriptor.value;
}

/**
 * Takes ownership of one tool call, or refuses it.
 *
 * Every field is read through its own data descriptor *before* anything is read
 * from it, so a call whose `input` (or `callId`, or `name`) is an accessor is
 * refused without ever running the accessor — the validation and ownership
 * below happen to a value the provider cannot hand out twice. The call's
 * identity must be text and its arguments must be exactly what the durable JSON
 * profile accepts; on success the returned call carries an isolated deep
 * snapshot, so the provider cannot reach the value that will be logged,
 * executed and stored. On failure nothing is owned, because nothing that could
 * not be given back as fact may run.
 */
function ownedToolCall(call: unknown): ToolCall {
  const callId = ownField(call, "callId", "a tool call");
  const name = ownField(call, "name", "a tool call");
  const input = ownField(call, "input", "a tool call");
  if (typeof callId !== "string" || typeof name !== "string") {
    throw new StepRefusedError("a tool call has no call identity");
  }
  const validated = validateJsonValue(input);
  if (!validated.success) {
    throw new StepRefusedError("a tool call's arguments are not something JSON can carry");
  }
  return Object.freeze({ callId, name, input: validated.output });
}

/**
 * Checks one completed step against the records it will become.
 *
 * The measurement is the durable one: the step's assistant declaration and each
 * of its calls, encoded through the store's own payload builder with the turn's
 * real identity, against the store's own record bound. `text` and the calls
 * have already been isolated; what remains is whether the store could hold them.
 */
export function assertStepStorable(
  step: { readonly text: string; readonly toolCalls: readonly ToolCall[] },
  options: StepGuardOptions,
): void {
  if (typeof step.text !== "string") throw new StepRefusedError("the step's text is not text");
  const identity = options.turnOf();
  if (identity === undefined) {
    throw new StepRefusedError("the step does not belong to a turn this host is running");
  }
  if (!stepRecordsFit(step, identity.turnId, options.maxRecordBytes)) {
    throw new StepRefusedError("the step's records do not fit the durable record bound");
  }
}

/**
 * The injected model client, with the step guard in front of it.
 *
 * Text passes through untouched; tool calls pass through as the host's own
 * snapshots; and a step that must not proceed is answered with a throw, which
 * the Core already treats as a failed model step.
 */
export function guardedModelClient(inner: ModelClient, options: StepGuardOptions): ModelClient {
  return {
    stream(request: ModelRequest, context: RuntimeContext): AsyncIterable<ModelEvent> {
      return guardStream(inner.stream(request, context), options);
    },
  };
}

async function* guardStream(
  source: AsyncIterable<ModelEvent>,
  options: StepGuardOptions,
): AsyncGenerator<ModelEvent> {
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];
  let completed = false;

  for await (const event of source) {
    // The event's own shape is read the same way the call's fields are: an
    // accessor is a shape this host refuses to execute, wherever it sits.
    const type = ownField(event, "type", "a model event");

    if (type === "tool-call") {
      // Owned here, at the moment it arrives: from this point on the step's
      // call is this host's snapshot, and the provider's object is out of the
      // picture for validation, execution and storage alike.
      const owned = ownedToolCall(ownField(event, "call", "a tool call event"));
      toolCalls.push(owned);
      yield { type: "tool-call" as const, call: owned };
      continue;
    }

    if (type === "done") {
      // Checked before the loop sees it: the step becomes an assistant record
      // only if this returns, so a refusal here is before every consequence.
      assertStepStorable({ text: text.join(""), toolCalls }, options);
      completed = true;
    }
    if (type === "text-delta") {
      // Read through the descriptor like every other field — an accessor is
      // never run — but not otherwise reinterpreted here: what a text chunk
      // must be is the Core's and the projection's question, and this guard
      // does not get to change an answer they already give.
      text.push(ownField(event, "text", "a text delta") as string);
    }

    yield event;
  }

  // A stream that ends is a completed step, whether or not it said `done`
  // first, so a natural EOF is held to exactly the same check.
  if (!completed) assertStepStorable({ text: text.join(""), toolCalls }, options);
}
