/**
 * Which complete turns survive into a model request, and what happens to a tool
 * result that is too large to send.
 *
 * Two rules decide everything here.
 *
 * History is whole or absent. A model request is a conversation, and a
 * conversation cut in the middle of a tool call is not a shorter conversation —
 * it is a malformed one. So history is selected as a suffix of complete turns,
 * extending from the newest older turn towards the oldest, and the first turn
 * that does not fit ends the selection. Skipping past it to a smaller turn
 * further back is exactly the behaviour that would let a request read as if a
 * step had never happened.
 *
 * Only the current turn may shrink, and only its tool results. Everything the
 * newest user said, every call identity the model produced, and every tool
 * result of an older turn travel whole — a truncated argument or a dropped call
 * id is a different request pretending to be this one. What is truncated is
 * truncated in the model's copy alone: the session, the log and the durable
 * record keep the bytes the tool actually produced, and the marker says so in
 * the copy that does not.
 */

import { ContextBudgetError, InvalidModelRequestError } from "../errors.js";
import type { ModelMessage, ToolCall } from "../model/message.js";
import type { ModelRequest } from "../model/model-client.js";
import type { SessionEvent } from "../session/session-event.js";
import type { FixedContext } from "./context-builder.js";
import { estimateRequestCost } from "./context-estimator.js";
import type { ModelBudget, ModelLimits } from "./model-budget.js";
import { utf8Bytes } from "./stable-json.js";

export interface SelectionInput {
  /** The loaded window's events, in log order, ending at the current open turn. */
  readonly events: readonly SessionEvent[];
  /** The turn being built: the last, open turn of the window. */
  readonly turnId: string;
  readonly fixed: FixedContext;
  readonly limits: ModelLimits;
  readonly budget: ModelBudget;
}

/**
 * One turn of a loaded window, as the log recorded it.
 *
 * `complete` is the difference between history and the present: a turn the log
 * closed is history and travels whole or not at all, while the last turn of a
 * window is by definition open — the one being built.
 */
export interface SessionTurn {
  readonly turnId: string;
  readonly events: readonly SessionEvent[];
  readonly complete: boolean;
}

/**
 * One tool result inside a turn, and where its message sits in the projection.
 *
 * The slots are what truncation may address: everything else in the projection
 * is either fixed by the composition or fixed by the log.
 */
export interface ResultSlot {
  readonly messageIndex: number;
  readonly seq: number;
  readonly content: string;
}

/**
 * Reframes a loaded window's events as turns, refusing anything that is not one.
 *
 * The window has already been proven to be a contiguous suffix of committed
 * history by whoever loaded it; what is proven again here is the part a model
 * request depends on — that every event belongs to an open turn, that every
 * declared call is answered by the call and result records that follow it, and
 * that no call is left dangling. A request built from a log that fails this is
 * a request whose tool history a provider would reject, so it is refused here,
 * before it is built, rather than sent and rejected there.
 */
export function projectSessionTurns(events: readonly SessionEvent[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  let open: { turnId: string; events: SessionEvent[] } | undefined;

  for (const event of events) {
    if (event.type === "turn/start") {
      if (open !== undefined) {
        throw new InvalidModelRequestError(`the loaded session opens turn "${event.turnId}" while "${open.turnId}" is still open`);
      }
      open = { turnId: event.turnId, events: [event] };
      continue;
    }
    if (open === undefined) {
      throw new InvalidModelRequestError(`the loaded session has a ${event.type} outside any turn`);
    }
    if (event.turnId !== open.turnId) {
      throw new InvalidModelRequestError(`the loaded session has a ${event.type} from turn "${event.turnId}" inside turn "${open.turnId}"`);
    }
    open.events.push(event);
    if (event.type === "turn/end") {
      turns.push({ turnId: open.turnId, events: open.events, complete: true });
      open = undefined;
    }
  }

  if (open !== undefined) {
    turns.push({ turnId: open.turnId, events: open.events, complete: false });
  }
  return turns;
}

/**
 * Checks the call/result discipline of one turn.
 *
 * The sequence a provider will accept is exact: an assistant declaration names
 * its calls, each call is recorded and answered in order, and the next
 * declaration may not begin until everything it named has been answered. This
 * is deliberately stricter than "every call id has a matching result" — a
 * reordered pair is a different conversation, and a result for a call no
 * declaration ever named is a fabrication.
 */
function assertPairing(turn: SessionTurn): void {
  let declared: ToolCall[] = [];
  let pending: ToolCall[] = [];

  for (const event of turn.events) {
    switch (event.type) {
      case "message/assistant": {
        if (pending.length > 0 || declared.length > 0) {
          throw new InvalidModelRequestError(`turn "${turn.turnId}" declares a new step before answering its previous calls`);
        }
        declared = [...event.data.toolCalls];
        break;
      }
      case "tool/call": {
        const expected = declared.shift();
        if (expected === undefined) {
          throw new InvalidModelRequestError(`turn "${turn.turnId}" records a tool call no step declared`);
        }
        if (expected.callId !== event.data.callId || expected.name !== event.data.name) {
          throw new InvalidModelRequestError(`turn "${turn.turnId}" records a tool call its step did not declare`);
        }
        pending.push(expected);
        break;
      }
      case "tool/result": {
        const call = pending.shift();
        if (call === undefined) {
          throw new InvalidModelRequestError(`turn "${turn.turnId}" records a tool result no call is waiting for`);
        }
        if (call.callId !== event.data.callId || call.name !== event.data.name) {
          throw new InvalidModelRequestError(`turn "${turn.turnId}" records a tool result that does not answer its call`);
        }
        break;
      }
      default:
        break;
    }
  }

  if (declared.length > 0 || pending.length > 0) {
    throw new InvalidModelRequestError(`turn "${turn.turnId}" left a declared tool call unanswered`);
  }
}

/**
 * The model messages one turn projects to, plus where its tool results sit.
 *
 * A 1:1 mapping from events, in log order, exactly as `Session.deriveMessages`
 * reads it — the projection never searches the log for a matching record, and
 * the slots let the caller replace a result's content without touching anything
 * else.
 */
export function projectTurn(turn: SessionTurn): { messages: ModelMessage[]; results: ResultSlot[] } {
  const messages: ModelMessage[] = [];
  const results: ResultSlot[] = [];

  for (const event of turn.events) {
    switch (event.type) {
      case "message/user":
        messages.push({ role: "user", text: event.data.text });
        break;

      case "message/assistant":
        // Fresh array holding fresh call objects, so a caller cannot reach back
        // into the log through the projection. `input` stays by reference, the
        // same shallow isolation the session itself promises.
        messages.push({
          role: "assistant",
          text: event.data.text,
          toolCalls: event.data.toolCalls.map((call) => ({ ...call })),
        });
        break;

      case "tool/result":
        results.push({ messageIndex: messages.length, seq: event.seq, content: event.data.content });
        messages.push({
          role: "tool",
          results: [
            {
              callId: event.data.callId,
              name: event.data.name,
              ok: event.data.ok,
              content: event.data.content,
            },
          ],
        });
        break;

      default:
        // turn/start, tool/call and turn/end are session facts, not model input.
        break;
    }
  }

  return { messages, results };
}

/** The marker a model-only truncation leaves behind, naming the real byte count. */
export function truncationMarker(originalBytes: number): string {
  return `\n[model-only truncated tool result; original_utf8_bytes=${originalBytes}]`;
}

/** Whether cutting `content` after `keep` code units would split a surrogate pair. */
function splitsPair(content: string, keep: number): boolean {
  if (keep <= 0 || keep >= content.length) return false;
  const before = content.charCodeAt(keep - 1);
  const after = content.charCodeAt(keep);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** A cut position at or before `keep`, moved back off a surrogate pair if needed. */
function safeCut(content: string, keep: number): number {
  return splitsPair(content, keep) ? keep - 1 : keep;
}

/**
 * Whether a tool result in a request is the original, or the original's own
 * prefix followed by the marker that says it was shortened.
 *
 * This is the only shape a model copy may take, and it is checked against the
 * canonical content rather than trusted because a marker string is present: a
 * result that merely *contains* a marker, or whose marker names a different
 * length, is a rewritten observation and not a truncation.
 */
export function isLegalTruncation(original: string, candidate: string): boolean {
  if (candidate === original) return true;

  const marker = truncationMarker(utf8Bytes(original));
  if (candidate === marker) return true;
  if (!candidate.endsWith(marker)) return false;

  const prefix = candidate.slice(0, candidate.length - marker.length);
  if (prefix.length >= original.length) return false;
  return original.startsWith(prefix) && !splitsPair(original, prefix.length);
}

/** The projection with the named result contents substituted in. */
function withResultContents(
  messages: ModelMessage[],
  results: readonly ResultSlot[],
  contents: readonly string[],
): ModelMessage[] {
  if (results.length === 0) return messages;

  const byMessage = new Map<number, string>();
  for (let index = 0; index < results.length; index += 1) {
    const slot = results[index] as ResultSlot;
    byMessage.set(slot.messageIndex, contents[index] as string);
  }

  return messages.map((message, index) => {
    const content = byMessage.get(index);
    if (content === undefined || message.role !== "tool") return message;
    const result = message.results[0];
    if (result === undefined) return message;
    return { role: "tool", results: [{ ...result, content }] };
  });
}

/**
 * The whole current turn, shortened as far as the budget requires and no more.
 *
 * Results are reduced oldest-first, which is what keeps the newest observation
 * intact for as long as possible: the result the model is about to reason about
 * is the one that survives whole, and the ones it has already moved past are
 * the ones that lose their text. A result whose marker would cost more than the
 * content it replaces is not truncated at all — shortening a short result into
 * a longer one would be a change that made nothing fit.
 */
function truncateCurrentTurn(
  messages: ModelMessage[],
  results: readonly ResultSlot[],
  fits: (candidate: ModelMessage[]) => boolean,
): ModelMessage[] {
  const full = results.map((slot) => slot.content);
  const shortened = [...full];

  for (let index = 0; index < results.length; index += 1) {
    const original = full[index] as string;
    const marker = truncationMarker(utf8Bytes(original));
    if (utf8Bytes(marker) >= utf8Bytes(original)) continue;

    shortened[index] = marker;
    if (!fits(withResultContents(messages, results, shortened))) continue;

    // The turn fits with this result reduced to nothing but the marker; the
    // question is now how much of its own text it can keep. Cost rises with the
    // cut position, so the longest prefix that still fits is a binary search —
    // over raw positions, with the cut itself moved back off a surrogate pair,
    // so that the bound it compares against always makes progress.
    const at = (position: number): string => {
      const cut = safeCut(original, position);
      return cut === 0 ? marker : original.slice(0, cut) + marker;
    };
    let low = 0;
    let high = original.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const trial = [...shortened];
      trial[index] = at(middle);
      if (fits(withResultContents(messages, results, trial))) low = middle;
      else high = middle - 1;
    }
    shortened[index] = at(low);
    return withResultContents(messages, results, shortened);
  }

  // Every result is either as small as it can legally become or too short for a
  // marker to help. What is left is the current turn's mandatory content: the
  // newest user input, the calls, and the identities that pair them.
  throw new ContextBudgetError("current-turn");
}

/**
 * Builds the request the model is asked with: the fixed context, the newest
 * complete turns that fit, and the current turn — in that order, because that
 * is the order the conversation happened in.
 */
export function selectBoundedContext(input: SelectionInput): ModelRequest {
  const { events, turnId, fixed, limits, budget } = input;
  const turns = projectSessionTurns(events);

  const current = turns.at(-1);
  if (current === undefined || current.turnId !== turnId) {
    throw new InvalidModelRequestError(`the loaded session has no open turn "${turnId}"`);
  }
  if (current.complete) {
    throw new InvalidModelRequestError(`turn "${turnId}" is already closed, so no request can be built for it`);
  }
  if (!current.events.some((event) => event.type === "message/user")) {
    throw new InvalidModelRequestError(`turn "${turnId}" has no user input to answer`);
  }

  const history: ModelMessage[][] = [];
  for (const turn of turns.slice(0, -1)) {
    assertPairing(turn);
    history.push(projectTurn(turn).messages);
  }
  assertPairing(current);

  const projection = projectTurn(current);
  const fits = (candidate: ModelMessage[]): boolean =>
    estimateRequestCost(
      {
        ...(fixed.systemPrompt === undefined ? {} : { systemPrompt: fixed.systemPrompt }),
        messages: candidate,
        tools: fixed.tools,
        maxOutputTokens: budget.reservedOutput,
      },
      limits,
    ) <= budget.maxInputCost;

  const currentMessages = fits(projection.messages)
    ? projection.messages
    : truncateCurrentTurn(projection.messages, projection.results, fits);

  if (!fits(currentMessages)) throw new ContextBudgetError("current-turn");

  // History grows backwards from the current turn, one whole turn at a time: the
  // first turn that does not fit ends the selection, and nothing older is tried.
  let selected = currentMessages;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = [...(history[index] as ModelMessage[]), ...selected];
    if (!fits(candidate)) break;
    selected = candidate;
  }

  return {
    ...(fixed.systemPrompt === undefined ? {} : { systemPrompt: fixed.systemPrompt }),
    messages: selected,
    tools: fixed.tools,
    maxOutputTokens: budget.reservedOutput,
  };
}
