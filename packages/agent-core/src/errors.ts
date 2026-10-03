/**
 * Turns anything a caller can throw into a message string.
 *
 * The tool registry needs it to keep its "never throws at the caller" contract,
 * and the agent loop needs it to record a failure as `turn/end.error`. It lives on
 * its own so that neither module owns the other's error handling.
 */
export function errorMessageOf(error: unknown): string {
  try {
    if (error instanceof Error) return error.message;
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof (error as { message?: unknown }).message === "string"
    ) {
      return (error as { message: string }).message;
    }
    return String(error);
  } catch {
    return "<unprintable thrown value>";
  }
}

/**
 * A model-step failure that must never be retried.
 *
 * One request that cannot be built, cannot fit, or cannot be sent is one
 * request whose retry would fail in exactly the same way: the second attempt
 * spends a provider call to learn what the first one already proved. The class
 * is also the adapter's way to say "this failure is mine, not the provider's":
 * a failure a ModelClient classifies as deterministic is thrown as one of
 * these, which keeps retry a decision about unknown transports instead of a
 * decision about strings a provider happened to print.
 *
 * Every message on this hierarchy is written by this program. A provider's own
 * bytes (body, header, cause, credential, URL, stack) never travel on one.
 */
export class NonRetryableModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Limits a ModelClient declared that are not a usable capability.
 *
 * A context window of zero, a fractional token count, `Infinity` — none of
 * these is a model this Core may spend a request on, and none of them may be
 * silently repaired into one.
 */
export class ModelLimitsError extends NonRetryableModelError {}

/** A budget derived from limits that leaves no room for any input at all. */
export class ModelBudgetError extends NonRetryableModelError {}

/**
 * A candidate a ContextBuilder produced that is not a ModelRequest this Core
 * can own: an unknown message role, an accessor where a value belongs, a cycle,
 * a non-finite number, a tool schema that is not JSON.
 */
export class InvalidModelRequestError extends NonRetryableModelError {}

/**
 * What a candidate costs does not fit the budget.
 *
 * `scope` names the part that could not be made to fit, because the two cases
 * mean different things to whoever reads the turn: a `current-turn` failure
 * says the newest user input and the current tool results cannot be sent at
 * all, while a request that builds fine but overflows is a builder's bug.
 */
export class ContextBudgetError extends NonRetryableModelError {
  readonly scope: "current-turn" | "request";

  constructor(scope: "current-turn" | "request") {
    super(
      scope === "current-turn"
        ? "the current turn does not fit the model's context budget"
        : "the model request does not fit the model's context budget",
    );
    this.scope = scope;
  }
}

/**
 * A model step whose tool declarations cannot be part of a managed turn.
 *
 * The step never became an assistant record and nothing it declared ever ran,
 * which is the whole point of checking the group before it is written down: a
 * turn whose calls were already executing when the seventeenth arrived would
 * have side effects nothing could honestly describe.
 */
export class ManagedDeclarationError extends NonRetryableModelError {}

/**
 * A turn whose already-executed results no longer fit the turn's own resource
 * budget.
 *
 * This one is not a model failure and is deliberately not a subclass of one:
 * a tool has run, its side effect may exist, and no attempt to phrase the turn
 * differently can undo that. It travels out of the loop and out of the Runtime
 * without becoming a `turn/end`, so the host can record the run as the host
 * failure it is instead of committing a turn it cannot keep whole.
 */
export class TurnResourceFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnResourceFault";
  }
}
