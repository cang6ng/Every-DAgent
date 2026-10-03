/**
 * The Core's prepared-execution seam: where a model step's calls stop being
 * names and become bound, owned executions.
 *
 * Everything in this module is provider-neutral and host-free. The Core defines
 * *what* a prepared execution is and *when* the batch is prepared; who decides
 * whether it may run — policy, approval, dispatch guards — is entirely the
 * boundary's business, and the boundary is injected from outside. A composition
 * that does not provide one keeps the Core's standalone behavior: calls are
 * executed by name through the registry, exactly as before.
 *
 * The batch is prepared as a whole, before anything of the step is written
 * down. `prepareBatch` is synchronous by contract, has no side effects, calls
 * no tool, asks no policy and waits for nothing: it either returns every
 * prepared call of the step, or it throws and the step declares nothing — no
 * assistant record, no `tool/call`, and therefore no execution. That order is
 * the point: a group whose second member cannot be prepared must not leave a
 * first member's side effect behind.
 */

import type { ToolCall } from "../model/message.js";
import type { RuntimeContext } from "../runtime/runtime-context.js";
import type { ToolExecutionResult } from "./tool.js";

/** Where one call sits in the conversation, as the Runtime numbered it. */
export interface ToolExecutionPosition {
  readonly turnId: string;
  readonly stepIndex: number;
  readonly callIndex: number;
}

/**
 * One call the boundary has taken over: an identity, the call as it will be
 * recorded, and the position it occupies.
 *
 * `executionId` is the execution's own identity — not the provider's call id.
 * The same `callId` in two steps is two calls with two execution ids, and an
 * approval, a dispatch decision or a delivery is about this execution and
 * nothing else. `call.input` is the authority value: frozen, owned by the
 * boundary, and the value every later projection (the step's declaration, the
 * `tool/call` fact, an approval snapshot, a policy view) is derived from.
 *
 * Instances are created by the boundary and passed back to it unchanged. The
 * Core never inspects them beyond the fields it records, and never constructs
 * one: what a boundary accepts is a fact the boundary knows privately.
 */
export interface PreparedToolExecution {
  readonly executionId: string;
  readonly call: ToolCall;
  readonly position: ToolExecutionPosition;
  /** The registry generation the binding was resolved at. */
  readonly registryGeneration: number;
}

/**
 * Why a call that was declared and recorded did not run.
 *
 * These are observations, not failures: each one is a decision the host made
 * before dispatch, and each one is safe to continue a conversation after —
 * the model is told the call did not happen and may try something else.
 */
export type NotExecutedReason =
  | "policy-denied"
  | "user-rejected"
  | "approval-expired"
  | "cancelled-before-dispatch"
  | "policy-error"
  | "execution-invalidated"
  | "approval-unavailable";

/**
 * The disposition of one prepared call.
 *
 * `executed` covers every ending after the bound executor was invoked at all —
 * a return value, a thrown error, a rejected promise, a cancellation that
 * settled — because once the call is dispatched, this Core cannot claim the
 * outside world was left untouched. `not-executed` is the other half, and it
 * is only ever produced by the boundary, before dispatch: the tool did not
 * run, and no side effect of it exists.
 */
export type PreparedDispatchOutcome =
  | { readonly executed: true; readonly result: ToolExecutionResult }
  | {
      readonly executed: false;
      readonly reason: NotExecutedReason;
      readonly result: ToolExecutionResult;
    };

/** One whole step's calls, offered for preparation. */
export interface PrepareToolBatchInput {
  readonly calls: readonly ToolCall[];
  readonly position: { readonly turnId: string; readonly stepIndex: number };
}

/**
 * The one seam a composition may place in front of tool execution.
 *
 * `prepareBatch` turns a step's calls into prepared executions — or refuses the
 * group by throwing (a `ManagedDeclarationError`, by convention, so the turn's
 * own guard rails treat it as a step that cannot be declared). Everything it
 * does must be synchronous and free of side effects.
 *
 * `executePrepared` runs one prepared call to its disposition. It is the
 * boundary's whole authority: policy, approval, dispatch guard and the actual
 * invocation live behind it, and the Core only consumes the outcome it
 * reports. It may take as long as the boundary's own contract allows — an
 * approval wait is a pending `await` here, never a durable pause — and it must
 * settle when its context's signal aborts, when the boundary is closing, or
 * when the execution is invalidated for any other reason.
 */
export interface ToolExecutionBoundary {
  prepareBatch(input: PrepareToolBatchInput): readonly PreparedToolExecution[];
  executePrepared(prepared: PreparedToolExecution, context: RuntimeContext): Promise<PreparedDispatchOutcome>;
}
