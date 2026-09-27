import { errorMessageOf } from "../errors.js";
import type { AgentLoop, AgentLoopEvent, AgentLoopInput, TurnOutcome } from "../loop/agent-loop.js";
import type { Session } from "../session/session.js";
import type { TurnEndReason } from "../session/session-event.js";
import type { RuntimeContext } from "./runtime-context.js";
import type { RuntimeEvent } from "./runtime-event.js";

export interface AgentRuntimeDeps {
  readonly loop: AgentLoop;
}

export interface AgentRuntimeInput {
  readonly session: Session;
  readonly text: string;
  readonly userId?: string;
  /**
   * Handed to every ModelClient and Tool call of this turn as `context.signal`;
   * one turn shares one signal instance, and the caller's own instance is passed
   * through unchanged. Aborting it stops the turn at its next checkpoint — before
   * a model call, between streamed events, or before the next tool runs.
   *
   * When absent, a never-aborted signal is used: v0.1 has no detach-abort, so a
   * host that wants a turn to stop has to say so through a signal.
   */
  readonly signal?: AbortSignal;
}

export interface TurnResult {
  readonly turnId: string;
  readonly text: string;
  /** Why the turn ended, so a caller can tell an answer from a cancellation. */
  readonly reason: TurnEndReason;
  /** Set when the turn ended as `error`; the message the Core failed with. */
  readonly error?: string;
}

/**
 * The Core's entry point for a turn.
 *
 * It owns the turn boundary and nothing else: it frames the turn, hands the work
 * to the AgentLoop, and closes the turn with the reason the loop reported. It does
 * not build the loop (a composition root does) and never talks to the model, the
 * tools or the context builder directly.
 */
export interface AgentRuntime {
  /**
   * Runs exactly one turn: one user input in, the closed turn out. A failed turn
   * is a result with `reason: "error"`, not a rejection.
   */
  run(input: AgentRuntimeInput): Promise<TurnResult>;
  /**
   * The same turn, reported as it happens. Both façades drive the one turn path
   * above; this one additionally hands every event to the caller — `tool/call` and
   * `tool/result` as they are recorded, `assistant/chunk` the moment the model
   * produced it, which is before the step it belongs to is complete.
   */
  stream(input: AgentRuntimeInput): AsyncIterable<RuntimeEvent>;
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  return {
    run: (input: AgentRuntimeInput): Promise<TurnResult> => driveTurn(deps, input, () => {}),
    stream: (input: AgentRuntimeInput): AsyncIterable<RuntimeEvent> => streamTurn(deps, input),
  };
}

/**
 * The one turn path both façades share: frame the turn, drive the loop, close the
 * turn. `push` is the only difference between them — a listener or nothing.
 */
async function driveTurn(
  deps: AgentRuntimeDeps,
  { session, text, userId, signal }: AgentRuntimeInput,
  push: (event: RuntimeEvent) => void,
): Promise<TurnResult> {
  const turnId = globalThis.crypto.randomUUID();
  const context: RuntimeContext = {
    sessionId: session.id,
    userId,
    signal: signal ?? new AbortController().signal,
  };
  const emit = (event: AgentLoopEvent): void => {
    push(toRuntimeEvent(event, session.id, turnId));
  };

  session.append({ type: "turn/start", turnId, data: {} });
  session.append({ type: "message/user", turnId, data: { text } });

  const outcome: TurnOutcome = await runLoop(deps, { session, turnId, context, emit });

  // The turn is closed with the reason the loop reported. `error` is written only
  // when there is one, so a turned-out-fine turn leaves no empty field behind.
  const failed = outcome.error === undefined ? undefined : { error: outcome.error };
  session.append({ type: "turn/end", turnId, data: { reason: outcome.reason, ...failed } });
  push({ type: "turn/end", sessionId: session.id, turnId, reason: outcome.reason, ...failed });

  return { turnId, text: outcome.text, reason: outcome.reason, ...failed };
}

/**
 * The same guard rail the loop keeps for its own steps, kept again by the layer
 * that owns the turn boundary.
 *
 * The redundancy is deliberate: the loop is an injected dependency, and the Runtime
 * is the one that promised the turn would be closed. A loop that rejects still gets
 * its turn written down as one that ended.
 */
async function runLoop(deps: AgentRuntimeDeps, input: AgentLoopInput): Promise<TurnOutcome> {
  try {
    return await deps.loop.runTurn(input);
  } catch (error) {
    if (input.context.signal.aborted) return { reason: "cancelled", text: "" };
    return { reason: "error", text: "", error: errorMessageOf(error) };
  }
}

/**
 * `stream()`'s pull side: it yields what the turn has produced and parks until
 * there is more, ending when the turn closes the channel.
 */
async function* streamTurn(
  deps: AgentRuntimeDeps,
  input: AgentRuntimeInput,
): AsyncGenerator<RuntimeEvent> {
  const channel = createEventChannel<RuntimeEvent>();

  const turn = (async (): Promise<TurnResult> => {
    try {
      return await driveTurn(deps, input, channel.push);
    } finally {
      // Also on failure: the channel is the only way the consumer learns the turn
      // is over, so it must be closed exactly once, from here.
      channel.close();
    }
  })();

  // A consumer that stops listening leaves the turn running — stopping it is the
  // signal's job — so its outcome has to be observed here or a late failure would
  // surface as an unhandled rejection.
  void turn.catch(() => {});

  yield* channel.drain();
  await turn;
}

/**
 * The envelope is the Runtime's, and only the Runtime's: `turnId` is generated
 * here, so a loop event cannot carry the wrong one.
 */
function toRuntimeEvent(event: AgentLoopEvent, sessionId: string, turnId: string): RuntimeEvent {
  switch (event.type) {
    case "assistant/chunk":
      return { type: "assistant/chunk", sessionId, turnId, text: event.text };
    case "tool/call":
      return {
        type: "tool/call",
        sessionId,
        turnId,
        callId: event.callId,
        name: event.name,
        input: event.input,
      };
    case "tool/result":
      return {
        type: "tool/result",
        sessionId,
        turnId,
        callId: event.callId,
        name: event.name,
        ok: event.ok,
        content: event.content,
      };
  }
}

/**
 * Bridges the loop's push-style events into `stream()`'s pull-style iteration.
 *
 * `push` is called from inside the turn's own async flow and is safe to keep as a
 * bare reference. The queue is unbounded on purpose: the producer is a model call
 * away from the consumer, so parking the turn on a slow reader would stall the
 * very thing it is reporting.
 */
function createEventChannel<T>(): {
  push(event: T): void;
  close(): void;
  drain(): AsyncGenerator<T>;
} {
  const queue: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;

  const notify = (): void => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  return {
    push(event: T): void {
      // A closed channel is a turn nobody is listening to any more.
      if (closed) return;
      queue.push(event);
      notify();
    },
    close(): void {
      closed = true;
      notify();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as T;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
