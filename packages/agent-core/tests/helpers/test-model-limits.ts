/**
 * The shared fixture capability, re-exported where the Core's own tests expect
 * it. One definition, in `tests/helpers/model-limits.ts`, because a fixture that
 * exists twice is a fixture that can disagree with itself.
 */
export { TEST_MODEL_LIMITS, limitsWithWindow } from "../../../../tests/helpers/model-limits.js";
