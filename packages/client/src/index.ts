/**
 * The public surface of `@every-dagent/client`.
 *
 * An explicit whitelist, never `export *`. The factory, the error class a caller
 * has to be able to recognize, and the types that describe what a caller may
 * read or register — nothing else. `createClientWith` and its internals are
 * deliberately absent: the production reverse catalog is empty, and the seam
 * that fills it exists only so tests can drive the real dispatcher.
 */

export { createClient } from "./client.js";
export type { Client, ClientOptions } from "./client.js";

export { ClientError } from "./errors.js";
export type {
  ClientErrorCode,
  ConnectionLostReason,
  ClientMisuseReason,
  OutcomeClaim,
  ProtocolViolationReason,
} from "./errors.js";

export type { ClientSnapshot, ConnectionStatus, PresentationHost } from "./store.js";

export type {
  ReverseHandlerContext,
  ReverseHandlerOutcome,
  ReverseHandlerRegistration,
} from "./reverse.js";

export type { ProtocolChannel } from "@every-dagent/protocol";
