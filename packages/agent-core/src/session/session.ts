import type { ModelMessage } from "../model/message.js";
import type { SessionEvent, SessionEventInput } from "./session-event.js";

/**
 * The session is the factual record of a conversation; the model context is a
 * derivation of it. Persistence stays out of this interface: a SessionStore is built
 * on top of it (`restoreSession` is the way back in) rather than inside it.
 */
export interface Session {
  readonly id: string;
  /**
   * Records an event and returns it as stored.
   *
   * `seq` and `time` are assigned by the Session, so a caller cannot forge log
   * ordering. `turnId` is assigned by the caller (the AgentLoop / Runtime).
   */
  append(event: SessionEventInput): SessionEvent;
  /** A frozen snapshot; the internal log is never exposed. */
  events(): readonly SessionEvent[];
  /**
   * Projects the log into model messages, preserving log order.
   *
   * It does not repair, synthesize or reorder history. A tool result carries its
   * own `callId`; keeping the tool call/result lifecycle complete is the
   * AgentLoop's responsibility, not this projection's.
   */
  deriveMessages(): ModelMessage[];
}

export function createSession(id: string): Session {
  return new EventLogSession(id);
}

/**
 * Rebuilds a session from events it recorded earlier.
 *
 * Separate from `createSession` because the two do different things with an event's
 * envelope: `append` assigns `seq` and `time`, while a restored session carries the
 * ones already written — a stored log is a record of what happened, and nothing here
 * may renumber or re-stamp it.
 *
 * The events are expected to be that session's own and to be all of them, which is
 * the caller's obligation: the envelope carries no session id, and a log that does
 * not run from `seq` 0 to the end is either a window onto part of a conversation or a
 * corrupt log. Either way it is refused, because quietly repairing a broken record
 * would turn one bug into a wrong history.
 */
export function restoreSession(id: string, events: readonly SessionEvent[]): Session {
  const recorded: SessionEvent[] = [];

  for (let seq = 0; seq < events.length; seq++) {
    const event = events[seq];
    if (event === undefined) {
      throw new Error(`session "${id}" cannot be restored: its log has a hole at seq ${seq}`);
    }
    if (event.seq !== seq) {
      throw new Error(
        `session "${id}" cannot be restored: expected seq ${seq}, found seq ${event.seq}`,
      );
    }

    // Frozen exactly the way `append` freezes: a restored event is no more mutable
    // than a recorded one, and `data` stays a single shallow level.
    // One cast, as in `append`: the correlated union cannot be re-derived from a
    // spread even though every branch is structurally identical here.
    recorded.push(Object.freeze({ ...event, data: Object.freeze({ ...event.data }) }) as SessionEvent);
  }

  return new EventLogSession(id, recorded);
}

class EventLogSession implements Session {
  readonly id: string;
  private readonly log: SessionEvent[];

  constructor(id: string, recorded: readonly SessionEvent[] = []) {
    this.id = id;
    this.log = [...recorded];
  }

  append(input: SessionEventInput): SessionEvent {
    // One cast: the correlated union cannot be re-derived from a widened `type`,
    // even though every branch is structurally identical at this point.
    const event = Object.freeze({
      type: input.type,
      turnId: input.turnId,
      seq: this.log.length,
      time: Date.now(),
      data: Object.freeze({ ...input.data }),
    }) as SessionEvent;

    this.log.push(event);
    return event;
  }

  events(): readonly SessionEvent[] {
    return Object.freeze([...this.log]);
  }

  deriveMessages(): ModelMessage[] {
    const messages: ModelMessage[] = [];

    for (const event of this.log) {
      switch (event.type) {
        case "message/user":
          messages.push({ role: "user", text: event.data.text });
          break;

        case "message/assistant":
          // Fresh array holding fresh ToolCall objects, so a caller mutating the
          // derived messages cannot reach back into the log. `input` is kept by
          // reference: P1.1 guarantees structural shallow isolation only, never
          // deep immutability of an unknown payload.
          messages.push({
            role: "assistant",
            text: event.data.text,
            toolCalls: event.data.toolCalls.map((call) => ({ ...call })),
          });
          break;

        case "tool/result":
          // The event already carries its own callId. The projection stays in log
          // order and never searches for a matching tool/call.
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

    return messages;
  }
}
