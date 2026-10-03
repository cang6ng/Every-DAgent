/**
 * The capability fixtures declare, so that a fake model is a *usable* one.
 *
 * A ModelClient has to state finite limits before the Core will trust it with a
 * request, and a fixture that declared tiny ones would fail the budget instead
 * of testing what it means to test. These numbers are comfortable and finite:
 * big enough that an ordinary test turn fits with room to spare, small enough
 * that a test which means to overflow the budget can still do so deliberately.
 */

import { DEFAULT_MODEL_FRAMING } from "@every-dagent/agent-core";
import type { ModelLimits } from "@every-dagent/agent-core";

export const TEST_MODEL_LIMITS: ModelLimits = Object.freeze({
  contextWindow: 128 * 1024,
  maxOutputTokens: 8 * 1024,
  framing: DEFAULT_MODEL_FRAMING,
});

/** A capability with a chosen context window, for budget-boundary tests. */
export function limitsWithWindow(contextWindow: number, maxOutputTokens = 8 * 1024): ModelLimits {
  return Object.freeze({ contextWindow, maxOutputTokens, framing: DEFAULT_MODEL_FRAMING });
}
