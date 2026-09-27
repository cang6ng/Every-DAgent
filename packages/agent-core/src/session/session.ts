import type { ModelMessage } from "../model/message.js";
import type { SessionEvent, SessionEventInput } from "./session-event.js";

/**
 * The session is the factual record of a conversation; the model context is a
 * derivation of it. Persistence is deliberately out of scope here — a
 * SessionStore attaches later without this interface changing.
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

class EventLogSession implements Session {
  readonly id: string;
  private readonly log: SessionEvent[] = [];

  constructor(id: string) {
    this.id = id;
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
