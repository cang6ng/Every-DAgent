/**
 * The wire contract's vocabulary, as frozen by `docs/PHASE3_PLATFORM_SPEC.md`.
 *
 * This module is pure types and constants: no validation library, no runtime
 * behaviour, no dependency on any other Every-DAgent package. Everything the
 * validators in `schemas.ts` / `operations.ts` / `events.ts` check must have a
 * declared shape here, so the public contract and the runtime checks cannot
 * drift apart silently.
 */

/** The only protocol generation this package speaks. Generation is a wire string, not an npm version. */
export const PROTOCOL_VERSION = "1" as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * Any value the wire can carry losslessly.
 *
 * This is the *type* of a strict JSON value; whether a runtime value actually
 * satisfies it is decided exclusively by `json-value.ts` — TypeScript cannot
 * see accessor properties, prototypes, `-0` or `NaN`.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A host-generated identifier. Non-empty, opaque, never trimmed or
 * case-normalized: a caller would not recognize a rewritten id.
 *
 * Core's `ToolCall.callId` is deliberately NOT an `Id`: it is an arbitrary
 * provider string that may be empty or repeated, and the protocol must not
 * tighten that Phase 1 contract (see `callId: string` on the tool items).
 */
export type Id = string;

/** A per-stream event position. `0` is reserved for snapshot watermarks; real events start at 1. */
export type Sequence = number;

export type ProtocolErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_PROTOCOL"
  | "NOT_INITIALIZED"
  | "HOST_INSTANCE_MISMATCH"
  | "METHOD_NOT_FOUND"
  | "CAPABILITY_NOT_SUPPORTED"
  | "SESSION_NOT_FOUND"
  | "SESSION_UNAVAILABLE"
  | "RUN_NOT_FOUND"
  | "PLUGIN_NOT_FOUND"
  | "HOST_BUSY"
  | "PLUGIN_UNAVAILABLE"
  | "PLUGIN_PERMISSION_DENIED"
  | "PLUGIN_OPERATION_FAILED"
  | "SUBMISSION_CONFLICT"
  | "REQUEST_CANCELLED"
  | "INTERNAL_ERROR";

/**
 * The only error shape on the wire. Deliberately flat: no stack, no cause, no
 * debug payload — the message is a host-written safety notice, not data.
 */
export interface ProtocolError {
  readonly code: ProtocolErrorCode;
  readonly message: string;
}

/**
 * How a tool call's input is shown to a client.
 *
 * `kind: "json"` carries a verified deep snapshot; `kind: "unavailable"` means
 * the internal value was not JSON-safe. This is display-only: the real tool
 * always received its original input, and producing this DTO is the Host's
 * job (P3.2), never the protocol package's.
 */
export type DisplayInput =
  | { readonly kind: "json"; readonly value: JsonValue }
  | { readonly kind: "unavailable"; readonly reason: "not-json-safe" };

/** A plugin lifecycle failure, reduced to safe, enumerable facts. */
export interface PluginFailureSummary {
  readonly operation: "enable" | "disable";
  readonly phase: "permissions" | "activate" | "commit" | "dispose";
  readonly code: "PLUGIN_PERMISSION_DENIED" | "PLUGIN_OPERATION_FAILED";
  readonly message: string;
  readonly cleanupFailureCount: number;
}

/** The plugin as the protocol sees it. A projection, never a `PluginInfo` re-export. */
export interface PluginSummary {
  readonly id: Id;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly permissions: readonly "storage"[];
  readonly status: "disabled" | "enabling" | "enabled" | "disabling" | "error";
  readonly lastFailure?: PluginFailureSummary;
}

/** Fields every canonical conversation item carries. Ids are host-assigned and stable per host lifetime. */
export interface CanonicalBase {
  readonly id: Id;
  readonly turnId: Id;
}

/**
 * The published, settled conversation history.
 *
 * `tool-call`/`tool-result` come from the log's own events; the assistant
 * message's `toolCalls` are deliberately not duplicated here. `callId` stays a
 * plain string (empty and repeated are legal) — pairing is by log order and
 * `invocationId`, never by `callId` uniqueness.
 */
export type CanonicalItem =
  | (CanonicalBase & { readonly kind: "user"; readonly text: string })
  | (CanonicalBase & { readonly kind: "assistant"; readonly text: string })
  | (CanonicalBase & {
      readonly kind: "tool-call";
      readonly invocationId: Id;
      readonly callId: string;
      readonly name: string;
      readonly input: DisplayInput;
    })
  | (CanonicalBase & {
      readonly kind: "tool-result";
      readonly invocationId: Id;
      readonly callId: string;
      readonly name: string;
      readonly ok: boolean;
      readonly content: string;
    });

export interface SessionSummary {
  readonly sessionId: Id;
  /** Host clock epoch milliseconds at creation; never client-provided. */
  readonly createdAt: number;
  readonly status: "ready" | "blocked";
  /** The one active run, or null. Every terminal run leaves this null. */
  readonly activeRunId: Id | null;
}

export interface SessionSnapshot extends SessionSummary {
  readonly canonical: readonly CanonicalItem[];
}

export type RunStatus = "accepted" | "running" | "completed" | "limited" | "failed" | "cancelled";

export type EndReason = "completed" | "max_steps" | "error" | "cancelled" | "host_error";

/**
 * One live UI timeline entry. Live items are presentation, not model
 * messages: consecutive chunks fold into one text item, and no event claims a
 * model-step boundary the Core never produced.
 */
export type LiveItem =
  | { readonly kind: "text"; readonly itemId: Id; readonly text: string }
  | {
      readonly kind: "tool";
      readonly itemId: Id;
      readonly invocationId: Id;
      readonly callId: string;
      readonly name: string;
      readonly input: DisplayInput;
      /** Filled by `run.tool.result`; null while the call is unsettled. */
      readonly result: null | { readonly ok: boolean; readonly content: string };
    };

/** The tool variant on its own, for events that carry exactly one tool item. */
export type LiveToolItem = Extract<LiveItem, { kind: "tool" }>;

export interface RunBase {
  readonly runId: Id;
  readonly submissionId: Id;
  readonly sessionId: Id;
  /** The accepted original user text, verbatim. */
  readonly text: string;
  /** Core's turn id once observed; null before the turn has produced one. */
  readonly turnId: Id | null;
  readonly cancelRequested: boolean;
}

/** A run that still owns the registry gate. `live` is the current timeline. */
export type ActiveRunSnapshot = RunBase &
  (
    | { readonly status: "accepted"; readonly endReason: null; readonly error: null; readonly live: readonly LiveItem[] }
    | { readonly status: "running"; readonly endReason: null; readonly error: null; readonly live: readonly LiveItem[] }
  );

/** A run whose outcome is final. `live` is always null: drafts never become history. */
export type TerminalRunSnapshot = RunBase &
  (
    | { readonly status: "completed"; readonly endReason: "completed"; readonly error: null; readonly live: null }
    | { readonly status: "limited"; readonly endReason: "max_steps"; readonly error: null; readonly live: null }
    | { readonly status: "cancelled"; readonly endReason: "cancelled"; readonly error: null; readonly live: null }
    | { readonly status: "failed"; readonly endReason: "error" | "host_error"; readonly error: ProtocolError; readonly live: null }
  );

export type RunSnapshot = ActiveRunSnapshot | TerminalRunSnapshot;

/** Where a subscription's snapshot ends and its event stream begins. */
export interface Watermark {
  readonly streamId: Id;
  readonly sequence: Sequence;
}

/** The full published state a `subscriptions.open` installs. A cut, not an event history. */
export interface HostSnapshot {
  readonly hostInstanceId: Id;
  readonly watermark: Watermark;
  readonly sessions: readonly SessionSnapshot[];
  readonly runs: readonly RunSnapshot[];
  readonly plugins: readonly PluginSummary[];
}

/**
 * A client-side derived view. Never transmitted on its own; `activeRun` must
 * agree with `session.activeRunId` or the client state is inconsistent.
 */
export interface ConversationPresentationSnapshot {
  readonly session: SessionSnapshot;
  readonly activeRun: RunSnapshot | null;
}

/** The client capabilities a logical connection declares during `host.describe`. */
export interface ClientCapabilities {
  readonly reverseRequests: boolean;
}

/** The host capabilities a Host declares. Only real, tested support may be claimed. */
export interface HostCapabilities {
  readonly sessions: boolean;
  readonly runs: boolean;
  readonly plugins: boolean;
  readonly subscriptions: boolean;
  readonly reverseRequests: boolean;
}

/** The `host.describe` result: identity, agreed generation, capabilities and limits. */
export interface HostDescription {
  readonly protocolVersion: "1";
  readonly hostInstanceId: Id;
  readonly host: { readonly name: string; readonly version: string };
  readonly capabilities: HostCapabilities;
  /** The client capabilities this logical connection was initialized with. */
  readonly clientCapabilities: ClientCapabilities;
  /** Host implementation limits, published honestly; `1` is the v1 limit, not a protocol constant. */
  readonly limits: { readonly maxActiveRuns: number };
  readonly retention: "host-lifetime";
}

/** Where an event belongs. Scope ids must agree with the payload's own ids. */
export type EventScope =
  | { readonly kind: "host" }
  | { readonly kind: "session"; readonly sessionId: Id }
  | { readonly kind: "run"; readonly sessionId: Id; readonly runId: Id }
  | { readonly kind: "plugin"; readonly pluginId: Id };
