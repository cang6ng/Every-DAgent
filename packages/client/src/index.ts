/**
 * The public surface of `@every-dagent/client`.
 *
 * An explicit whitelist, never `export *`. The factory, the error class a caller
 * has to be able to recognize, and the types that describe what a caller may
 * read — nothing else. `createClientWith` and its internals are deliberately
 * absent, and so is the reverse seam: the production reverse catalog is empty,
 * the registration contract that fills it is internal, and it exists only so
 * tests can drive the real dispatcher.
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

export type { ClientSnapshot, ConnectionStatus, LiveMap, PresentationHost } from "./store.js";
export type { HistoryCoverage, HistoryMap } from "./fold.js";

export type { ProtocolChannel } from "@every-dagent/protocol";
