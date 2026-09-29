/**
 * The client's own error vocabulary.
 *
 * Four kinds, and no more. A `remote` error is a validated wire error the host
 * wrote; a `connection` error is local transport reality (`CONNECTION_LOST` is
 * never a wire code); a `protocol` error is a peer that broke the frozen
 * contract, which ends the connection; a `client` error is the caller using the
 * client in a way it cannot honour, and nothing was sent.
 *
 * Every message here is written locally. Nothing about the raw frame, the
 * failing internals or a thrown exception travels with an error — only the
 * code, a fixed sentence, and how much the caller may still assume.
 */

import type { ProtocolError, ProtocolErrorCode } from "@every-dagent/protocol";

export type ClientErrorCode =
  | ProtocolErrorCode
  | "CONNECTION_LOST"
  | "PROTOCOL_VIOLATION"
  | "CLIENT_MISUSE";

/**
 * What a caller may assume about a request that did not get an answer.
 *
 * `not-sent` means the client refused before the frame reached the transport.
 * `unknown` means a send was attempted and the answer never arrived — the host
 * may or may not have executed it, and the client will not pretend otherwise.
 */
export type OutcomeClaim = "not-sent" | "unknown";

export type ConnectionLostReason =
  | "channel-closed"
  | "connector-failed"
  | "send-failed"
  | "disconnected";

export type ProtocolViolationReason =
  | "invalid-frame"
  | "wrong-direction"
  | "unsupported-protocol"
  | "invalid-description"
  | "invalid-response"
  | "invalid-event"
  | "unknown-event"
  | "host-instance-mismatch"
  | "duplicate-request-id"
  | "snapshot-fence"
  | "capability-violation"
  | "result-identity"
  | "run-identity";

export type ClientMisuseReason =
  | "not-initialized"
  | "capability-unavailable"
  | "invalid-params"
  | "sync-in-flight"
  | "capacity";

const CONNECTION_MESSAGES: Readonly<Record<ConnectionLostReason, string>> = Object.freeze({
  "channel-closed": "the connection to the host was lost",
  "connector-failed": "the connection to the host could not be established",
  "send-failed": "the connection refused a frame and was closed",
  disconnected: "the client was disconnected",
});

const VIOLATION_MESSAGES: Readonly<Record<ProtocolViolationReason, string>> = Object.freeze({
  "invalid-frame": "the host sent a frame that is not a protocol message",
  "wrong-direction": "the host sent a frame this side never receives",
  "unsupported-protocol": "the host does not speak this protocol generation",
  "invalid-description": "the host described itself inconsistently",
  "invalid-response": "the host's response did not match the request it answers",
  "invalid-event": "the host sent an event that cannot follow from the state it describes",
  "unknown-event": "the host sent an event type this client does not know",
  "host-instance-mismatch": "the frame named a different host instance",
  "duplicate-request-id": "the host reused a request id on this connection",
  "snapshot-fence": "the host sent stream traffic before the snapshot that explains it",
  "capability-violation": "the host used a capability it did not describe",
  "result-identity": "the host's result describes a different request than the one made",
  "run-identity": "the host changed a run's identity or live timeline",
});

const MISUSE_MESSAGES: Readonly<Record<ClientMisuseReason, string>> = Object.freeze({
  "not-initialized": "the connection has not completed host.describe",
  "capability-unavailable": "the host does not support this operation",
  "invalid-params": "the request does not satisfy the method's contract",
  "sync-in-flight": "a subscription change is already in progress",
  capacity: "the client is at capacity for outstanding requests",
});

export interface ClientErrorFields {
  readonly kind: "remote" | "connection" | "protocol" | "client";
  readonly code: ClientErrorCode;
  readonly message: string;
  readonly outcome?: OutcomeClaim;
  readonly reason?: ConnectionLostReason | ProtocolViolationReason | ClientMisuseReason;
  readonly protocolError?: ProtocolError;
}

export class ClientError extends Error {
  readonly kind: ClientErrorFields["kind"];
  readonly code: ClientErrorCode;
  readonly outcome: OutcomeClaim | undefined;
  readonly reason: ConnectionLostReason | ProtocolViolationReason | ClientMisuseReason | undefined;
  /** The validated wire error, when this came from one. */
  readonly protocolError: ProtocolError | undefined;

  constructor(fields: ClientErrorFields) {
    super(fields.message);
    this.name = "ClientError";
    this.kind = fields.kind;
    this.code = fields.code;
    this.outcome = fields.outcome;
    this.reason = fields.reason;
    this.protocolError = fields.protocolError;
  }
}

/** A host-written error, read from a validated response. The code is the meaning; the message is a notice. */
export function remoteError(error: ProtocolError): ClientError {
  return new ClientError({
    kind: "remote",
    code: error.code,
    message: error.message,
    protocolError: error,
  });
}

/**
 * The local transport outcome. Not a wire code, and not an assertion about the
 * host: `unknown` says the business outcome was never learned.
 */
export function connectionLost(reason: ConnectionLostReason, outcome: OutcomeClaim = "unknown"): ClientError {
  return new ClientError({
    kind: "connection",
    code: "CONNECTION_LOST",
    message: CONNECTION_MESSAGES[reason],
    outcome,
    reason,
  });
}

/** The peer broke the frozen contract on this connection. */
export function protocolViolation(reason: ProtocolViolationReason): ClientError {
  return new ClientError({
    kind: "protocol",
    code: "PROTOCOL_VIOLATION",
    message: VIOLATION_MESSAGES[reason],
    reason,
  });
}

/** The call itself was not answerable, and nothing was sent. */
export function clientMisuse(reason: ClientMisuseReason): ClientError {
  return new ClientError({
    kind: "client",
    code: "CLIENT_MISUSE",
    message: MISUSE_MESSAGES[reason],
    outcome: "not-sent",
    reason,
  });
}
