import type { TurnEndReason } from "../session/session-event.js";

/**
 * What `AgentRuntime.stream()` yields. A host consumes these instead of reaching
 * into AgentLoop, so Phase 3 needs no knowledge of the loop's internals.
 *
 * Only the four kinds the Phase 1 spec names. There is deliberately no assembled
 * `assistant/message` boundary: a step's content is the concatenation of its
 * `assistant/chunk` events, and its tool calls already arrive as `tool/call`, so a
 * second, redundant representation of the same step would have to be kept in sync.
 */
export type RuntimeEvent =
  | {
      readonly type: "assistant/chunk";
      readonly sessionId: string;
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly type: "tool/call";
      readonly sessionId: string;
      readonly turnId: string;
      readonly callId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool/result";
      readonly sessionId: string;
      readonly turnId: string;
      readonly callId: string;
      readonly name: string;
      readonly ok: boolean;
      readonly content: string;
    }
  | {
      readonly type: "turn/end";
      readonly sessionId: string;
      readonly turnId: string;
      readonly reason: TurnEndReason;
      /**
       * Why a turn ended as `error`, in the same words the session log keeps. A
       * failed turn is a reported outcome, not a rejection: the host is expected to
       * show it rather than to crash on it.
       */
      readonly error?: string;
    };
