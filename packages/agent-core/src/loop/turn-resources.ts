/**
 * The shared resource profile a managed turn runs inside, and the meter that
 * holds one turn to it.
 *
 * These numbers are one set of facts, so they live in one place: the Core's
 * loop and the host's durable wrapper both read this object, and neither keeps
 * a private copy of "16" that could drift from the other. They are *per-turn*
 * bounds — one step's calls, one neutral item, one turn's staging — and
 * deliberately not a cap on how much history may accumulate. Nothing here
 * evicts, archives or forgets anything.
 *
 * The meter is where a turn's own honesty is decided. A fact the turn records
 * is charged before it is recorded, so a turn that cannot fit is a turn that
 * never wrote itself down; and a fact a *tool* produced is charged after the
 * tool ran, which is why it raises a different fault — one that says an
 * external effect may already exist rather than pretending the turn can be
 * reconsidered.
 */

import { ManagedDeclarationError, TurnResourceFault } from "../errors.js";
import { escapedStringBytes, jsonDepthOf, neutralBytes } from "../context/stable-json.js";
import type { ToolCall } from "../model/message.js";

/**
 * What one managed turn may spend.
 *
 * `maxSteps` and `maxModelAttempts` are the loop's own budget, restated here so
 * that a composition that wants to drive the loop with smaller bounds changes
 * one object rather than two constants. `maxNeutralItemBytes` and
 * `maxCurrentTurnBytes` are neutral measures — UTF-8 bytes of stable JSON — and
 * are therefore *not* the host's durable record bound: a record also carries an
 * envelope and the store's own escaping, so both guards exist and both run.
 */
export interface LoopResourceLimits {
  readonly maxSteps: number;
  readonly maxModelAttempts: number;
  readonly maxToolCallsPerStep: number;
  readonly maxNeutralItemBytes: number;
  readonly maxCurrentTurnBytes: number;
  readonly maxJsonDepth: number;
}

/** The approved defaults, and the only place they are written down. */
export const LOOP_RESOURCE_LIMITS: LoopResourceLimits = Object.freeze({
  maxSteps: 12,
  maxModelAttempts: 3,
  maxToolCallsPerStep: 16,
  maxNeutralItemBytes: 64 * 1024,
  maxCurrentTurnBytes: 1024 * 1024,
  maxJsonDepth: 32,
});

/**
 * Room kept for the terminal fact of a turn.
 *
 * A turn's content is charged so that this much of the budget always remains,
 * which is what makes "a turn that fit its content can always also be closed"
 * true rather than hopeful. The terminal record is tiny; the point is that it
 * is never the fact that fails to fit.
 */
export const TERMINAL_HEADROOM_BYTES = 1024;

/** A declaration the turn refused, before anything depending on it happened. */
function declaration(message: string): ManagedDeclarationError {
  return new ManagedDeclarationError(message);
}

/** A tool's own result that the turn can no longer record. */
function fault(message: string): TurnResourceFault {
  return new TurnResourceFault(message);
}

/** Checks an injected profile, and returns this Core's own frozen copy. */
export function validateLoopResourceLimits(value: LoopResourceLimits): LoopResourceLimits {
  const limits = value as unknown as Record<string, unknown>;
  for (const name of [
    "maxSteps",
    "maxModelAttempts",
    "maxToolCallsPerStep",
    "maxNeutralItemBytes",
    "maxCurrentTurnBytes",
    "maxJsonDepth",
  ]) {
    const entry = limits?.[name];
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
      throw declaration(`the loop resource profile's ${name} is not a positive whole number`);
    }
  }
  return Object.freeze({ ...(value as LoopResourceLimits) });
}

/**
 * One tool call, refused unless this turn could declare it.
 *
 * Both questions are asked here because neither implies the other: a small
 * value can nest past what an adapter will accept, and a shallow one can be
 * larger than a turn may hold. What the call's *arguments* are allowed to be is
 * the same question the estimator answers about a request — JSON this Core can
 * represent — so the answer comes from the same walk.
 */
export function assertToolInput(
  call: { readonly name: string; readonly input: unknown },
  limits: LoopResourceLimits,
): void {
  let depth: number;
  let bytes: number;
  try {
    depth = jsonDepthOf(call.input);
    bytes = neutralBytes(call.input);
  } catch {
    throw declaration(`tool call "${call.name}" has arguments this turn cannot record`);
  }
  if (depth > limits.maxJsonDepth) {
    throw declaration(`tool call "${call.name}" nests deeper than a managed step may declare`);
  }
  if (bytes > limits.maxNeutralItemBytes) {
    throw declaration(`tool call "${call.name}" has arguments larger than one turn item may be`);
  }
}

/**
 * One turn's own resource accounting.
 *
 * The meter is charged as the turn writes itself down and never re-derived from
 * the log, because the question it answers — "may this fact exist?" — has to be
 * answered before the fact does. What it counts is everything the turn holds at
 * once: the framing facts, the user input, each step's declaration, the
 * independent call records that repeat the declaration's calls, each result, and
 * the staging of the step that is still arriving.
 *
 * Staging and facts are counted apart. What a step has staged so far is held as
 * its own quantity, because a step that a retry abandons never becomes a fact at
 * all; when the step settles, its facts are charged and the staging is dropped.
 * Nothing is released that was recorded, because a turn's recorded facts are the
 * turn.
 */
export class TurnResourceMeter {
  private readonly limits: LoopResourceLimits;
  private used = 0;
  private staging = 0;

  constructor(limits: LoopResourceLimits) {
    this.limits = limits;
  }

  /** What the turn has recorded so far, in neutral bytes. */
  get bytes(): number {
    return this.used;
  }

  /** The profile this meter enforces. */
  get profile(): LoopResourceLimits {
    return this.limits;
  }

  /**
   * Charges one fact the turn is about to record.
   *
   * Refusal here is a refusal of the whole step: nothing has run that depends on
   * the fact, so a turn that cannot fit one is a turn that stops before it does.
   */
  commit(what: string, fact: unknown): void {
    this.charge(this.costOf(what, fact, declaration), true, declaration);
    this.staging = 0;
  }

  /**
   * Charges one result a tool has already produced.
   *
   * The tool ran, so the turn can no longer be phrased differently out of the
   * problem: the fault raised here says so, and travels out of the loop so the
   * host can record the run as a failure rather than commit a turn it cannot
   * keep whole.
   */
  commitResult(what: string, fact: unknown): void {
    this.charge(this.costOf(what, fact, fault), true, fault);
  }

  /** Charges the fact that closes the turn, which the headroom above reserved room for. */
  commitTerminal(what: string, fact: unknown): void {
    this.charge(this.costOf(what, fact, fault), false, fault);
  }

  /**
   * Bounds the text of the step now arriving, before it is a declaration.
   *
   * The cost is the delta's own escaped JSON content, which is the same escaping
   * the whole declaration is later charged for — counted per chunk so that a
   * model that talks forever is stopped while it is talking, not after.
   */
  stageText(delta: string): void {
    this.chargeStaging(Math.max(0, escapedStringBytes(delta) - 2), "text");
  }

  /**
   * Bounds the calls of the step now arriving, before any of them is declared.
   *
   * Only the *staging* is bounded here — what the step is holding while it
   * arrives, which has to stay finite or there would be nothing left to judge —
   * and the bound is the one every fact is held to: what it costs to represent,
   * and how much of the turn is left. What the group really is — how many calls
   * it names, how deep their arguments nest, whether each of them could be part
   * of a managed turn at all — is decided once, by the loop, when the whole step
   * is about to be written down and before any of it can run.
   */
  stageCall(call: ToolCall): void {
    const what = `tool call "${call.name}"`;
    this.chargeStaging(this.costOf(what, call, declaration), what);
  }

  /** Forgets what an abandoned attempt had staged; nothing of it was recorded. */
  discardStaging(): void {
    this.staging = 0;
  }

  private chargeStaging(cost: number, what: string): void {
    this.charge(cost, true, () => declaration(`the staged ${what} exceeds the current turn's resource budget`), true);
  }

  private costOf(what: string, fact: unknown, refuse: (message: string) => Error): number {
    const cost = neutralOf(fact, refuse, what);
    if (cost > this.limits.maxNeutralItemBytes) {
      throw refuse(`${what} is larger than one turn item may be`);
    }
    return cost;
  }

  private charge(
    cost: number,
    keepHeadroom: boolean,
    refuse: (message: string) => Error,
    staging = false,
  ): void {
    const next = this.used + this.staging + cost;
    const ceiling = keepHeadroom
      ? this.limits.maxCurrentTurnBytes - TERMINAL_HEADROOM_BYTES
      : this.limits.maxCurrentTurnBytes;
    if (next > ceiling) throw refuse("the current turn has spent its whole resource budget");
    if (staging) this.staging += cost;
    else this.used += cost;
  }
}

/** One fact's neutral cost, with everything unmeasurable turned into one refusal. */
function neutralOf(fact: unknown, refuse: (message: string) => Error, what = "a turn fact"): number {
  try {
    return neutralBytes(fact);
  } catch {
    throw refuse(`${what} is not something this turn can record`);
  }
}
