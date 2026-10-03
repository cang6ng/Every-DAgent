/**
 * The bounded-context contract: what a model can take, what this program
 * reserves, and what is left for input.
 *
 * Three ideas, kept apart on purpose.
 *
 * `ModelLimits` is a *capability*: a finite, declared description of the model
 * a ModelClient will actually call. It is supplied by the adapter, never
 * guessed by the Core — the Core does not know what a model name means, and a
 * limit it invented would be a limit nothing enforces. Unknown or untrustworthy
 * limits are refused rather than defaulted: an infinite context window is the
 * one answer that is always wrong.
 *
 * `ModelBudget` is a *derivation*: the same numbers, turned into the three
 * quantities a request is actually held to — how much input may be sent, how
 * much output is reserved, and how much slack covers the difference between
 * this program's estimate and a provider's own tokenizer.
 *
 * The inequality is the whole contract:
 *
 *     estimatedInput + reservedOutput + safetyMargin <= contextWindow
 *
 * It is checked before every provider call, against the request that is about
 * to be sent, by the one guard every builder goes through.
 */

import { ModelBudgetError, ModelLimitsError } from "../errors.js";

/**
 * What one structural element costs beyond the bytes of its own content.
 *
 * These are not a tokenizer theorem. They are the adapter's declaration that a
 * request of this shape carries at least this much framing, and they are only
 * meaningful for a profile whose own serializer tests show they do not
 * under-count the structure around the content. A provider for which no such
 * evidence exists is not a supported profile, and does not get to declare
 * smaller numbers instead.
 */
export interface ModelFramingCost {
  readonly request: number;
  readonly system: number;
  readonly message: number;
  readonly toolDefinition: number;
  readonly toolCall: number;
  readonly toolResult: number;
}

/**
 * What a model can take, as declared by the adapter that will call it.
 *
 * `minOutputTokens` is the profile's floor, when it has one: a model that
 * refuses to answer unless it is allowed at least this much output cannot be
 * driven by a budget that reserves less.
 */
export interface ModelLimits {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly framing: ModelFramingCost;
  readonly minOutputTokens?: number;
}

/**
 * The three quantities a request is held to, all derived here and nowhere else.
 *
 * `maxInputCost` is what remains for `estimatedInput`: the context window minus
 * the output reserve and the safety margin. It is the only number a selector or
 * a builder has to fit inside, and it is always positive — a budget without
 * room for a single byte of input is not a budget.
 */
export interface ModelBudget {
  readonly contextWindow: number;
  readonly reservedOutput: number;
  readonly safetyMargin: number;
  readonly maxInputCost: number;
}

/** The default output reserve: `R = min(4096, modelMaxOutputTokens)`. */
export const DEFAULT_RESERVED_OUTPUT = 4096;

/** The floor under the safety margin: `S = max(1024, ceil(0.1 * C))`. */
export const MIN_SAFETY_MARGIN = 1024;

/** The share of the context window kept as slack for tokenizer disagreement. */
export const SAFETY_MARGIN_RATIO = 0.1;

/**
 * The framing profile Sol's implementation plan approved, as an adapter
 * declaration.
 *
 * It lives in the Core only because every adapter that has no better evidence
 * may declare it and every test fixture needs one; the numbers still belong to
 * whoever declares them, and a profile whose serializer tests cannot back them
 * up is unsupported rather than quieter.
 */
export const DEFAULT_MODEL_FRAMING: ModelFramingCost = Object.freeze({
  request: 256,
  system: 64,
  message: 64,
  toolDefinition: 128,
  toolCall: 64,
  toolResult: 64,
});

/** A positive, finite, whole number: the only shape a limit may have. */
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A whole number that may be zero: framing costs are never negative. */
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function framingOf(value: unknown): ModelFramingCost {
  if (typeof value !== "object" || value === null) {
    throw new ModelLimitsError("the model's framing cost is not a set of numbers");
  }
  const framing = value as Record<string, unknown>;
  for (const part of ["request", "system", "message", "toolDefinition", "toolCall", "toolResult"]) {
    if (!nonNegativeInteger(framing[part])) {
      throw new ModelLimitsError(`the model's ${part} framing cost is not a whole number of bytes`);
    }
  }
  return Object.freeze({
    request: framing.request as number,
    system: framing.system as number,
    message: framing.message as number,
    toolDefinition: framing.toolDefinition as number,
    toolCall: framing.toolCall as number,
    toolResult: framing.toolResult as number,
  });
}

/**
 * Checks a declared capability, and returns this Core's own frozen copy of it.
 *
 * Everything is refused that could make an arithmetic guarantee untrue:
 * `Infinity` and `NaN` (which would make every request fit), zero and negatives
 * (which would make the reserve meaningless), fractions and unsafe integers
 * (which would make a byte count something nobody can reproduce). The input is
 * typed, but it arrives from an adapter and is validated as if it were not.
 */
export function validateModelLimits(value: unknown): ModelLimits {
  if (typeof value !== "object" || value === null) {
    throw new ModelLimitsError("the model client declared no limits");
  }
  const limits = value as Record<string, unknown>;

  if (!positiveInteger(limits.contextWindow)) {
    throw new ModelLimitsError("the model's context window is not a positive whole number of tokens");
  }
  if (!positiveInteger(limits.maxOutputTokens)) {
    throw new ModelLimitsError("the model's maximum output is not a positive whole number of tokens");
  }
  if (limits.minOutputTokens !== undefined && !positiveInteger(limits.minOutputTokens)) {
    throw new ModelLimitsError("the model's minimum output is not a positive whole number of tokens");
  }
  if (
    limits.minOutputTokens !== undefined &&
    (limits.minOutputTokens as number) > limits.maxOutputTokens
  ) {
    throw new ModelLimitsError("the model's minimum output is larger than its maximum output");
  }

  const framing = framingOf(limits.framing);
  return Object.freeze({
    contextWindow: limits.contextWindow,
    maxOutputTokens: limits.maxOutputTokens,
    framing,
    ...(limits.minOutputTokens === undefined
      ? {}
      : { minOutputTokens: limits.minOutputTokens as number }),
  });
}

/**
 * Derives the budget a request is held to.
 *
 * The two default rules are the frozen ones — `R = min(4096, maxOutput)` and
 * `S = max(1024, ceil(0.1 * C))` — and both are computed here so that no caller
 * can hold a request to a reserve it chose itself. A budget that leaves nothing
 * for input, or that reserves less output than the profile requires, is refused
 * here: a model that cannot be driven inside these rules is a model this Core
 * declines to call, which is different from calling it and hoping.
 */
export function defineModelBudget(limits: ModelLimits): ModelBudget {
  const reservedOutput = Math.min(DEFAULT_RESERVED_OUTPUT, limits.maxOutputTokens);
  const safetyMargin = Math.max(MIN_SAFETY_MARGIN, Math.ceil(SAFETY_MARGIN_RATIO * limits.contextWindow));
  const maxInputCost = limits.contextWindow - reservedOutput - safetyMargin;

  if (maxInputCost <= 0) {
    throw new ModelBudgetError("the model's context window leaves no room for input after its reserves");
  }
  if (limits.minOutputTokens !== undefined && reservedOutput < limits.minOutputTokens) {
    throw new ModelBudgetError("the model's minimum output is larger than this budget's output reserve");
  }

  return Object.freeze({
    contextWindow: limits.contextWindow,
    reservedOutput,
    safetyMargin,
    maxInputCost,
  });
}
