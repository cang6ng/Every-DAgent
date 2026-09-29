/**
 * The test-only reverse-request profile.
 *
 * This module lives under `tests/` on purpose: the production reverse-method
 * registry is EMPTY, and nothing here may leak into `src/index.ts`, the
 * operation map or any capability. The profile reuses the production envelope
 * codec — it only refines the result of a `client-response` after the public
 * envelope validation has passed, which is exactly how a real (future)
 * reverse profile would hook in without a validation bypass.
 */

import * as v from "valibot";

/** The one fake reverse method used by the seam tests. Not a product method. */
export const TEST_PROFILE_METHOD = "test.echo";

export const testEchoParamsSchema = v.object({ value: v.string() });

export const testEchoResultSchema = v.object({ echoed: v.string() });

export type TestEchoResult = v.InferOutput<typeof testEchoResultSchema>;

/** Refines an envelope-valid `client-response` result against the fake profile. */
export function refineTestEchoResult(result: unknown): v.SafeParseResult<typeof testEchoResultSchema> {
  return v.safeParse(testEchoResultSchema, result);
}

/** Refines an envelope-valid `host-request` params against the fake profile. */
export function refineTestEchoParams(params: unknown): v.SafeParseResult<typeof testEchoParamsSchema> {
  return v.safeParse(testEchoParamsSchema, params);
}
