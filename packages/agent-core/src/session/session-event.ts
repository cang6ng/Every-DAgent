import type { ToolCall } from "../model/message.js";

/**
 * The six core session event kinds.
 *
 * Deliberately narrower than a full harness vocabulary: no step, attempt,
 * checkpoint, inbox, compaction or repair events. `turnId` lives on the event
 * envelope rather than in `data`, so every event of one turn shares it.
 */
export type SessionEventType =
  | "turn/start"
  | "message/user"
  | "tool/call"
  | "tool/result"
  | "message/assistant"
  | "turn/end";

/** Why a turn stopped. `max_steps` is enforced by the loop, not by the session. */
export type TurnEndReason = "completed" | "max_steps" | "cancelled" | "error";

/** Nothing beyond the envelope's `turnId` describes a turn starting. */
export type TurnStartData = Record<string, never>;

export interface MessageUserData {
  readonly text: string;
}

export interface ToolCallData {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolResultData {
  readonly callId: string;
  readonly name: string;
  readonly ok: boolean;
  readonly content: string;
}

/**
 * Carries its own `toolCalls` so that projecting the log into model messages is
 * a per-event 1:1 mapping instead of a grouping pass over adjacent events.
 */
export interface MessageAssistantData {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
}

export interface TurnEndData {
  readonly reason: TurnEndReason;
}

export interface SessionEventDataMap {
  "turn/start": TurnStartData;
  "message/user": MessageUserData;
  "tool/call": ToolCallData;
  "tool/result": ToolResultData;
  "message/assistant": MessageAssistantData;
  "turn/end": TurnEndData;
}

/**
 * What a caller submits to `Session.append`. It carries no `seq` or `time`:
 * the Session owns those, so a caller can never forge log ordering.
 * `turnId` is assigned by the AgentLoop / Runtime, not by the Session.
 */
export type SessionEventInput<T extends SessionEventType = SessionEventType> = {
  [K in T]: {
    readonly type: K;
    readonly turnId: string;
    readonly data: SessionEventDataMap[K];
  };
}[T];

/** A recorded event: the input plus the Session-assigned envelope fields. */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in T]: {
    readonly type: K;
    readonly turnId: string;
    readonly seq: number;
    readonly time: number;
    readonly data: SessionEventDataMap[K];
  };
}[T];
