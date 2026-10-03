/**
 * The host's reverse-request mechanism: the requests the host sends to a
 * client, and the lifecycle that keeps a client's answer from outliving the
 * stream, the connection or the host itself.
 *
 * The mechanism is generic on purpose. What makes a method real is a *profile* —
 * a name, a strict contract for its params and a strict contract for the answer —
 * and the production catalog is empty: `HostInternals.reverseProfiles` is the
 * only way to register one, and the package index does not export it. Without a
 * profile nothing can be sent, and no answer can be accepted, so the reverse
 * seam exists without a single shipped business method.
 *
 * Waiting is bounded everywhere. A request is either answered, cancelled,
 * timed out, or ended by the scope it lived in — and every one of those paths
 * removes the pending *before* anything of the caller's runs, so a late answer
 * can never settle a request twice.
 */

import type { JsonValue, ProtocolError } from "@every-dagent/protocol";
import { PROTOCOL_VERSION, encodeFrame, validateMessage } from "@every-dagent/protocol";

import { hostRequestCancelledEvent, publishEventTo, sendFrame } from "./connection.js";
import type { ConnectionState, HostState, ReversePendingEntry } from "./state.js";

/**
 * One reverse profile: what makes a method real.
 *
 * `tool.approval` is the one production profile; test compositions may add
 * their own through `HostInternals`. A profile's two contracts decide what may
 * be sent and what may be accepted; its optional `claim` is the method's
 * *business* half, and it runs synchronously in the frame path for an accepted
 * answer — before the waiting caller is resolved, so the order two
 * near-simultaneous answers were received in is the order they are decided in.
 *
 * A claim returns `false` only for an answer this connection may not send at
 * all (a protocol violation, which ends it). An answer that is legal but
 * arrives too late to change anything returns `true`: the frame was read, and
 * its business effect is exactly nothing.
 */
export interface ReverseProfile {
  readonly method: string;
  /** The strict contract for this method's params; anything else is not sendable. */
  readonly acceptsParams: (params: JsonValue) => boolean;
  /** The strict contract for the client's answer; anything else is a connection fault. */
  readonly acceptsResult: (result: JsonValue) => boolean;
  readonly claim?: (pending: ReversePendingEntry, result: JsonValue) => boolean;
}

/** How one reverse request ended. `reason` values are local and never travel. */
export type ReverseOutcome =
  | { readonly ok: true; readonly result: JsonValue }
  | { readonly ok: false; readonly error: ProtocolError }
  | {
      readonly ok: false;
      readonly reason: "cancelled" | "timeout" | "closed" | "stream-gone" | "unavailable";
    };

/** Why a pending was dropped without an answer, when a cancel event is owed. */
export type ReverseNotification = "cancelled" | "timeout";

export interface ReverseRequestHandle {
  /** Settles when the request is answered, cancelled, timed out or its scope ends. */
  readonly outcome: Promise<ReverseOutcome>;
  /** Stops waiting and tells the client why; the answer is ignored from here on. */
  cancel(): void;
  /** The request id this request went out under; absent when it never went out. */
  readonly requestId?: string;
}

/** The narrow trigger one connection exposes for tests; production never sees it. */
export interface ReverseTrigger {
  /**
   * Sends one reverse request and installs its wait.
   *
   * `context` is the caller's own bookkeeping for this request (the business
   * record a delivery belongs to); it travels on the pending entry and is
   * handed back to the profile's `claim` exactly as it was given, so nothing
   * has to be looked up by request id afterwards.
   */
  request(method: string, params: JsonValue, timeoutMs: number, context?: unknown): ReverseRequestHandle;
}

export interface ReverseTimer {
  cancel(): void;
}

const MAX_TIMER_DELAY = 2 ** 31 - 1;

/**
 * A bounded wait: `setTimeout` cannot hold an arbitrary safe integer, and a
 * deadline past its ceiling is a legal `timeoutMs`, so the wait is re-armed
 * instead of being clamped into an early fire.
 */
function scheduleDeadline(deadline: number, fire: () => void): ReverseTimer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const arm = (): void => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      fire();
      return;
    }
    handle = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY));
  };

  arm();

  return {
    cancel: (): void => {
      cancelled = true;
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

export function createReverseConnectionState(
  profiles: readonly ReverseProfile[],
): {
  readonly profiles: ReadonlyMap<string, ReverseProfile>;
  readonly pending: Map<string, ReversePendingEntry>;
  readonly requestIds: Set<string>;
  counter: number;
} {
  const byMethod = new Map<string, ReverseProfile>();
  for (const profile of profiles) {
    // Two profiles for one method would make "what may be sent" depend on
    // registration order: the second would silently win, and an answer would be
    // judged by a contract the question was never asked under.
    if (byMethod.has(profile.method)) {
      throw new Error(`the reverse method "${profile.method}" is registered twice`);
    }
    byMethod.set(profile.method, profile);
  }

  return {
    profiles: byMethod,
    pending: new Map(),
    requestIds: new Set(),
    counter: 0,
  };
}

/**
 * The trigger for one connection.
 *
 * Every gate the frozen contract asks for is checked here, in this order and
 * before anything is enqueued: the client must have declared the capability,
 * the connection must have an active stream, the method must have a profile,
 * and the params must satisfy it. The request is installed as pending *before*
 * `sendFrame`, so a transport that answers inside `send` cannot outrun the
 * record of the wait.
 */
export function createReverseTrigger(
  state: HostState,
  connection: ConnectionState,
): ReverseTrigger {
  return {
    request: (
      method: string,
      params: JsonValue,
      timeoutMs: number,
      context?: unknown,
    ): ReverseRequestHandle => {
      let settle!: (outcome: ReverseOutcome) => void;
      const outcome = new Promise<ReverseOutcome>((resolve) => {
        settle = resolve;
      });

      const ended = (reason: "closed" | "unavailable"): ReverseRequestHandle => {
        settle({ ok: false, reason });
        return { outcome, cancel: (): void => undefined };
      };

      if (connection.closed) return ended("closed");
      const initialized = connection.initialized;
      if (initialized === undefined || initialized.capabilities.reverseRequests !== true) {
        return ended("unavailable");
      }
      const subscription = connection.subscription;
      if (subscription === undefined) return ended("unavailable");
      const profile = connection.reverse.profiles.get(method);
      if (profile === undefined || !profile.acceptsParams(params)) return ended("unavailable");

      connection.reverse.counter += 1;
      const requestId = `host-request-${connection.reverse.counter}`;
      const candidate = {
        kind: "host-request" as const,
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        method,
        params,
        hostInstanceId: state.hostInstanceId,
        streamId: subscription.streamId,
        timeoutMs,
      };
      const validated = validateMessage({ kind: "host-request" }, candidate);
      if (!validated.success) return ended("unavailable");
      const encoded = encodeFrame({ kind: "host-request" }, validated.output);
      if (!encoded.success) return ended("unavailable");

      connection.reverse.requestIds.add(requestId);
      const pending: ReversePendingEntry = {
        requestId,
        method,
        streamId: subscription.streamId,
        acceptsResult: profile.acceptsResult,
        settle,
        sent: false,
        timer: undefined,
        ...(context === undefined ? {} : { context }),
      };
      // The entry exists before the wait does: a deadline that has already
      // passed fires inside `scheduleDeadline`, and it has to find something
      // terminable rather than leaving a request nobody owns.
      connection.reverse.pending.set(requestId, pending);
      pending.timer = scheduleDeadline(Date.now() + timeoutMs, () => {
        cancelReversePending(state, connection, pending, "timeout");
      });

      if (connection.reverse.pending.get(requestId) === pending) {
        // Still waiting: only now is there a request to send, and a wait to
        // protect it. An entry that expired during setup is never sent at all.
        pending.sent = true;
        sendFrame(state, connection, encoded.output);
      }

      return {
        outcome,
        cancel: (): void => {
          cancelReversePending(state, connection, pending, "cancelled");
        },
        requestId,
      };
    },
  };
}

/**
 * Settles one pending with an answer, exactly once.
 *
 * Used by the dispatcher after a response has been validated against the
 * pending's own profile; the pending is gone before the caller is resolved.
 */
export function answerReversePending(
  connection: ConnectionState,
  pending: ReversePendingEntry,
  outcome: ReverseOutcome,
): void {
  if (connection.reverse.pending.get(pending.requestId) !== pending) return;
  connection.reverse.pending.delete(pending.requestId);
  pending.timer?.cancel();
  pending.timer = undefined;
  pending.settle(outcome);
}

/**
 * Stops waiting on one request and tells the client not to bother.
 *
 * The cancel notice travels on the stream the request lived on and consumes a
 * sequence number there — it is this connection's event, not a broadcast — and
 * it is only sent while that stream is still the connection's active one.
 */
export function cancelReversePending(
  state: HostState,
  connection: ConnectionState,
  pending: ReversePendingEntry,
  notification: ReverseNotification,
): void {
  // The entry is matched by identity: a deadline armed for one request must
  // never end another that happens to share its id.
  if (connection.reverse.pending.get(pending.requestId) !== pending) return;

  connection.reverse.pending.delete(pending.requestId);
  pending.timer?.cancel();
  pending.timer = undefined;

  const subscription = connection.subscription;
  if (
    pending.sent &&
    !connection.closed &&
    subscription !== undefined &&
    subscription.streamId === pending.streamId
  ) {
    try {
      publishEventTo(state, connection, hostRequestCancelledEvent(pending.requestId, notification));
    } catch {
      // The notice is best effort by contract: the wait ends either way, and a
      // stream that cannot carry the notice is already failing on its own.
    }
  }

  pending.settle({ ok: false, reason: notification });
}

/**
 * Drops every pending bound to one stream.
 *
 * Stream replacement and explicit close both end a scope: the client can no
 * longer be waiting for these, and the host stops waiting for the client.
 */
export function dropReverseForStream(
  connection: ConnectionState,
  streamId: string,
  reason: "stream-gone" | "closed",
): void {
  for (const pending of [...connection.reverse.pending.values()]) {
    if (pending.streamId !== streamId) continue;
    connection.reverse.pending.delete(pending.requestId);
    pending.timer?.cancel();
    pending.timer = undefined;
    pending.settle({ ok: false, reason });
  }
}

/** Ends every pending of one connection — the connection itself is going away. */
export function dropAllReverse(connection: ConnectionState, reason: "closed"): void {
  for (const pending of [...connection.reverse.pending.values()]) {
    connection.reverse.pending.delete(pending.requestId);
    pending.timer?.cancel();
    pending.timer = undefined;
    pending.settle({ ok: false, reason });
  }
}
