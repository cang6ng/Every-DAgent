import type { TurnEndReason } from "../session/session-event.js";

/**
 * What `AgentRuntime.run()` yields. A host consumes these instead of reaching
 * into AgentLoop, so Phase 3 needs no knowledge of the loop's internals.
 *
 * Only the four kinds the Phase 1 spec names; nothing produces them yet.
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
    };
