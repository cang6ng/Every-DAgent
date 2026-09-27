import type { ModelClient, ModelEvent, ModelRequest } from "../../src/model/model-client.js";
import type { RuntimeContext } from "../../src/runtime/runtime-context.js";

/**
 * A scripted ModelClient: the nth `stream()` call replays the nth reply.
 *
 * Deterministic by construction, which is what makes the ReAct loop testable
 * without a provider. The script is not recycled — running out of replies throws
 * instead of repeating the last one, so a loop that issues one model call too
 * many fails loudly rather than hanging (P1.2 has no maxSteps).
 */
export interface FakeModelClient extends ModelClient {
  /** Every request it was handed, in call order. */
  readonly requests: readonly ModelRequest[];
  /** Every RuntimeContext it was handed, in call order. */
  readonly contexts: readonly RuntimeContext[];
}

export function createFakeModelClient(replies: readonly (readonly ModelEvent[])[]): FakeModelClient {
  const requests: ModelRequest[] = [];
  const contexts: RuntimeContext[] = [];
  let calls = 0;

  return {
    requests,
    contexts,
    stream(request: ModelRequest, context: RuntimeContext): AsyncIterable<ModelEvent> {
      requests.push(request);
      contexts.push(context);

      const reply = replies[calls];
      calls += 1;

      if (reply === undefined) {
        throw new Error(`fake model client: no scripted reply for call #${calls}`);
      }

      return replay(reply);
    },
  };
}

async function* replay(events: readonly ModelEvent[]): AsyncGenerator<ModelEvent> {
  yield* events;
}
