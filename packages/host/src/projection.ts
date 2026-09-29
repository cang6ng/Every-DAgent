/**
 * Core fact -> protocol DTO. The only direction, and the only place.
 *
 * Everything here is total and side-effect free: it either returns a DTO the
 * frozen contract can carry or it throws, and a throw means the host cannot
 * honestly represent something it just observed. Nothing in this module reads
 * the wire, retries a tool, or re-parses tool text: the host shows what the
 * Core recorded, and a display failure never changes what the Core did.
 */

import type { SessionEvent, TurnEndReason } from "@every-dagent/agent-core";
import type { PluginInfo } from "@every-dagent/plugin-system";
import type { CanonicalItem, DisplayInput, PluginSummary } from "@every-dagent/protocol";
import { validateJsonValue } from "@every-dagent/protocol";

import { pluginFailureSummary } from "./errors.js";

/**
 * Raised when a Core fact cannot be projected into a valid, honest DTO — an
 * inconsistent log, a tool occurrence that never closed, a live value the wire
 * has no shape for. The message stays inside the host: a faulted run publishes
 * a safe `INTERNAL_ERROR` and a blocked session, never this text.
 */
export class ProjectionError extends Error {
  constructor(detail: string) {
    super(`the host could not project this run: ${detail}`);
    this.name = "ProjectionError";
  }
}

/**
 * How a tool input is shown.
 *
 * `validateJsonValue` both checks and isolates: on success its value is a deep
 * snapshot, so a published `DisplayInput` cannot change when the object the
 * tool was actually given is mutated afterwards. It never reads through
 * accessors and never calls `toJSON`, so a hostile input is reported as
 * unavailable rather than executed for display.
 */
export function projectDisplayInput(input: unknown): DisplayInput {
  const validated = validateJsonValue(input);
  return validated.success
    ? Object.freeze({ kind: "json" as const, value: validated.output })
    : Object.freeze({ kind: "unavailable" as const, reason: "not-json-safe" as const });
}

/** The plugin as the protocol sees it: a projection, never a `PluginInfo` re-export. */
export function projectPluginInfo(info: PluginInfo): PluginSummary {
  const manifest = info.manifest;
  return Object.freeze({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    permissions: Object.freeze([...(manifest.permissions ?? [])]),
    status: info.status,
    ...(info.lastFailure === undefined ? {} : { lastFailure: pluginFailureSummary(info.lastFailure) }),
  });
}

/**
 * Whether two published summaries say the same thing.
 *
 * Compared field by field, never by reference: the manager hands out a fresh
 * `PluginInfo` object on every read, so identity would report a change every
 * time and content is the only honest comparison. A failure that keeps the
 * status but rewrites the safe failure summary is a change; a failure whose
 * original message changed but whose safe projection did not, is not.
 */
export function samePluginSummary(left: PluginSummary, right: PluginSummary): boolean {
  if (
    left.id !== right.id ||
    left.name !== right.name ||
    left.version !== right.version ||
    left.description !== right.description ||
    left.status !== right.status ||
    left.permissions.length !== right.permissions.length
  ) {
    return false;
  }
  for (let index = 0; index < left.permissions.length; index++) {
    if (left.permissions[index] !== right.permissions[index]) return false;
  }

  const leftFailure = left.lastFailure;
  const rightFailure = right.lastFailure;
  if (leftFailure === undefined || rightFailure === undefined) {
    return leftFailure === rightFailure;
  }
  return (
    leftFailure.operation === rightFailure.operation &&
    leftFailure.phase === rightFailure.phase &&
    leftFailure.code === rightFailure.code &&
    leftFailure.message === rightFailure.message &&
    leftFailure.cleanupFailureCount === rightFailure.cleanupFailureCount
  );
}

export interface SettledTurn {
  readonly turnId: string;
  readonly items: readonly CanonicalItem[];
  readonly reason: TurnEndReason;
}

/** What the host knows about the turn it is about to settle. */
export interface SettledTurnInput {
  readonly sessionId: string;
  /** The segment of the session log this run is responsible for. */
  readonly events: readonly SessionEvent[];
  /** The text this run accepted: the user record must say exactly this. */
  readonly expectedText: string;
  /** The turn id this run bound from the Runtime stream. */
  readonly expectedTurnId: string;
  /** The published cursor the segment starts at: the log's own numbering. */
  readonly startSeq: number;
}

/**
 * Turns one settled turn's log segment into published canonical items.
 *
 * The protocol's schemas can only check each item on its own; they cannot see
 * whether a turn is *complete*, whether it is the turn the host thinks it is, or
 * whether it is structurally something the Core could have written. This is
 * where that is decided, against the evidence the Core actually leaves behind.
 *
 * Identity and position:
 *
 * - every entry in the segment carries the turn id this run bound, and the
 *   segment opens with `turn/start` and closes with the final `turn/end`;
 * - the sequence numbers run unbroken from the published cursor, in order: a
 *   reversed, repeated or skipped position is a log no host can vouch for;
 * - the user input is the text this run accepted, verbatim.
 *
 * Structure:
 *
 * - every tool call an assistant message declared is followed, in order, by its
 *   own `tool/call` and `tool/result`; nothing is dispatched that was not
 *   declared and nothing declared is dropped;
 * - nothing follows the closing `turn/end`.
 *
 * Outcome shape, derived from the Core's own loop rather than from a guess:
 *
 * - `completed` is returned by `runSteps` only immediately after a
 *   `message/assistant` with no tool calls, so a completed turn must end on
 *   exactly that record;
 * - `max_steps` is returned at the top of an iteration, so the turn must carry
 *   at least one assistant record and end on the `tool/result` of the step that
 *   spent the last of the budget;
 * - `cancelled` and `error` are returned before any record of the step that
 *   died — including, at the very start of a turn, before any assistant record
 *   exists — so any prefix that is otherwise consistent is legal for them.
 *
 * Pairing is by occurrence, never by `callId`: the Core allows an empty callId
 * and allows the same one across steps, so a call id is not an identity. The
 * `invocationId` published on each pair is derived from the call event's own
 * log position, which is unique by construction.
 *
 * A segment that fails any of this is not repaired: it throws, and the run ends
 * as a host failure with a blocked session rather than becoming a plausible but
 * wrong history.
 */
export function projectSettledTurn(input: SettledTurnInput): SettledTurn {
  const { sessionId, events, expectedText, expectedTurnId, startSeq } = input;

  const opened = events[0];
  if (opened === undefined || opened.type !== "turn/start") {
    throw new ProjectionError("the settled segment does not open with a turn start");
  }
  const turnId = opened.turnId;
  if (turnId !== expectedTurnId) {
    throw new ProjectionError("the settled segment belongs to a different turn");
  }

  const closed = events[events.length - 1];
  if (closed === undefined || closed.type !== "turn/end") {
    throw new ProjectionError("the settled segment does not close with a turn end");
  }

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.turnId !== turnId) {
      throw new ProjectionError("the settled segment mixes two turn ids");
    }
    // The log numbers its own events; the host only reads them. A segment that
    // does not continue the cursor exactly is a window onto something else.
    if (event.seq !== startSeq + index) {
      throw new ProjectionError("the settled segment does not continue the published log");
    }
  }

  const items: CanonicalItem[] = [];
  let index = 1;

  const user = events[index];
  if (user === undefined || user.type !== "message/user") {
    throw new ProjectionError("the settled segment has no recorded user input");
  }
  if (user.data.text !== expectedText) {
    throw new ProjectionError("the recorded user input is not the text this run accepted");
  }
  items.push(
    Object.freeze({
      id: `${sessionId}:${user.seq}`,
      turnId,
      kind: "user" as const,
      text: user.data.text,
    }),
  );
  index++;

  for (;;) {
    const event = events[index];
    if (event === undefined) {
      throw new ProjectionError("the settled segment ran past its closing turn end");
    }
    if (event.type === "turn/end") {
      if (event !== closed) {
        throw new ProjectionError("a turn end appears before the settled segment's last event");
      }
      index++;
      break;
    }
    if (event.type !== "message/assistant") {
      throw new ProjectionError(`the settled segment has an unexpected ${event.type} event`);
    }

    items.push(
      Object.freeze({
        id: `${sessionId}:${event.seq}`,
        turnId,
        kind: "assistant" as const,
        text: event.data.text,
      }),
    );
    index++;

    for (const declared of event.data.toolCalls) {
      const call = events[index];
      if (call === undefined || call.type !== "tool/call") {
        throw new ProjectionError("a declared tool call was never recorded");
      }
      if (call.data.callId !== declared.callId || call.data.name !== declared.name) {
        throw new ProjectionError("a recorded tool call does not match the one declared");
      }
      const invocationId = `${sessionId}:${call.seq}:call`;
      items.push(
        Object.freeze({
          id: `${sessionId}:${call.seq}`,
          turnId,
          kind: "tool-call" as const,
          invocationId,
          callId: call.data.callId,
          name: call.data.name,
          input: projectDisplayInput(call.data.input),
        }),
      );
      index++;

      const result = events[index];
      if (result === undefined || result.type !== "tool/result") {
        throw new ProjectionError("a recorded tool call was never answered");
      }
      if (result.data.callId !== declared.callId || result.data.name !== declared.name) {
        throw new ProjectionError("a recorded tool result does not belong to its call");
      }
      items.push(
        Object.freeze({
          id: `${sessionId}:${result.seq}`,
          turnId,
          kind: "tool-result" as const,
          invocationId,
          callId: result.data.callId,
          name: result.data.name,
          ok: result.data.ok,
          content: result.data.content,
        }),
      );
      index++;
    }
  }

  if (index !== events.length) {
    throw new ProjectionError("the settled segment has events after its closing turn end");
  }

  assertOutcomeShape(events, closed.data.reason);

  return { turnId, items: Object.freeze(items), reason: closed.data.reason };
}

/**
 * The closing record each outcome must have, in the shapes the Core can produce.
 *
 * See the note above `projectSettledTurn` for where each rule comes from. The
 * rules are deliberately per outcome: a cancelled or failed turn may legitimately
 * carry nothing but the user input, so a blanket "there is always an assistant
 * record" would reject history the Core really wrote.
 */
function assertOutcomeShape(events: readonly SessionEvent[], reason: TurnEndReason): void {
  const lastScoped = events[events.length - 2];

  switch (reason) {
    case "completed":
      if (
        lastScoped === undefined ||
        lastScoped.type !== "message/assistant" ||
        lastScoped.data.toolCalls.length > 0
      ) {
        throw new ProjectionError("a completed turn does not end with a finished assistant record");
      }
      return;

    case "max_steps": {
      const assistantRecords = events.filter((event) => event.type === "message/assistant").length;
      if (assistantRecords === 0) {
        throw new ProjectionError("a limited turn has no completed model step");
      }
      if (lastScoped === undefined || lastScoped.type !== "tool/result") {
        throw new ProjectionError("a limited turn does not end on the step that spent its budget");
      }
      return;
    }

    case "cancelled":
    case "error":
      // The turn stopped before the step it died in was recorded, so any
      // otherwise-consistent prefix is exactly what the Core writes.
      return;
  }
}
