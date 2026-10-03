import type { ContextBuilder, FixedContext } from "../context/context-builder.js";
import { assertModelRequestFits, ownFixedContext, ownModelRequest } from "../context/context-guard.js";
import { defineModelBudget, validateModelLimits, type ModelBudget, type ModelLimits } from "../context/model-budget.js";
import { NonRetryableModelError, TurnResourceFault, errorMessageOf } from "../errors.js";
import type { ToolCall } from "../model/message.js";
import type { ModelClient, ModelRequest } from "../model/model-client.js";
import type { RuntimeContext } from "../runtime/runtime-context.js";
import type { Session } from "../session/session.js";
import type { SessionEventInput, TurnEndReason } from "../session/session-event.js";
import type { ToolExecutionResult } from "../tools/tool.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import {
  assertToolInput,
  LOOP_RESOURCE_LIMITS,
  TurnResourceMeter,
  validateLoopResourceLimits,
  type LoopResourceLimits,
} from "./turn-resources.js";

/**
 * How many model calls one turn may spend.
 *
 * A step is one model call together with the tool dispatch it asks for, so the
 * budget is checked before a call, never after its tools have run: a turn either
 * completes inside the budget or stops wanting another step.
 */
export const MAX_STEPS = LOOP_RESOURCE_LIMITS.maxSteps;

/**
 * Attempts per model step, counting the first one — two retries, then the turn
 * fails. Retries stay inside their step and spend no step budget.
 */
export const MAX_MODEL_ATTEMPTS = LOOP_RESOURCE_LIMITS.maxModelAttempts;

export interface AgentLoopDeps {
  readonly modelClient: ModelClient;
  readonly tools: ToolRegistry;
  readonly contextBuilder: ContextBuilder;
  /**
   * A smaller resource profile, for a composition or a test that wants the same
   * rules with tighter numbers. Left out, the shared approved profile applies;
   * either way there is one object, never two copies of the same number.
   */
  readonly limits?: LoopResourceLimits;
}

/**
 * What the loop reports while a turn runs, before the Runtime stamps the turn
 * envelope. `turnId` is deliberately absent: the Runtime is its only producer.
 */
export type AgentLoopEvent =
  | { readonly type: "assistant/chunk"; readonly text: string }
  | {
      readonly type: "tool/call";
      readonly callId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool/result";
      readonly callId: string;
      readonly name: string;
      readonly ok: boolean;
      readonly content: string;
    };

export interface AgentLoopInput {
  readonly session: Session;
  readonly turnId: string;
  readonly context: RuntimeContext;
  /**
   * Receives content events as they happen. Optional: a turn nobody watches still
   * runs and still closes its log.
   */
  readonly emit?: (event: AgentLoopEvent) => void;
}

/** What the admission preflight knows: one input, and the profile it would run under. */
export interface AgentPreflightInput {
  readonly text: string;
  readonly context: RuntimeContext;
}

/**
 * How a turn ended, in the same vocabulary the Runtime writes as `turn/end`.
 *
 * `text` is the final answer of a `completed` turn and the last completed step's
 * text when the budget ran out. A `cancelled` or `error` turn carries no text: the
 * step it died in never completed, and a half-answered step is not recorded.
 */
export interface TurnOutcome {
  readonly reason: TurnEndReason;
  readonly text: string;
  readonly error?: string;
}

/**
 * The ReAct orchestrator: it consumes the other Core modules and reimplements
 * none of them.
 *
 * It owns everything inside a turn — one `message/assistant` per completed model
 * step, the `tool/call` dispatch record and the `tool/result` observation — and
 * it owns the turn's *resources*: what the turn has spent, what each step was
 * allowed to stage, and which facts may still be written. The turn boundary
 * itself (`turn/start`, `message/user`, `turn/end`) belongs to the AgentRuntime,
 * which is also the only producer of `turnId`.
 */
export interface AgentLoop {
  /**
   * Runs one turn up to its budget and reports how it ended.
   *
   * The turn must already be framed (`turn/start`) with its input recorded. The
   * loop never reads the log itself to decide what to say: every step re-derives
   * the request through the ContextBuilder, so the session log stays the single
   * source of truth.
   */
  runTurn(input: AgentLoopInput): Promise<TurnOutcome>;
  /**
   * Whether a turn with this input could be sent at all.
   *
   * Synchronous, and it reads nothing but the live registry and the composed
   * builder: no session is loaded, no history is selected, no provider is
   * reached. It exists so a host can refuse an input that could never run
   * *before* it records anything durable about it — the smallest legal request
   * is the one thing such a decision can honestly be based on, because history
   * may legitimately be empty.
   */
  preflight(input: AgentPreflightInput): void;
}

/** The Core's own fixed view of one step: validated limits, budget, and context. */
interface ComposedStep {
  readonly limits: ModelLimits;
  readonly budget: ModelBudget;
}

export function createAgentLoop(deps: AgentLoopDeps): AgentLoop {
  // Validated once, at the composition that will really run: an adapter that
  // cannot state a usable capability, or a profile that leaves no room for
  // input, is refused here rather than discovered per request.
  const limits = validateLoopResourceLimits(deps.limits ?? LOOP_RESOURCE_LIMITS);
  const modelLimits = validateModelLimits(deps.modelClient.limits);
  const budget = defineModelBudget(modelLimits);
  const composed: ComposedStep = { limits: modelLimits, budget };

  return {
    runTurn: (input: AgentLoopInput): Promise<TurnOutcome> => runTurn(deps, limits, composed, input),
    preflight: (input: AgentPreflightInput): void => preflight(deps, composed, input),
  };
}

/**
 * The smallest legal request this profile could ever send, held to the budget.
 *
 * It is deliberately not a prediction of what the real request will cost: it is
 * the *floor*, and the one thing that can be proven before anything durable
 * exists. A turn of history can always be absent, so if the floor does not fit,
 * no run under this profile can.
 */
function preflight(deps: AgentLoopDeps, composed: ComposedStep, { text, context }: AgentPreflightInput): void {
  const fixed = ownFixedContext(deps.contextBuilder.getFixedContext({ tools: deps.tools, context }));
  const candidate: ModelRequest = {
    ...(fixed.systemPrompt === undefined ? {} : { systemPrompt: fixed.systemPrompt }),
    messages: [{ role: "user", text }],
    tools: fixed.tools,
    maxOutputTokens: composed.budget.reservedOutput,
  };
  assertModelRequestFits(ownModelRequest(candidate, composed.budget.reservedOutput), {
    limits: composed.limits,
    fixed,
  });
}

/**
 * The turn's guard rail. Whatever happens inside, the caller gets an outcome
 * instead of an exception, so the Runtime can always close the turn it opened: no
 * turn is left open in the log, whatever the model or a tool does.
 *
 * The one exception is deliberate. A `TurnResourceFault` says a tool has already
 * run and its result can no longer be part of an honest turn, and turning that
 * into a `turn/end` would record a conversation the host could not keep. It
 * travels out unchanged, and the host records the run as the failure it is.
 */
async function runTurn(
  deps: AgentLoopDeps,
  limits: LoopResourceLimits,
  composed: ComposedStep,
  input: AgentLoopInput,
): Promise<TurnOutcome> {
  try {
    return await runSteps(deps, limits, composed, input);
  } catch (error) {
    if (error instanceof TurnResourceFault) throw error;
    // Anything else that escaped the step itself came from the Core (context
    // building, the log, the loop's own code) rather than from the model, and is
    // reported the same way: as a turn that ends.
    if (input.context.signal.aborted) return { reason: "cancelled", text: "" };
    return { reason: "error", text: "", error: errorMessageOf(error) };
  }
}

async function runSteps(
  deps: AgentLoopDeps,
  limits: LoopResourceLimits,
  composed: ComposedStep,
  { session, turnId, context, emit }: AgentLoopInput,
): Promise<TurnOutcome> {
  const meter = new TurnResourceMeter(limits);
  chargeWhatTheRuntimeAlreadyWrote(meter, session, turnId);
  let lastText = "";

  for (let step = 0; ; step++) {
    // The turn's first two checkpoints. An aborted turn stops before a request is
    // built, and here again — after a tool block — before the next step starts.
    if (context.signal.aborted) return closeTurn(meter, turnId, { reason: "cancelled", text: "" });

    // The budget is spent and the model still wanted another step. The previous
    // step's tools have already been dispatched and recorded, so the log stays a
    // complete history; only the choice to continue is taken away.
    if (step === limits.maxSteps) return closeTurn(meter, turnId, { reason: "max_steps", text: lastText });

    // The fixed context is read from the live registry on every step, never
    // snapshotted for the turn: a tool that appears between two steps is a tool
    // the next request must be budgeted for.
    const fixed: FixedContext = ownFixedContext(
      deps.contextBuilder.getFixedContext({ tools: deps.tools, context }),
    );
    const candidate = await deps.contextBuilder.build({
      session,
      tools: deps.tools,
      context,
      turnId,
      limits: composed.limits,
      budget: composed.budget,
      fixed,
    });
    // The Core's own copy, with the Core's own output cap: a builder proposes,
    // and what travels is this frozen request or nothing at all.
    const request = ownModelRequest(candidate, composed.budget.reservedOutput);

    const outcome = await runModelStep({
      modelClient: deps.modelClient,
      request,
      limits: composed.limits,
      fixed,
      session,
      turnId,
      context,
      emit,
      meter,
    });

    if (outcome.status === "cancelled") return closeTurn(meter, turnId, { reason: "cancelled", text: "" });
    if (outcome.status === "failed") {
      return closeTurn(meter, turnId, { reason: "error", text: "", error: outcome.message });
    }

    // The whole group is judged before any of it is written down. A step whose
    // declarations cannot be part of a managed turn is a step that names no
    // calls at all, so nothing it asked for can have run.
    assertToolGroup(outcome.toolCalls, limits);

    commitFact(meter, session, {
      type: "message/assistant",
      turnId,
      data: { text: outcome.text, toolCalls: outcome.toolCalls },
    });
    lastText = outcome.text;

    // No tool call is the one and only termination condition: the step that asks
    // for nothing carries the final answer.
    if (outcome.toolCalls.length === 0) {
      return closeTurn(meter, turnId, { reason: "completed", text: outcome.text });
    }

    for (const call of outcome.toolCalls) {
      commitFact(meter, session, {
        type: "tool/call",
        turnId,
        data: { callId: call.callId, name: call.name, input: call.input },
      });
      emit?.({ type: "tool/call", callId: call.callId, name: call.name, input: call.input });

      // v0.2 runs tools one at a time, and each call is fully settled before the
      // next one starts, so the log reads as alternating call/result pairs.
      const result = await dispatchTool(deps.tools, call, context);

      const content = toolResultContent(result);
      commitFact(
        meter,
        session,
        { type: "tool/result", turnId, data: { callId: call.callId, name: call.name, ok: result.ok, content } },
        // Charged after the tool ran, which is why this one raises a fault rather
        // than a refusal: the side effect may exist, and nothing about the request
        // can be re-phrased to make it un-happen.
        true,
      );
      emit?.({
        type: "tool/result",
        callId: call.callId,
        name: call.name,
        ok: result.ok,
        content,
      });
    }
  }
}

/**
 * The turn's closing fact, charged before the Runtime writes it.
 *
 * The reason and the error are known here, and they are what the `turn/end`
 * record will hold, so the meter can account for the last fact of the turn like
 * every other one. It is charged without the headroom check the content facts
 * keep, because that headroom was reserved for exactly this: a turn that fit its
 * content can always be closed, whatever it decided in the end.
 */
function closeTurn(meter: TurnResourceMeter, turnId: string, outcome: TurnOutcome): TurnOutcome {
  meter.commitTerminal("the turn's end", {
    type: "turn/end",
    turnId,
    data: { reason: outcome.reason, ...(outcome.error === undefined ? {} : { error: outcome.error }) },
  });
  return outcome;
}

/**
 * Records one fact of the turn: charged first, written second.
 *
 * The order is the point. A fact the meter refuses never reaches the log, so a
 * turn that could not be kept whole is a turn that was never half-written — and
 * a turn whose *result* could not be kept stops there with a fault, because the
 * tool that produced it has already run.
 */
function commitFact(
  meter: TurnResourceMeter,
  session: Session,
  fact: SessionEventInput,
  producedByATool = false,
): void {
  if (producedByATool) meter.commitResult("a tool result", fact);
  else meter.commit(fact.type === "tool/call" ? "a tool call" : "the step's declaration", fact);
  session.append(fact);
}

/**
 * What the Runtime already recorded for this turn, read back from the log.
 *
 * The turn's framing and its user input are written by the AgentRuntime before
 * the loop is called. The meter counts what happened rather than what this file
 * expected to happen, so they are read from the session instead of passed in.
 */
function chargeWhatTheRuntimeAlreadyWrote(meter: TurnResourceMeter, session: Session, turnId: string): void {
  for (const event of session.events()) {
    if (event.turnId !== turnId) continue;
    if (event.type === "turn/start") meter.commit("the turn's start", { type: event.type, turnId, data: event.data });
    else if (event.type === "message/user") meter.commit("the turn's input", { type: event.type, turnId, data: event.data });
  }
}

/**
 * The whole group of one step's calls, judged together.
 *
 * Counted and measured as a group because that is the only moment at which the
 * answer is still free: after the assistant declaration is written, the calls
 * exist and the first of them runs.
 */
function assertToolGroup(calls: readonly ToolCall[], limits: LoopResourceLimits): void {
  if (calls.length > limits.maxToolCallsPerStep) {
    throw new NonRetryableModelError(
      `a model step declared ${calls.length} tool calls, more than this profile allows`,
    );
  }
  for (const call of calls) assertToolInput(call, limits);
}

/** The observation a call gets when the turn was cancelled before it could run. */
const CANCELLED_TOOL_RESULT = "tool not executed: the turn was cancelled";

/**
 * Runs one recorded tool call, and always answers it.
 *
 * A call that is already in the log gets a result no matter what — cancelled before
 * it could run, or failed in a way the registry did not normalize. An assistant
 * message whose tool calls are never answered is exactly the history a provider
 * rejects on the next request, and the loop's promise not to produce one cannot
 * depend on every injected ToolRegistry keeping its own.
 *
 * The one thing it does not swallow is a resource fault: a tool that says the
 * turn can no longer be recorded honestly is not a tool that failed, and turning
 * it into an ordinary `ok: false` would report a side effect as a clean miss.
 */
async function dispatchTool(
  tools: ToolRegistry,
  call: ToolCall,
  context: RuntimeContext,
): Promise<ToolExecutionResult> {
  if (context.signal.aborted) return { ok: false, error: CANCELLED_TOOL_RESULT };

  try {
    return await tools.execute(call.name, call.input, context);
  } catch (error) {
    if (error instanceof TurnResourceFault) throw error;
    return { ok: false, error: errorMessageOf(error) };
  }
}

type ModelStepResult =
  | { readonly status: "completed"; readonly text: string; readonly toolCalls: ToolCall[] }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly message: string };

interface ModelStepInput {
  readonly modelClient: ModelClient;
  readonly request: ModelRequest;
  readonly limits: ModelLimits;
  readonly fixed: FixedContext;
  readonly session: Session;
  readonly turnId: string;
  readonly context: RuntimeContext;
  readonly emit: ((event: AgentLoopEvent) => void) | undefined;
  readonly meter: TurnResourceMeter;
}

/**
 * Consumes one model step, retrying only while nothing has reached the audience.
 *
 * `assistant/chunk` is emitted the moment the model says it, so a step that has
 * text can never be re-run without the answer arriving twice; such a failure is
 * reported instead. Argument deltas are the other way round — a tool call is only
 * recorded once its step completes — so a half-assembled call can be thrown away
 * and the step asked for again.
 *
 * The same rule keeps a retry invisible: it happens before anything is emitted.
 * A failure is never a `ModelEvent`: it arrives as a throw, which is also how a
 * cancellation (`signal.aborted`) is told apart from a model that broke. What a
 * retry may never do is reconsider a failure that is deterministic — a budget, a
 * declaration or a provider cap that would decide the same way again — so those
 * arrive as `NonRetryableModelError` and end the turn on the first attempt.
 *
 * The guard runs here, once per attempt, on the very request this attempt will
 * send: a retry re-uses one frozen semantic request, and re-proves that it still
 * fits rather than trusting the proof it was built with.
 */
async function runModelStep(step: ModelStepInput): Promise<ModelStepResult> {
  const { modelClient, request, limits, fixed, session, turnId, context, emit, meter } = step;
  const failures: string[] = [];
  // Consecutive identical causes collapse into one, so a broken transport reads as
  // one reason instead of three, and no attempt's cause hides another's.
  const recordFailure = (message: string): void => {
    if (failures.at(-1) !== message) failures.push(message);
  };
  const attempts = meter.profile.maxModelAttempts;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (context.signal.aborted) return { status: "cancelled" };
    // A previous attempt's staged step is gone; nothing of it is recorded.
    meter.discardStaging();

    assertModelRequestFits(request, { limits, fixed, turn: { events: session.events(), turnId } });

    let text = "";
    const toolCalls: ToolCall[] = [];

    try {
      modelStep: for await (const event of modelClient.stream(request, context)) {
        // The client owns its transport, but the loop owns the turn: stop pulling as
        // soon as the signal is aborted, whatever the client decides to do.
        if (context.signal.aborted) return { status: "cancelled" };

        switch (event.type) {
          case "text-delta":
            meter.stageText(event.text);
            text += event.text;
            emit?.({ type: "assistant/chunk", text: event.text });
            break;

          case "tool-call":
            meter.stageCall(event.call);
            // Shallow copy: a client that keeps its own reference to the call it
            // emitted must not be able to reach back into what this step recorded.
            // `input` stays by reference, exactly as Session.deriveMessages treats it.
            toolCalls.push({ ...event.call });
            break;

          case "done":
            break modelStep;
        }
      }
    } catch (error) {
      if (context.signal.aborted) return { status: "cancelled" };
      if (error instanceof TurnResourceFault) throw error;
      if (error instanceof NonRetryableModelError) return { status: "failed", message: errorMessageOf(error) };

      recordFailure(errorMessageOf(error));
      if (text !== "") return { status: "failed", message: failures.join("; ") };
      continue;
    }

    // A client that stops on abort instead of throwing ends its stream here. That is
    // a cancellation, not an answer: an aborted step is never recorded.
    if (context.signal.aborted) return { status: "cancelled" };

    // Nothing at all is not an answer either. Treated as a failed attempt, because a
    // turn that ends with an empty reply is a turn nobody asked for.
    if (text === "" && toolCalls.length === 0) {
      recordFailure("model produced no output");
      continue;
    }

    return { status: "completed", text, toolCalls };
  }

  return {
    status: "failed",
    message: `model step failed after ${attempts} attempts: ${failures.join("; ")}`,
  };
}

/**
 * Where a tool outcome becomes model-visible text — the only place, since
 * `content` is a string while a tool may return anything.
 *
 * Deliberately total: JSON cannot represent `undefined` (it yields `undefined`
 * rather than a string) and refuses circular structures. Letting either escape
 * would undo the registry's "never throws at the caller" contract one layer up.
 */
function toolResultContent(result: ToolExecutionResult): string {
  if (!result.ok) return result.error;
  if (typeof result.value === "string") return result.value;

  try {
    return JSON.stringify(result.value, bigintAsString) ?? String(result.value);
  } catch {
    return "<unserializable tool result>";
  }
}

/**
 * `JSON.stringify(1n)` throws, so without this a tool that counted in bigints
 * would have its *successful* result rendered as an unserializable failure. A
 * bigint travels as its decimal text, which is also the only shape JSON has for it.
 */
function bigintAsString(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
