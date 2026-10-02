/**
 * The public surface of `@every-dagent/protocol`.
 *
 * An explicit whitelist, never `export *`: everything not listed here is an
 * internal validator/helper, and the public-API audit test pins this exact
 * runtime set. `HostErrorResponse` is deliberately absent — it is the input
 * type of the methodless error-only `host-response` encoding path, and
 * callers construct that shape structurally without needing the name.
 */

export {
  MAX_FRAME_BYTES,
  MAX_PAGE_BYTES,
  MAX_PAGE_ITEMS,
  MAX_REQUEST_ID_BYTES,
  MAX_TITLE_CHARS,
  PROTOCOL_VERSION,
} from "./contracts.js";
export type {
  ActiveRunSnapshot,
  BlockedReason,
  CanonicalItem,
  ClientCapabilities,
  CollectionRevisions,
  ConversationPresentationSnapshot,
  DisplayInput,
  EndReason,
  EventScope,
  ExecutionKnowledge,
  HistoryCoverage,
  HistoryPage,
  HostCapabilities,
  HostDescription,
  HostLimits,
  HostSnapshot,
  Id,
  JsonValue,
  LiveItem,
  LiveToolItem,
  LogPosition,
  PluginFailureSummary,
  PluginSummary,
  ProtocolError,
  ProtocolErrorCode,
  ProtocolVersion,
  Revision,
  RunSnapshot,
  RunStatus,
  RunSummary,
  RunSummaryPage,
  Sequence,
  SessionSummary,
  SessionSummaryPage,
  StorageIdentity,
  TerminalRunSnapshot,
  Watermark,
} from "./contracts.js";

export type {
  ClientRequest,
  ClientRequestFor,
  ClientResponse,
  DescribeParams,
  EmptyParams,
  HostRequest,
  HostResponse,
  OperationMap,
  OperationName,
  PageParams,
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
