/**
 * The public surface of `@every-dagent/protocol`.
 *
 * An explicit whitelist, never `export *`: everything not listed here is an
 * internal validator/helper, and the public-API audit test pins this exact
 * runtime set. `HostErrorResponse` is deliberately absent — it is the input
 * type of the methodless error-only `host-response` encoding path, and
 * callers construct that shape structurally without needing the name.
 */

export { PROTOCOL_VERSION } from "./contracts.js";
export type {
  ActiveRunSnapshot,
  CanonicalItem,
  ClientCapabilities,
  ConversationPresentationSnapshot,
  DisplayInput,
  EndReason,
  EventScope,
  HostCapabilities,
  HostDescription,
  HostSnapshot,
  Id,
  JsonValue,
  LiveItem,
  LiveToolItem,
  PluginFailureSummary,
  PluginSummary,
  ProtocolError,
  ProtocolErrorCode,
  ProtocolVersion,
  RunSnapshot,
  RunStatus,
  Sequence,
  SessionSnapshot,
  SessionSummary,
  TerminalRunSnapshot,
  Watermark,
} from "./contracts.js";

export type {
  ClientRequest,
  ClientRequestFor,
  ClientResponse,
  HostRequest,
  HostResponse,
  OperationMap,
  OperationName,
} from "./operations.js";

export type { HostEvent } from "./events.js";

export type { ProtocolChannel, ProtocolChannelListener } from "./channel.js";

export type {
  DecodedEnvelope,
} from "./codec.js";
export { decodeFrame, encodeFrame } from "./codec.js";

export type {
  RequestCorrelation,
  ValidationFailure,
  ValidationFailureReason,
  ValidationResult,
  ValidationTarget,
} from "./validation.js";
export { validateJsonValue, validateMessage } from "./validation.js";
