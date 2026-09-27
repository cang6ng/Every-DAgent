import type { AgentLoop } from "../loop/agent-loop.js";
import type { Session } from "../session/session.js";
import type { RuntimeContext } from "./runtime-context.js";

export interface AgentRuntimeDeps {
  readonly loop: AgentLoop;
}

export interface AgentRuntimeInput {
  readonly session: Session;
  readonly text: string;
  readonly userId?: string;
  /**
   * Handed to every ModelClient and Tool call of this turn as `context.signal`;
   * one turn shares one signal instance. When absent, a never-aborted signal is
   * used. P1.2 only forwards it — reacting to an abort is P1.3.
   */
  readonly signal?: AbortSignal;
}

export interface TurnResult {
  readonly turnId: string;
  readonly text: string;
}

/**
 * The Core's entry point for a turn.
 *
 * It owns the turn boundary and nothing else: it frames the turn, hands the work
 * to the AgentLoop, and closes the turn. It does not build the loop (a
 * composition root does) and never talks to the model, the tools or the context
 * builder directly.
 */
export interface AgentRuntime {
  /** Runs exactly one turn: one user input in, the final assistant answer out. */
  run(input: AgentRuntimeInput): Promise<TurnResult>;
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  return { run: (input: AgentRuntimeInput): Promise<TurnResult> => run(deps, input) };
}

async function run({ loop }: AgentRuntimeDeps, { session, text, userId, signal }: AgentRuntimeInput): Promise<TurnResult> {
  const turnId = globalThis.crypto.randomUUID();
  const context: RuntimeContext = {
    sessionId: session.id,
    userId,
    signal: signal ?? new AbortController().signal,
  };

  session.append({ type: "turn/start", turnId, data: {} });
  session.append({ type: "message/user", turnId, data: { text } });

  // P1.2 has a single outcome, so `completed` is not a decision yet. A throw from
  // the loop propagates unchanged and leaves the turn unclosed: closing it as
  // `error` or `cancelled` is P1.3's runtime engineering.
  const answer = await loop.runTurn({ session, turnId, context });

  session.append({ type: "turn/end", turnId, data: { reason: "completed" } });

  return { turnId, text: answer };
}
