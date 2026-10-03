/**
 * Managed tool execution: the one authority between a prepared call and a
 * running tool.
 *
 * Everything in this module exists to make one sentence true: *a call runs
 * only when this host, at the instant before invoking it, still knows that it
 * may.* The Core hands over a prepared batch and nothing else — policy,
 * approval, the dispatch guard and the invocation itself all live here, and
 * the Core owns none of them.
 *
 * Four rules shape the design.
 *
 * Preparation is a whole-group, side-effect-free step. A batch that cannot be
 * prepared — an empty or duplicated call id, arguments that are not a strict
 * JSON object, a tool the registry does not have, an approval whose snapshot
 * could not fit one frame — refuses the *group*, before the step's declaration
 * exists, so a step whose second call is invalid never runs its first. It
 * calls no tool, asks no policy and waits for nothing.
 *
 * The binding is taken once and never re-read. The registry hands out a
 * registration (its identity, its tool, its captured executor); that is what
 * this module holds, and dispatch is a call to the captured function with the
 * captured receiver — not a lookup a plugin could have changed between
 * preparation and approval.
 *
 * Waiting is an await, never a durable pause. An approval is memory this host
 * holds for as long as the execution that is waiting on it; a disconnect ends
 * a delivery and changes nothing, a restart ends everything, and a cancelled
 * or faulted host wakes every wait immediately instead of leaving a run
 * holding the registry forever.
 *
 * Dispatch is a critical section. Between the guard's last check and the
 * invocation there is no await, no lookup, no policy call, no copy, no
 * publication and no callback of any kind: the phase moves to `dispatching`
 * and the cached thunk is called, in that order, in one synchronous step.
 */

import type {
  NotExecutedReason,
  PreparedDispatchOutcome,
  PreparedToolExecution,
  RuntimeContext,
  ToolCall,
  ToolExecutionBoundary,
  ToolRegistration,
} from "@every-dagent/agent-core";
import { errorMessageOf, ManagedDeclarationError, neutralBytes, TurnResourceFault } from "@every-dagent/agent-core";
import type { ApprovalSnapshot, JsonValue, ToolApprovalDecision, ToolApprovalResponse } from "@every-dagent/protocol";
import { PROTOCOL_VERSION, encodeFrame, validateJsonValue, validateReverseParams, validateReverseResult } from "@every-dagent/protocol";

import { approvalUpdatedEvent, publishEvent } from "./connection.js";
import { openTurnOf } from "./guard.js";
import { sessionSummaryOf } from "./history.js";
import {
  APPROVAL_DEADLINE_MS,
  APPROVAL_INPUT_MAX_BYTES,
  APPROVAL_MAX_DELIVERIES,
  APPROVAL_MAX_PENDING,
  APPROVAL_SNAPSHOT_MAX_BYTES,
  PROJECTION_RENDEZVOUS_MS,
} from "./limits.js";
import { consultPolicy, type CapturedToolPolicy, type ToolPolicyView } from "./policy.js";
import { projectDisplayInput } from "./projection.js";
import { createReverseTrigger, type ReverseProfile, type ReverseRequestHandle } from "./reverse.js";
import { liveRunSummaryOf, PREPARED_REQUEST_ID, snapshotCoreOf } from "./state.js";
import type { ConnectionState, HostState, ReversePendingEntry, RunEntry } from "./state.js";

/** The host's monotonic clock, injectable so a test can make deadlines happen. */
export interface HostClock {
  /** Monotonic milliseconds. The authority for every approval deadline. */
  now(): number;
  /** Epoch milliseconds, for display values only; never an authority. */
  wallNow(): number;
  setTimer(fire: () => void, delayMs: number): { cancel(): void };
}

/** The real clock: a monotonic source, the wall clock, and `setTimeout`. */
export const SYSTEM_CLOCK: HostClock = Object.freeze({
  now: (): number => performance.now(),
  wallNow: (): number => Date.now(),
  setTimer: (fire: () => void, delayMs: number): { cancel(): void } => {
    const handle = setTimeout(fire, Math.max(0, delayMs));
    return { cancel: (): void => clearTimeout(handle) };
  },
});

/** What this host's own projection binds to a prepared execution. */
export interface BoundInvocation {
  /** The live occurrence identity the client's tool card carries. */
  readonly invocationId: string;
}

/**
 * The managed execution, as the rest of the host sees it.
 *
 * `boundary` is the Core seam; the other members are this host's own wiring —
 * the projection side that completes a rendezvous, the snapshot side that
 * publishes the current approval, the frame path's synchronous claim, and the
 * cleanup a settled run performs.
 */
export interface ManagedExecution {
  readonly boundary: ToolExecutionBoundary;
  /** Binds one prepared execution to its live occurrence; ignored for unknown ones. */
  bindInvocation(executionId: string, facts: BoundInvocation): void;
  /** Wakes every wait still pending, and cancels every held approval. */
  wakeAll(): void;
  /** The approval this host is currently holding, as the wire DTO, or null. */
  currentApproval(): ApprovalSnapshot | null;
  /** Drops everything belonging to one run. Called when its entry is retired. */
  forgetRun(runId: string): void;
  /**
   * Wakes one run's pre-dispatch waits because the host's own projection for it
   * has failed. The execution is not abandoned — a tool that is already running
   * still settles — but nothing new may park on a projection that will never come.
   */
  abandonRun(runId: string): void;
  /** The synchronous business claim for one accepted answer. See the reverse profile. */
  claimAnswer(pending: ReversePendingEntry, result: JsonValue): boolean;
  /** Offers the current approval on one connection, if it is eligible and none is outstanding. */
  offerToConnection(connection: ConnectionState): void;
}

/** One prepared call, as this host holds it privately. */
interface ManagedCallRecord {
  readonly executionId: string;
  readonly hostInstanceId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly callIndex: number;
  readonly callId: string;
  readonly toolName: string;
  readonly entry: ToolRegistration;
  readonly registryGeneration: number;
  readonly policy: CapturedToolPolicy;
  readonly policyRevision: number;
  /** The owned, frozen call this execution will be recorded as. */
  readonly call: ToolCall;
  /** The owned, frozen arguments; every projection is derived from this value. */
  readonly authorityInput: JsonValue;
  phase: "prepared" | "authorized" | "dispatching" | "settled";
  approval: ApprovalRecord | undefined;
  readonly rendezvous: Rendezvous;
}

interface Rendezvous {
  readonly promise: Promise<BoundInvocation | undefined>;
  settle(facts?: BoundInvocation): void;
}

/** The business endings an approval can reach. */
type ApprovalOutcome = "approved" | "rejected" | "expired" | "cancelled";

/** One `tool.approval` delivery: one connection, one request, one record. */
interface ApprovalDelivery {
  readonly connection: ConnectionState;
  readonly approval: ApprovalRecord;
  readonly streamId: string;
  readonly requestId: string;
  readonly handle: ReverseRequestHandle;
  closed: boolean;
}

/** The host's business approval: memory-only, alive exactly as long as its execution waits. */
interface ApprovalRecord {
  readonly approvalId: string;
  readonly executionId: string;
  readonly hostInstanceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly callIndex: number;
  readonly callId: string;
  readonly toolName: string;
  readonly invocationId: string;
  readonly input: JsonValue;
  readonly registryGeneration: number;
  readonly policyRevision: number;
  readonly createdMono: number;
  readonly deadlineMono: number;
  readonly deadlineAt: number;
  businessStatus: "pending" | "approved" | "denied" | "expired" | "cancelled";
  readonly outcome: Promise<ApprovalOutcome>;
  resolveOutcome: ((outcome: ApprovalOutcome) => void) | undefined;
  deadlineTimer: { cancel(): void };
  readonly deliveries: Map<ConnectionState, ApprovalDelivery>;
}

/**
 * The fixed, safe sentence each non-execution is reported with.
 *
 * These are model-visible observations and nothing else: no policy internals,
 * no exception text, no connection error, no stack. The vocabulary is closed
 * on purpose — a new reason is a new sentence written here, never a message
 * that travelled in from somewhere else.
 */
const NOT_EXECUTED_CONTENT: Readonly<Record<NotExecutedReason, string>> = Object.freeze({
  "policy-denied": "tool not executed: the host's policy denied this call",
  "user-rejected": "tool not executed: the user rejected this call",
  "approval-expired": "tool not executed: the approval expired before a decision",
  "cancelled-before-dispatch": "tool not executed: the run was cancelled before the call was dispatched",
  "policy-error": "tool not executed: the tool policy could not decide",
  "execution-invalidated": "tool not executed: the execution is no longer valid",
  "approval-unavailable": "tool not executed: no approval could be obtained for this call",
});

function notExecuted(reason: NotExecutedReason): PreparedDispatchOutcome {
  return {
    executed: false,
    reason,
    result: Object.freeze({ ok: false as const, error: NOT_EXECUTED_CONTENT[reason] }),
  };
}

/** A fresh opaque identity, minted without depending on any other module. */
function mintId(): string {
  return globalThis.crypto.randomUUID();
}

/** What a prospective identity costs, for frame measurements made before one exists. */
const MINTED_ID_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

/** This module's declaration refusal: the class the loop's own group guard raises. */
function declarationRefusal(message: string): ManagedDeclarationError {
  return new ManagedDeclarationError(message);
}

export function createManagedExecution(host: () => HostState, clock: HostClock): ManagedExecution {
  /** The prepared calls this boundary owns, by the token the Core holds. */
  const records = new Map<PreparedToolExecution, ManagedCallRecord>();
  /** The (at most one) business approval currently held. */
  const approvals = new Map<string, ApprovalRecord>();
  /** Stable opaque identities for registrations, for the policy view. */
  const toolIdentities = new WeakMap<object, string>();
  let toolIdentityCounter = 0;

  const state = (): HostState => host();

  function identityOf(entry: ToolRegistration): string {
    const existing = toolIdentities.get(entry.identity);
    if (existing !== undefined) return existing;
    toolIdentityCounter += 1;
    const minted = `tool-registration-${toolIdentityCounter}`;
    toolIdentities.set(entry.identity, minted);
    return minted;
  }

  /** The one run executing a given turn, from the host's own live map. */
  function runOfTurn(turnId: string): RunEntry | undefined {
    for (const run of state().runs.values()) {
      if (run.terminal !== undefined || run.window === undefined) continue;
      if (openTurnOf(run.window.session) === turnId) return run;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Preparation.
  // -------------------------------------------------------------------------

  function prepareBatch(input: {
    readonly calls: readonly ToolCall[];
    readonly position: { readonly turnId: string; readonly stepIndex: number };
  }): readonly PreparedToolExecution[] {
    const hostState = state();
    const run = runOfTurn(input.position.turnId);
    if (run === undefined) {
      throw declarationRefusal("the step does not belong to a run of this host");
    }
    return prepareAll(hostState, run, input.position, input.calls);
  }

  function prepareAll(
    hostState: HostState,
    run: RunEntry,
    position: { readonly turnId: string; readonly stepIndex: number },
    calls: readonly ToolCall[],
  ): readonly PreparedToolExecution[] {
    const prepared: PreparedToolExecution[] = [];
    const seenCallIds = new Set<string>();

    for (let callIndex = 0; callIndex < calls.length; callIndex++) {
      const call = calls[callIndex];
      if (call === undefined) throw declarationRefusal("a declared call is missing");
      // The managed call profile, judged as a group before anything else: every
      // call id present and unique within the step. A repeated id across steps
      // is legal — a step is the scope this profile speaks about.
      if (typeof call.callId !== "string" || call.callId.length === 0) {
        throw declarationRefusal("a managed call has no call id");
      }
      if (seenCallIds.has(call.callId)) {
        throw declarationRefusal(`two calls in one step share the call id "${call.callId}"`);
      }
      seenCallIds.add(call.callId);

      // Arguments: this host's strict JSON ownership of the value the tool will
      // be run with. The guard both checks and copies, so what follows holds a
      // value the model client cannot reach.
      const validated = validateJsonValue(call.input);
      if (
        !validated.success ||
        typeof validated.output !== "object" ||
        validated.output === null ||
        Array.isArray(validated.output)
      ) {
        throw declarationRefusal(`the call "${call.name}" does not carry a JSON object`);
      }
      const authorityInput = deepFreezeJson(validated.output);

      // The binding, resolved now and held: the registry's own record of this
      // registration, its identity, and the executor captured when it was
      // registered. Nothing after this point looks the tool up again.
      const entry = hostState.registry.registration(call.name);
      if (entry === undefined) {
        throw declarationRefusal(`the tool "${call.name}" does not exist`);
      }

      const preparedCall: PreparedToolExecution = Object.freeze({
        executionId: mintId(),
        call: Object.freeze({ callId: call.callId, name: call.name, input: authorityInput }),
        position: Object.freeze({ turnId: position.turnId, stepIndex: position.stepIndex, callIndex }),
        registryGeneration: hostState.registry.generation,
      });

      // The prospective approval representation, before any approval exists: if
      // this call's arguments could never travel inside an approval snapshot
      // together with the run that would carry it, the group is refused here —
      // not discovered once a client is already waiting for an answer.
      const fits = prospectiveApprovalFits(hostState, run, preparedCall, authorityInput);
      if (!fits) {
        throw declarationRefusal(`the call "${call.name}" could not be represented as an approval`);
      }

      // A run whose projection has already failed can never bind a live
      // occurrence for this call: the rendezvous is born resolved, so a call
      // that needs no approval still runs (the execution is not abandoned) and
      // one that needs an approval still fails closed — instead of both of them
      // parking on a consumer that will not come back.
      const record: ManagedCallRecord = {
        executionId: preparedCall.executionId,
        hostInstanceId: hostState.hostInstanceId,
        runId: run.runId,
        sessionId: run.sessionId,
        turnId: position.turnId,
        stepIndex: position.stepIndex,
        callIndex,
        callId: call.callId,
        toolName: call.name,
        entry,
        registryGeneration: preparedCall.registryGeneration,
        policy: hostState.policy,
        policyRevision: hostState.policy.revision,
        call: preparedCall.call,
        authorityInput,
        phase: "prepared",
        approval: undefined,
        rendezvous: run.faulted ? settledRendezvous() : createRendezvous(clock),
      };
      records.set(preparedCall, record);
      prepared.push(preparedCall);
    }

    return Object.freeze(prepared);
  }

  /**
   * Whether this call's approval could be published inside one frame.
   *
   * The measurement is the real one: the host's own cut composition (the
   * executing run and its session) plus the prospective approval, encoded by
   * the protocol's own encoder with the worst legal request id — the same
   * reservation the startup and admission checks use.
   */
  function prospectiveApprovalFits(
    hostState: HostState,
    run: RunEntry,
    preparedCall: PreparedToolExecution,
    authorityInput: JsonValue,
  ): boolean {
    try {
      const sessionRecord = hostState.repository.getSession(run.sessionId);
      if (sessionRecord === undefined) return false;
      const approval: ApprovalSnapshot = {
        approvalId: MINTED_ID_PLACEHOLDER,
        executionId: preparedCall.executionId,
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: preparedCall.position.turnId,
        invocationId: MINTED_ID_PLACEHOLDER,
        callId: preparedCall.call.callId,
        name: preparedCall.call.name,
        input: projectDisplayInput(authorityInput),
        deadlineAt: clock.wallNow() + APPROVAL_DEADLINE_MS,
        status: "pending",
        canRespond: true,
      };
      // What is checked here is whether the frame could ever travel — not
      // whether this call fits the approval profile. The profile's own bounds
      // (input size, snapshot size) apply to calls that really require an
      // approval, and they are applied where that is known: at the decision.
      // A call that would be allowed outright may legitimately carry more
      // arguments than an approval could show.
      const core = snapshotCoreOf(
        hostState,
        "prepare:stream",
        sessionSummaryOf(sessionRecord),
        liveRunSummaryOf(run),
      );
      return encodeFrame(
        { kind: "host-response", method: "subscriptions.open" },
        {
          kind: "host-response",
          protocolVersion: PROTOCOL_VERSION,
          hostInstanceId: hostState.hostInstanceId,
          requestId: PREPARED_REQUEST_ID,
          result: { snapshot: Object.freeze({ ...core, approval }) },
        },
      ).success;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Execution.
  // -------------------------------------------------------------------------

  async function executePrepared(
    prepared: PreparedToolExecution,
    context: RuntimeContext,
  ): Promise<PreparedDispatchOutcome> {
    const hostState = state();
    const record = records.get(prepared);
    // The token is matched by identity: a prepared execution this boundary did
    // not make — or one that already settled — is not something it may run.
    if (record === undefined || record.phase === "settled") return notExecuted("execution-invalidated");
    if (record.hostInstanceId !== hostState.hostInstanceId) return notExecuted("execution-invalidated");

    // The rendezvous: this host's own projection binds the live occurrence
    // before anything is decided about it, so an approval can never be
    // published ahead of the call it belongs to. It is bounded, and it is woken
    // by cancellation, shutdown, a storage fault and a projection failure — a
    // *wait*, not a gate this host could be argued out of by its own state.
    const bound = await raceRendezvous(record.rendezvous.promise, context.signal);

    // Everything the policy callback is about to be given, checked while it is
    // still true, and checked again after the callback returns.
    const beforehand = dispatchBlocked(hostState, record, context.signal);
    if (beforehand !== undefined) return notExecuted(beforehand);

    const decision = decide(hostState, record);
    if (!decision.ok) {
      settleExecution(hostState, record);
      return notExecuted("policy-error");
    }

    // A policy that re-entered this host — the callback is trusted, but the
    // host it ran inside may have changed under it — has its decision used only
    // if the execution is still the same living execution.
    const afterwards = dispatchBlocked(hostState, record, context.signal);
    if (afterwards !== undefined) {
      settleExecution(hostState, record);
      return notExecuted(afterwards);
    }

    if (decision.decision === "deny") {
      settleExecution(hostState, record);
      return notExecuted("policy-denied");
    }

    let approvalDeadline: number | undefined;
    if (decision.decision === "require-approval") {
      // An approval is the one thing that cannot exist without the occurrence:
      // if the projection never bound this call, there is no card to ask
      // about, and a call nobody can be asked about does not run.
      if (bound === undefined) {
        settleExecution(hostState, record);
        return notExecuted("execution-invalidated");
      }
      const approval = createApproval(hostState, record, bound);
      if (approval === undefined) {
        settleExecution(hostState, record);
        return notExecuted("approval-unavailable");
      }
      record.approval = approval;
      const outcome = await waitForApproval(hostState, approval, context.signal);
      if (outcome !== "approved") {
        record.phase = "settled";
        clearApproval(hostState, approval);
        return notExecuted(
          outcome === "rejected"
            ? "user-rejected"
            : outcome === "expired"
              ? "approval-expired"
              : "cancelled-before-dispatch",
        );
      }
      approvalDeadline = approval.deadlineMono;
    }

    record.phase = "authorized";

    // The guard, and the critical section it protects. Everything that could
    // await, look up, consult, copy or publish has already happened; from the
    // check to the invocation there is exactly one synchronous step.
    const blocked = finalGuard(hostState, record, context.signal, approvalDeadline);
    if (blocked !== undefined) {
      settleExecution(hostState, record);
      return notExecuted(blocked);
    }

    // The tool's own copy of the arguments: a tool may do what it likes with
    // what it is handed, and none of it may reach the approval, the recorded
    // call, or the prepared authority.
    const executionInput = executionCopyOf(record.authorityInput);
    const invokeBound = (): Promise<unknown> => record.entry.invoke(executionInput, context);

    record.phase = "dispatching";
    let returned: unknown;
    let threw = false;
    let thrown: unknown;
    try {
      returned = invokeBound();
    } catch (error) {
      threw = true;
      thrown = error;
    }

    try {
      if (threw) {
        // A synchronous throw is still a dispatch: the executor was entered,
        // and no phrasing of this fact may claim it was not.
        if (thrown instanceof TurnResourceFault) throw thrown;
        return Object.freeze({
          executed: true as const,
          result: Object.freeze({ ok: false as const, error: errorMessageOf(thrown) }),
        });
      }
      const value = await returned;
      return Object.freeze({ executed: true as const, result: Object.freeze({ ok: true as const, value }) });
    } catch (error) {
      if (error instanceof TurnResourceFault) throw error;
      return Object.freeze({
        executed: true as const,
        result: Object.freeze({ ok: false as const, error: errorMessageOf(error) }),
      });
    } finally {
      settleExecution(hostState, record);
    }
  }

  /**
   * The checks that must hold before the policy is consulted and after it
   * returns: the host is still the same living host, and the run this
   * execution belongs to is still the one it was prepared for.
   */
  function dispatchBlocked(
    hostState: HostState,
    record: ManagedCallRecord,
    signal: AbortSignal,
  ): NotExecutedReason | undefined {
    if (hostState.closing) return "cancelled-before-dispatch";
    if (signal.aborted) return "cancelled-before-dispatch";
    if (hostState.storageFault) return "execution-invalidated";
    const run = hostState.runs.get(record.runId);
    if (run === undefined || run.terminal !== undefined) return "cancelled-before-dispatch";
    return undefined;
  }

  /** The policy decision for one call, or the fact that it could not be made. */
  function decide(
    hostState: HostState,
    record: ManagedCallRecord,
  ): { readonly ok: true; readonly decision: "allow" | "deny" | "require-approval" } | { readonly ok: false } {
    const policy = hostState.policy;
    if (policy !== record.policy || policy.revision !== record.policyRevision) return { ok: false };
    // An unclassified tool is denied without asking: a catalogue that does not
    // name this registration has not vouched for it, whatever the callback
    // would have said.
    if (policy.catalogue !== undefined && !policy.catalogue.has(record.entry.tool)) {
      return { ok: true, decision: "deny" };
    }

    const view: ToolPolicyView = Object.freeze({
      toolIdentity: identityOf(record.entry),
      toolName: record.toolName,
      input: record.authorityInput,
      executionId: record.executionId,
      sessionId: record.sessionId,
      runId: record.runId,
      turnId: record.turnId,
      stepIndex: record.stepIndex,
      callIndex: record.callIndex,
    });
    return consultPolicy(policy.decide, view);
  }

  // -------------------------------------------------------------------------
  // The final dispatch guard.
  // -------------------------------------------------------------------------

  /**
   * Everything that still has to be true at the instant of dispatch.
   *
   * Every failure is a non-execution: the call did not run, and the reason
   * says which fact had stopped being true. Nothing here awaits or calls out —
   * the whole point is that it runs immediately before the invocation.
   */
  function finalGuard(
    hostState: HostState,
    record: ManagedCallRecord,
    signal: AbortSignal,
    approvalDeadline: number | undefined,
  ): NotExecutedReason | undefined {
    if (record.hostInstanceId !== hostState.hostInstanceId) return "execution-invalidated";
    if (hostState.closing) return "cancelled-before-dispatch";
    if (hostState.storageFault) return "execution-invalidated";
    if (signal.aborted) return "cancelled-before-dispatch";

    const run = hostState.runs.get(record.runId);
    // A projection fault is deliberately *not* a dispatch blocker: the run's
    // presenter failed, not its execution, and M2's rule — a tool that has been
    // asked for still runs and settles — is what keeps a broken timeline from
    // changing what a tool did. What a fault does stop is *waiting*: no new
    // wait may park on a projection that will not come (see `abandonRun`).
    if (run === undefined || run.terminal !== undefined) return "cancelled-before-dispatch";
    if (run.cancelRequested) return "cancelled-before-dispatch";
    if (run.lease.kind !== "execution") return "execution-invalidated";

    // The approval window is a fact about the decision, and it is re-checked at
    // the last moment: a continuation that was delayed past the deadline
    // dispatches nothing.
    if (approvalDeadline !== undefined && clock.now() >= approvalDeadline) return "approval-expired";
    if (record.approval !== undefined && record.approval.businessStatus !== "approved") {
      return approvalReason(record.approval.businessStatus);
    }

    if (record.phase !== "authorized") return "execution-invalidated";

    // The registry binding: the generation the call was prepared at, and the
    // exact registration it resolved to. A delete-and-re-register under the
    // same name changed both, and a call prepared against the old mapping is
    // not a call this mapping may run.
    if (hostState.registry.generation !== record.registryGeneration) return "execution-invalidated";
    const current = hostState.registry.registration(record.entry.key);
    if (current === undefined || current.identity !== record.entry.identity) return "execution-invalidated";

    if (hostState.policy !== record.policy || hostState.policy.revision !== record.policyRevision) {
      return "execution-invalidated";
    }
    return undefined;
  }

  function approvalReason(status: ApprovalRecord["businessStatus"]): NotExecutedReason {
    switch (status) {
      case "denied":
        return "user-rejected";
      case "expired":
        return "approval-expired";
      case "cancelled":
        return "cancelled-before-dispatch";
      default:
        return "execution-invalidated";
    }
  }

  /** The call is over: the approval it held stops being current, and the record closes. */
  function settleExecution(hostState: HostState, record: ManagedCallRecord): void {
    if (record.phase === "settled") return;
    record.phase = "settled";
    if (record.approval !== undefined) clearApproval(hostState, record.approval);
  }

  // -------------------------------------------------------------------------
  // Approvals.
  // -------------------------------------------------------------------------

  function createApproval(
    hostState: HostState,
    record: ManagedCallRecord,
    bound: BoundInvocation,
  ): ApprovalRecord | undefined {
    if (approvals.size >= APPROVAL_MAX_PENDING) return undefined;

    // The exact input, or nothing: an approval whose arguments could not be
    // shown whole is an approval a client cannot honestly answer. Both bounds
    // are this profile's, and both fail the call closed instead of truncating
    // the approval.
    if (neutralBytes(record.authorityInput) > APPROVAL_INPUT_MAX_BYTES) return undefined;
    const display = projectDisplayInput(record.authorityInput);
    if (display.kind !== "json") return undefined;

    const createdMono = clock.now();
    const deadlineMono = createdMono + APPROVAL_DEADLINE_MS;
    const deadlineAt = clock.wallNow() + APPROVAL_DEADLINE_MS;

    let resolveOutcome!: (outcome: ApprovalOutcome) => void;
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    const approval: ApprovalRecord = {
      approvalId: mintId(),
      executionId: record.executionId,
      hostInstanceId: hostState.hostInstanceId,
      sessionId: record.sessionId,
      runId: record.runId,
      turnId: record.turnId,
      stepIndex: record.stepIndex,
      callIndex: record.callIndex,
      callId: record.callId,
      toolName: record.toolName,
      invocationId: bound.invocationId,
      input: record.authorityInput,
      registryGeneration: record.registryGeneration,
      policyRevision: record.policyRevision,
      createdMono,
      deadlineMono,
      deadlineAt,
      businessStatus: "pending",
      outcome,
      resolveOutcome,
      deadlineTimer: { cancel: (): void => undefined },
      deliveries: new Map(),
    };

    // The timer is armed before anything is published, so a deadline that has
    // already passed ends the approval through the same path as any other.
    approval.deadlineTimer = clock.setTimer(() => {
      expireApproval(hostState, approval);
    }, APPROVAL_DEADLINE_MS);

    if (neutralBytes(snapshotOfApproval(approval)) > APPROVAL_SNAPSHOT_MAX_BYTES) {
      approval.deadlineTimer.cancel();
      return undefined;
    }

    approvals.set(approval.approvalId, approval);

    // Business first, delivery second, on the same stream and in that order: a
    // client is told about an approval before it is asked to answer one.
    publishApproval(hostState, approval);
    for (const connection of [...hostState.connections]) {
      offerApprovalTo(hostState, approval, connection);
    }
    return approval;
  }

  /** The current approval, as the wire DTO; `null` when there is none. */
  function currentApproval(): ApprovalSnapshot | null {
    const hostState = state();
    for (const approval of approvals.values()) {
      // A deadline that has passed is not a detail the next reader may miss,
      // whatever the timer is doing: the read itself enforces it.
      if (approval.businessStatus === "pending" && clock.now() >= approval.deadlineMono) {
        expireApproval(hostState, approval);
        return null;
      }
      return snapshotOfApproval(approval);
    }
    return null;
  }

  function snapshotOfApproval(approval: ApprovalRecord): ApprovalSnapshot {
    const status = approval.businessStatus;
    const expiring = clock.now() >= approval.deadlineMono;
    return Object.freeze({
      approvalId: approval.approvalId,
      executionId: approval.executionId,
      sessionId: approval.sessionId,
      runId: approval.runId,
      turnId: approval.turnId,
      invocationId: approval.invocationId,
      callId: approval.callId,
      name: approval.toolName,
      input: projectDisplayInput(approval.input),
      deadlineAt: approval.deadlineAt,
      // A pending approval whose window has closed reads as expired: the Host's
      // monotonic clock decides, not the timer that may still be queued.
      status: status === "pending" && expiring ? "expired" : status,
      canRespond: status === "pending" && !expiring,
    });
  }

  /** Publishes the current approval state — never a value the record does not hold. */
  function publishApproval(hostState: HostState, approval: ApprovalRecord | undefined): void {
    try {
      publishEvent(hostState, approvalUpdatedEvent(approval === undefined ? null : snapshotOfApproval(approval)));
    } catch {
      // Delivery is not state: an announcement that cannot be built changes no
      // business fact, and the next cut still carries the truth.
    }
  }

  /**
   * Offers one approval on one connection, if that connection is eligible.
   *
   * Eligibility is this host's own: an initialized connection that declared
   * the reverse capability and holds an active subscription. Whether the
   * client *has* a handler is not knowable here — an old client answers
   * METHOD_NOT_FOUND and a new one without a handler answers
   * CAPABILITY_NOT_SUPPORTED, and both only end that one delivery.
   */
  function offerApprovalTo(hostState: HostState, approval: ApprovalRecord, connection: ConnectionState): void {
    if (approval.businessStatus !== "pending") return;
    if (connection.closed) return;
    if (connection.initialized?.capabilities.reverseRequests !== true) return;
    const subscription = connection.subscription;
    if (subscription === undefined) return;

    // One delivery per connection per approval *stream*: an entry left over
    // from a replaced stream is stale the moment the new stream exists, and the
    // client that just re-subscribed is exactly the one that must be asked again.
    const existing = approval.deliveries.get(connection);
    if (existing !== undefined && !existing.closed && existing.streamId === subscription.streamId) return;
    if (existing === undefined && approval.deliveries.size >= APPROVAL_MAX_DELIVERIES) return;

    // The delivery window is the rest of the business window, never a smaller
    // one: a client that is still connected and able must be able to answer
    // until the Host's own deadline says otherwise. The wall-clock value is
    // rounded *up* to a whole millisecond — the protocol's timeout is an
    // integer, and truncating it would shorten the window it exists to protect.
    const remaining = approval.deadlineMono - clock.now();
    if (remaining <= 0) return;
    const deliveryTimeout = Math.max(1, Math.ceil(remaining));

    const trigger = createReverseTrigger(hostState, connection);
    // The delivery is created first so it can travel *as* the request's context:
    // the frame path's claim is handed the pending, and the pending already
    // carries the record this answer is about.
    const delivery: ApprovalDelivery = {
      connection,
      approval,
      streamId: subscription.streamId,
      requestId: "",
      handle: { outcome: Promise.resolve({ ok: false, reason: "unavailable" }), cancel: (): void => undefined },
      closed: false,
    };
    const handle = trigger.request(
      "tool.approval",
      snapshotOfApproval(approval) as unknown as JsonValue,
      deliveryTimeout,
      delivery,
    );
    if (handle.requestId === undefined) return;
    (delivery as { requestId: string }).requestId = handle.requestId;
    (delivery as { handle: ReverseRequestHandle }).handle = handle;
    approval.deliveries.set(connection, delivery);

    void handle.outcome.then((outcome) => {
      if (approval.deliveries.get(connection) !== delivery) return;
      approval.deliveries.delete(connection);
      delivery.closed = true;
      // A delivery that ended without a decision — a disconnect, a timeout, a
      // refusal, a replaced stream — changes nothing about the business record.
      // It stays pending until a decision, a deadline or a cancellation ends it.
      void outcome;
    });
  }

  /**
   * The synchronous business claim for one accepted `tool.approval` answer.
   *
   * This runs inside the host's frame path, before the answer settles anything:
   * the winner of two near-simultaneous decisions is decided by the order the
   * frames were received, not by the order two promises happened to resolve.
   */
  function claimAnswer(pending: ReversePendingEntry, result: JsonValue): boolean {
    const hostState = state();
    const delivery = pending.context as ApprovalDelivery | undefined;
    if (delivery === undefined || !(delivery.approval instanceof Object) || delivery.closed) {
      // The request was not this host's tool approval, or its delivery already
      // ended. There is nothing to claim and nothing to punish.
      return true;
    }

    // The answer's shape was checked by the profile before this ran; the
    // identities are checked here, against the record this delivery belongs to.
    const answer = result as unknown as ToolApprovalResponse;
    const approval = delivery.approval;
    if (answer.approvalId !== approval.approvalId || answer.executionId !== approval.executionId) {
      // A decision that names a different approval or execution than the one
      // this request carried is not an answer to it: a peer that cannot keep
      // its identities has lost the right to be waited for.
      return false;
    }

    if (approval.businessStatus === "pending" && clock.now() >= approval.deadlineMono) {
      // The window closed before this frame arrived: the timer may not have run
      // yet, and the deadline — not the timer — is the authority.
      expireApproval(hostState, approval);
      return true;
    }
    if (approval.businessStatus !== "pending") {
      // A late or losing answer. The business state is already decided and no
      // second decision exists; this frame is read and changes nothing.
      return true;
    }

    // The first valid decision wins, here, synchronously.
    approval.businessStatus = answer.decision === "approve" ? "approved" : "denied";
    approval.deadlineTimer.cancel();

    publishApproval(hostState, approval);
    cancelDeliveriesExcept(hostState, approval, delivery.connection);
    approval.resolveOutcome?.(approval.businessStatus === "approved" ? "approved" : "rejected");
    approval.resolveOutcome = undefined;
    return true;
  }

  /** Ends every delivery of one approval except the winner's. */
  function cancelDeliveriesExcept(
    hostState: HostState,
    approval: ApprovalRecord,
    winner: ConnectionState | undefined,
  ): void {
    void hostState;
    for (const [connection, delivery] of [...approval.deliveries]) {
      if (connection === winner) continue;
      approval.deliveries.delete(connection);
      delivery.closed = true;
      try {
        delivery.handle.cancel();
      } catch {
        // Ending a wait is best effort; the business state is already decided.
      }
    }
  }

  /** The business window closed with no decision: nothing runs. */
  function expireApproval(hostState: HostState, approval: ApprovalRecord): void {
    if (approval.businessStatus !== "pending") return;
    if (clock.now() < approval.deadlineMono) return;
    approval.businessStatus = "expired";
    approval.deadlineTimer.cancel();
    publishApproval(hostState, approval);
    cancelDeliveriesExcept(hostState, approval, undefined);
    approval.resolveOutcome?.("expired");
    approval.resolveOutcome = undefined;
  }

  /** Cancels a still-pending approval because the host can no longer hold it. */
  function cancelApproval(hostState: HostState, approval: ApprovalRecord): boolean {
    if (approval.businessStatus !== "pending") return false;
    approval.businessStatus = "cancelled";
    approval.deadlineTimer.cancel();
    publishApproval(hostState, approval);
    cancelDeliveriesExcept(hostState, approval, undefined);
    approval.resolveOutcome?.("cancelled");
    approval.resolveOutcome = undefined;
    return true;
  }

  /** The execution is over: the approval stops being the host's current one. */
  function clearApproval(hostState: HostState, approval: ApprovalRecord): void {
    cancelApproval(hostState, approval);
    approvals.delete(approval.approvalId);
    approval.deadlineTimer.cancel();
    cancelDeliveriesExcept(hostState, approval, undefined);
    publishApproval(hostState, undefined);
  }

  /** The execution's wait for a decision, woken by a decision, a deadline or cancellation. */
  function waitForApproval(
    hostState: HostState,
    approval: ApprovalRecord,
    signal: AbortSignal,
  ): Promise<ApprovalOutcome> {
    if (signal.aborted) {
      cancelApproval(hostState, approval);
      return approval.outcome;
    }
    const onAbort = (): void => {
      cancelApproval(hostState, approval);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void approval.outcome.finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
    return approval.outcome;
  }

  // -------------------------------------------------------------------------
  // The rendezvous with this host's own projection.
  // -------------------------------------------------------------------------

  function createRendezvous(hostClock: HostClock): Rendezvous {
    let settle!: (facts?: BoundInvocation) => void;
    let timer: { cancel(): void } | undefined;
    const promise = new Promise<BoundInvocation | undefined>((resolve) => {
      let done = false;
      settle = (facts?: BoundInvocation): void => {
        if (done) return;
        done = true;
        timer?.cancel();
        resolve(facts);
      };
      // The projection never bound this execution. The host fails closed: the
      // call does not run, and the run is told so as a safe observation.
      timer = hostClock.setTimer(() => {
        settle(undefined);
      }, PROJECTION_RENDEZVOUS_MS);
    });
    return { promise, settle };
  }

  /** The rendezvous for a call whose run can no longer be projected. */
  function settledRendezvous(): Rendezvous {
    const promise = Promise.resolve(undefined as BoundInvocation | undefined);
    return {
      promise,
      settle: (): void => {
        // Already settled: the projection that would have bound this call is gone.
      },
    };
  }

  function raceRendezvous(
    rendezvous: Promise<BoundInvocation | undefined>,
    signal: AbortSignal,
  ): Promise<BoundInvocation | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise<BoundInvocation | undefined>((resolve) => {
      let done = false;
      const finish = (facts: BoundInvocation | undefined): void => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        resolve(facts);
      };
      const onAbort = (): void => {
        finish(undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void rendezvous.then(finish);
    });
  }

  function bindInvocation(executionId: string, facts: BoundInvocation): void {
    for (const record of records.values()) {
      if (record.executionId !== executionId) continue;
      record.rendezvous.settle(facts);
      return;
    }
  }

  function wakeAll(): void {
    const hostState = state();
    for (const record of records.values()) {
      if (record.phase === "prepared") record.rendezvous.settle(undefined);
    }
    for (const approval of [...approvals.values()]) {
      cancelApproval(hostState, approval);
    }
  }

  function abandonRun(runId: string): void {
    const hostState = state();
    for (const record of records.values()) {
      if (record.runId !== runId) continue;
      if (record.phase === "prepared") record.rendezvous.settle(undefined);
    }
    for (const approval of [...approvals.values()]) {
      if (approval.runId !== runId) continue;
      cancelApproval(hostState, approval);
    }
  }

  function forgetRun(runId: string): void {
    const hostState = state();
    for (const [prepared, record] of [...records]) {
      if (record.runId !== runId) continue;
      record.rendezvous.settle(undefined);
      if (record.phase !== "settled") record.phase = "settled";
      records.delete(prepared);
    }
    for (const approval of [...approvals.values()]) {
      if (approval.runId !== runId) continue;
      clearApproval(hostState, approval);
    }
  }

  return {
    boundary: {
      prepareBatch,
      executePrepared,
    },
    bindInvocation,
    wakeAll,
    currentApproval,
    forgetRun,
    abandonRun,
    claimAnswer,
    offerToConnection: (connection: ConnectionState): void => {
      const hostState = state();
      for (const approval of approvals.values()) {
        offerApprovalTo(hostState, approval, connection);
      }
    },
  };
}

/**
 * The one production reverse profile: `tool.approval`.
 *
 * It exists as a factory because the claim is a fact about *this* host's
 * execution boundary; everything else about it is the frozen profile — the
 * strict params and answer contracts the protocol defines, and the synchronous
 * claim the frame path runs before anything settles.
 */
export function createToolApprovalProfile(execution: ManagedExecution): ReverseProfile {
  return Object.freeze({
    method: "tool.approval" as const,
    acceptsParams: (params: JsonValue): boolean => validateReverseParams("tool.approval", params).success,
    acceptsResult: (result: JsonValue): boolean => validateReverseResult("tool.approval", result).success,
    claim: (pending: ReversePendingEntry, result: JsonValue): boolean => execution.claimAnswer(pending, result),
  });
}

/**
 * This host's own deep copy of a prepared argument value, frozen all the way
 * down.
 *
 * The guard has already isolated the value from the model client; this makes
 * it *this host's* — a second, frozen copy that nothing may write through. It
 * is the value every later projection reads: the step's declaration, the
 * recorded call, the policy view, the approval snapshot.
 */
function deepFreezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) {
    deepFreezeJson((value as { readonly [key: string]: JsonValue })[key] as JsonValue);
  }
  return Object.freeze(value);
}

/**
 * The independent copy a tool is actually handed.
 *
 * A tool is foreign code with a legal right to do anything with its arguments
 * — including rewriting them — so it never receives the authority value, the
 * recorded call, or the policy/approval view. It receives this: a fresh, plain,
 * mutable copy of the same JSON, which is why what the host recorded cannot
 * change because of what a tool did.
 */
function executionCopyOf(value: JsonValue): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => executionCopyOf(item));
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    // Defined, never assigned: a legal own `__proto__` key stays a data
    // property instead of becoming the copy's prototype.
    Object.defineProperty(copy, key, {
      value: executionCopyOf((value as { readonly [key: string]: JsonValue })[key] as JsonValue),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}
