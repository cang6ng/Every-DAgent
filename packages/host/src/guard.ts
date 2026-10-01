/**
 * What a managed, durable execution will not accept from a model.
 *
 * The host keeps every settled turn in a store whose records are bounded and
 * whose JSON profile is strict, so there are model outputs that could run but
 * could never be kept: a tool argument carrying `undefined`, a cycle, a `Date`,
 * a value with an accessor, or simply an argument whose escaped encoding is
 * larger than one record may hold. Discovering that at commit time is too late
 * by exactly one tool call — the side effect has already happened — so the
 * check is placed at the one seam that is *before* everything the host does
 * with a step: the model's own stream.
 *
 * The wrapper is deliberately transparent: every event passes through exactly
 * as it arrived, and only the step's terminal `done` is answered with a
 * refusal when the step could not be stored. A refused step never becomes an
 * assistant record, never declares tool calls, and therefore never reaches the
 * registry — the executor count for such a step is zero, and no canonical tool
 * call is fabricated in its place.
 *
 * This is representability, not budgeting: nothing here truncates, rewrites,
 * drops a call or weakens an argument. A step that cannot be kept whole is a
 * step that does not run.
 */

import type { ModelClient, ModelEvent, ModelRequest, RuntimeContext, ToolCall } from "@every-dagent/agent-core";
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

/**
 * Checks one completed step: its text, its calls and their arguments.
 *
 * Every argument must be exactly what the durable JSON profile accepts — the
 * same deep, descriptor-based guard the wire uses, which never reads through an
 * accessor and never calls `toJSON` — and the records the step implies must fit
 * the store's record bound once encoded, escaping included.
 */
export function assertStepStorable(
  step: { readonly text: string; readonly toolCalls: readonly ToolCall[] },
  maxRecordBytes: number,
): void {
  if (typeof step.text !== "string") throw new StepRefusedError("the step's text is not text");
  for (const call of step.toolCalls) {
    if (typeof call.callId !== "string" || typeof call.name !== "string") {
      throw new StepRefusedError("a tool call has no call identity");
    }
    if (!validateJsonValue(call.input).success) {
      throw new StepRefusedError("a tool call's arguments are not something JSON can carry");
    }
  }
  if (!stepRecordsFit(step, maxRecordBytes)) {
    throw new StepRefusedError("the step's records do not fit the durable record bound");
  }
}

/**
 * The injected model client, with the step guard in front of it.
 *
 * Pass-through in both directions: the same events on the way out, untouched,
 * and a throw — which the Core already treats as a failed model step — where a
 * step must not proceed.
 */
export function guardedModelClient(inner: ModelClient, maxRecordBytes: number): ModelClient {
  return {
    stream(request: ModelRequest, context: RuntimeContext): AsyncIterable<ModelEvent> {
      return guardStream(inner.stream(request, context), maxRecordBytes);
    },
  };
}

async function* guardStream(
  source: AsyncIterable<ModelEvent>,
  maxRecordBytes: number,
): AsyncGenerator<ModelEvent> {
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];

  for await (const event of source) {
    switch (event.type) {
      case "text-delta":
        text.push(event.text);
        break;
      case "tool-call":
        toolCalls.push(event.call);
        break;
      case "done":
        // Checked before the loop sees it: the step becomes an assistant record
        // only if this returns, so a refusal here is before every consequence.
        assertStepStorable({ text: text.join(""), toolCalls }, maxRecordBytes);
        break;
    }
    yield event;
  }
}
