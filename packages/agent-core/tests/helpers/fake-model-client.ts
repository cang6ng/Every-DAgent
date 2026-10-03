import type { ModelLimits } from "../../src/context/model-budget.js";
import type { ModelClient, ModelEvent, ModelRequest } from "../../src/model/model-client.js";
import type { RuntimeContext } from "../../src/runtime/runtime-context.js";
import { TEST_MODEL_LIMITS } from "./test-model-limits.js";

/**
 * A step that failed rather than answered, before and after producing output.
 * Which of the two it was decides whether the loop may retry it.
 */
interface FailureReply {
  readonly fail: unknown;
  readonly events?: readonly ModelEvent[];
}

/**
 * One scripted model step.
 *
 * A plain reply covers the happy paths. The failure shapes exist because the loop
 * treats "failed with nothing to show" and "failed after the audience saw text"
 * differently, and a hand-written stream is what tests need to act *during* a step,
 * such as aborting while the model is still talking.
 */
export type FakeModelReply =
  | readonly ModelEvent[]
  | FailureReply
  | ((request: ModelRequest, context: RuntimeContext) => AsyncIterable<ModelEvent>);

/**
 * A scripted ModelClient: the nth `stream()` call replays the nth reply.
 *
 * Deterministic by construction, which is what makes the ReAct loop testable
 * without a provider. The script is not recycled — running out of replies throws
 * instead of repeating the last one, so a loop that issues one model call too many
 * fails loudly rather than hanging. `repeatLast` is the one exception, for a model
 * that is meant to go on forever.
 */
export interface FakeModelClient extends ModelClient {
  /** Every request it was handed, in call order. */
  readonly requests: readonly ModelRequest[];
  /** Every RuntimeContext it was handed, in call order. */
  readonly contexts: readonly RuntimeContext[];
}

export interface FakeModelClientOptions {
  /** Replays the last reply for every call past the end of the script. */
  readonly repeatLast?: boolean;
  /** The capability this fake declares; the Core derives its budget from it. */
  readonly limits?: ModelLimits;
}

export function createFakeModelClient(
  replies: readonly FakeModelReply[],
  { repeatLast = false, limits = TEST_MODEL_LIMITS }: FakeModelClientOptions = {},
): FakeModelClient {
  const requests: ModelRequest[] = [];
  const contexts: RuntimeContext[] = [];
  let calls = 0;

  return {
    limits,
    requests,
    contexts,
    stream(request: ModelRequest, context: RuntimeContext): AsyncIterable<ModelEvent> {
      requests.push(request);
      contexts.push(context);

      const reply = replies[calls] ?? (repeatLast ? replies[replies.length - 1] : undefined);
      calls += 1;

      if (reply === undefined) {
        throw new Error(`fake model client: no scripted reply for call #${calls}`);
      }

      if (typeof reply === "function") return reply(request, context);
      if (isFailureReply(reply)) return failAfter(reply);
      return replay(reply);
    },
  };
}

/** A step that fails before yielding anything: the reply the loop may retry. */
export function failingReply(error: unknown): FailureReply {
  return { fail: error };
}

/** A step that produces output and then fails: the reply the loop must not retry. */
export function replyThenFail(events: readonly ModelEvent[], error: unknown): FailureReply {
  return { events, fail: error };
}

function isFailureReply(reply: FakeModelReply): reply is FailureReply {
  return !Array.isArray(reply);
}

async function* replay(events: readonly ModelEvent[]): AsyncGenerator<ModelEvent> {
  yield* events;
}

async function* failAfter(reply: FailureReply): AsyncGenerator<ModelEvent> {
  if (reply.events !== undefined) yield* reply.events;
  throw reply.fail;
}
