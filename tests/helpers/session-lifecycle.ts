import type { Session } from "@every-dagent/agent-core";

/**
 * Tool calls the log records as requested but never settles, and results that were
 * never asked for.
 *
 * A provider rejects a history in which an assistant tool call is not answered
 * before the next message, which is why the loop guarantees the call/result pairing
 * even when a turn is cancelled. Returns the call ids that do not pair up, whether
 * they were left open or answered twice.
 */
export function unsettledToolCalls(session: Session): string[] {
  const open = new Set<string>();
  const unsettled = new Set<string>();

  for (const event of session.events()) {
    switch (event.type) {
      case "message/assistant":
        // A new message while calls are still open is exactly the broken history.
        for (const callId of open) unsettled.add(callId);
        for (const call of event.data.toolCalls) open.add(call.callId);
        break;

      case "message/user":
        for (const callId of open) unsettled.add(callId);
        break;

      case "tool/call":
        open.add(event.data.callId);
        break;

      case "tool/result":
        // A result with nothing open belongs to no call: either it was never asked
        // for, or it answered a call a second time.
        if (!open.delete(event.data.callId)) unsettled.add(event.data.callId);
        break;

      default:
        break;
    }
  }

  for (const callId of open) unsettled.add(callId);
  return [...unsettled];
}
