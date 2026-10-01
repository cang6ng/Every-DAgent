/**
 * The host's fixed, auditable error vocabulary.
 *
 * Every wire error the host ever sends is built here. The two rules the frozen
 * contract asks for are implemented by construction: a code always maps to the
 * same host-written sentence (nothing about the failing operation travels with
 * it), and a plugin failure is reduced to safe, enumerable facts — never to the
 * plugin's own message, which could carry anything a trusted plugin saw fit to
 * put in an exception.
 */

import type { PluginFailure } from "@every-dagent/plugin-system";
import type { PluginFailureSummary, ProtocolError, ProtocolErrorCode } from "@every-dagent/protocol";

/** One fixed notice per code. `message` is a hint, never a parsing surface. */
const MESSAGES: Readonly<Record<ProtocolErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: "the request did not match the method's contract",
  UNSUPPORTED_PROTOCOL: "the host does not speak the requested protocol generation",
  NOT_INITIALIZED: "the connection must complete host.describe before business methods",
  HOST_INSTANCE_MISMATCH: "the request named a different host instance",
  METHOD_NOT_FOUND: "the host does not implement this method",
  CAPABILITY_NOT_SUPPORTED: "the host does not support this capability",
  SESSION_NOT_FOUND: "no session with this id exists on this host",
  SESSION_UNAVAILABLE: "the session cannot accept a new run",
  RUN_NOT_FOUND: "no run with this id or submission id exists on this host",
  PLUGIN_NOT_FOUND: "no plugin with this id is registered",
  HOST_BUSY: "another run or plugin lifecycle operation is in flight",
  PLUGIN_UNAVAILABLE: "the plugin is in the error state and cannot be operated on",
  PLUGIN_PERMISSION_DENIED: "the plugin activation was refused by host policy",
  PLUGIN_OPERATION_FAILED: "the plugin lifecycle operation failed",
  SUBMISSION_CONFLICT: "this submission id was already used with a different payload",
  SUBMISSION_RETIRED: "this submission's session was deleted; it cannot be reused",
  STALE_CURSOR: "the page cursor was issued for a version of this collection that has changed",
  REVISION_CONFLICT: "the session changed since the revision this request expected",
  LIMIT_EXCEEDED: "the request exceeded a size or budget limit this host enforces",
  SETTINGS_INVALID: "the settings did not match the schema this host accepts",
  STORAGE_UNAVAILABLE: "the durable store is not available; no write was confirmed",
  REQUEST_CANCELLED: "the request was cancelled",
  INTERNAL_ERROR: "the host failed while handling this request",
});

const FAILURE_MESSAGES: Readonly<Record<PluginFailure["phase"], string>> = Object.freeze({
  permissions: "the plugin activation was refused by host policy",
  activate: "the plugin failed to activate",
  commit: "the plugin failed to register its tools",
  dispose: "the plugin cleanup failed",
});

/** A frozen wire error for one code. */
export function protocolError(code: ProtocolErrorCode): ProtocolError {
  return Object.freeze({ code, message: MESSAGES[code] });
}

/**
 * The error a stored failure code means, or null when the code is not one this
 * host writes.
 *
 * A persisted code is read back through the same fixed table that produced it,
 * so a record whose code this build does not recognize reports no error rather
 * than an invented one.
 */
export function storedProtocolError(code: string): ProtocolError | null {
  return Object.hasOwn(MESSAGES, code) ? protocolError(code as ProtocolErrorCode) : null;
}

/**
 * The one error that is not a failure of the request but of the host's life:
 * `HOST_BUSY` is the closest honest code, because the host is occupied — by its
 * own shutdown — and will never become available again.
 */
export function shuttingDownError(): ProtocolError {
  return Object.freeze({
    code: "HOST_BUSY" as const,
    message: "the host is shutting down and accepts no new work",
  });
}

/**
 * The store failed in a way the host cannot see through.
 *
 * Deliberately not translated into "the write did not happen": a failure to
 * commit is a failure to know, and the caller has to be told the outcome is
 * unconfirmed rather than that nothing was recorded.
 */
export function storageUnavailableError(): ProtocolError {
  return protocolError("STORAGE_UNAVAILABLE");
}

/** A request that asked for more than this host will do at once. */
export function limitExceededError(): ProtocolError {
  return protocolError("LIMIT_EXCEEDED");
}

/** A page cursor that was issued under a collection version that has moved on. */
export function staleCursorError(): ProtocolError {
  return protocolError("STALE_CURSOR");
}

/** A CAS write whose expected revision is no longer current. */
export function revisionConflictError(): ProtocolError {
  return protocolError("REVISION_CONFLICT");
}

/** The code a manager-recorded failure is reported under: phase decides, not wording. */
export function codeForPluginFailure(failure: PluginFailure): ProtocolErrorCode {
  return failure.phase === "permissions" ? "PLUGIN_PERMISSION_DENIED" : "PLUGIN_OPERATION_FAILED";
}

/**
 * The safe half of a plugin failure: where it happened and how much cleanup
 * failed, with a host sentence in place of the original message.
 */
export function pluginFailureSummary(failure: PluginFailure): PluginFailureSummary {
  return Object.freeze({
    operation: failure.operation,
    phase: failure.phase,
    code: failure.phase === "permissions" ? ("PLUGIN_PERMISSION_DENIED" as const) : ("PLUGIN_OPERATION_FAILED" as const),
    message: FAILURE_MESSAGES[failure.phase],
    cleanupFailureCount: failure.cleanupErrors.length,
  });
}
