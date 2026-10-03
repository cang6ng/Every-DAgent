/**
 * The wire contract's vocabulary, as frozen by `docs/PHASE4_PLATFORM_SPEC.md`.
 *
 * This module is pure types and constants: no validation library, no runtime
 * behaviour, no dependency on any other Every-DAgent package. Everything the
 * validators in `schemas.ts` / `operations.ts` / `events.ts` check must have a
 * declared shape here, so the public contract and the runtime checks cannot
 * drift apart silently.
 *
 * Generation 2 is not a compatible extension of generation 1. A v1 peer is
 * answered UNSUPPORTED_PROTOCOL and never served a downgraded shape: the whole
 * point of the increment is that a session's history is no longer one
 * unbounded array, and a peer that assumed it was cannot be told otherwise
 * halfway through a conversation.
 */

/** The only protocol generation this package speaks. Generation is a wire string, not an npm version. */
export const PROTOCOL_VERSION = "2" as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * The largest protocol frame this package will encode, in UTF-8 bytes.
 *
 * Checked here, on the encoded string, because escaping decides the real size:
 * a payload that fits when measured as characters can exceed the bound once
 * control characters are escaped. The carrier has its own, larger bound and
 * checks that too — neither layer delegates to the other.
 */
export const MAX_FRAME_BYTES = 256 * 1024;

/**
 * The most bytes one request id may occupy, counted as the UTF-8 bytes of the
 * raw string — not its character count, not its UTF-16 code units and not the
 * bytes of its JSON encoding.
 *
 * It exists so a prospective frame check can reserve a request id's worst legal
 * cost instead of guessing: an empty budget would let the 256 KiB frame bound
 * be spent by the id itself, leaving no provable room for the answer. 128 bytes
 * is comfortable for a UUID and for prefixed correlation ids, and small enough
 * that the worst JSON string token a legal id can produce — two bytes of quotes
 * plus six per escaped byte, all of them NUL — stays a small fraction of one
 * frame.
 */
export const MAX_REQUEST_ID_BYTES = 128;

/** The most items one page may carry. Whichever of `MAX_PAGE_ITEMS` / `MAX_PAGE_BYTES` is reached first ends the page. */
export const MAX_PAGE_ITEMS = 50;
/** The most encoded bytes one page payload may occupy. */
export const MAX_PAGE_BYTES = 192 * 1024;

/** A session title is bounded, non-empty text; rename is the only way to set one. */
export const MAX_TITLE_CHARS = 200;

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

/** An optimistic-concurrency revision. Only ever compared, never arithmetic. */
export type Revision = number;

/** A committed log position: the `seq` the next settled event would take. */
export type LogPosition = number;

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
  | "SUBMISSION_RETIRED"
  | "STALE_CURSOR"
  | "REVISION_CONFLICT"
  | "LIMIT_EXCEEDED"
  | "SETTINGS_INVALID"
  | "STORAGE_UNAVAILABLE"
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

/** Where one tool approval stands, as the Host's business state. */
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

/** The only two things a client may answer an approval with. */
export type ToolApprovalDecision = "approve" | "reject";

/**
 * One pending (or just-decided) tool approval, as the current Host authority
 * publishes it.
 *
 * It is a *business* fact: the execution it guards, the call it belongs to,
 * the exact arguments the call will run with, and where that execution's
 * deadline stands. It deliberately carries none of the machinery behind the
 * decision — no executor, no closure, no resolver, no monotonic clock — and no
 * step index or registry/policy generation, because none of those are facts a
 * client could act on.
 *
 * `input` is the exact owned argument value, never a display truncation: an
 * approval a client cannot read in full is an approval it cannot honestly
 * answer, which is why an unrepresentable input fails the call closed instead
 * of being shortened here.
 *
 * `canRespond` is true only while this approval is still the Host's to decide —
 * pending and unexpired. A client must combine it with its own delivery state
 * before offering a choice, because a client that can no longer deliver an
 * answer may not treat the Host's `true` as its own.
 */
export interface ApprovalSnapshot {
  readonly approvalId: Id;
  readonly executionId: Id;
  readonly sessionId: Id;
  readonly runId: Id;
  readonly turnId: Id;
  /** The stable occurrence identity of the call this approval guards. */
  readonly invocationId: Id;
  readonly callId: string;
  readonly name: string;
  readonly input: DisplayInput;
  /** Host clock epoch milliseconds; display only — the Host's own clock decides. */
  readonly deadlineAt: number;
  readonly status: ApprovalStatus;
  readonly canRespond: boolean;
}

/**
 * What a client answers one `tool.approval` request with.
 *
 * The identities are the whole contract: a decision is a statement about one
 * execution, and an answer that names a different approval or execution than
 * the one it arrived with is not a decision this Host will accept. There is no
 * field for modified arguments and no third decision — the host already holds
 * the arguments it prepared, and "maybe" is not a state any execution has.
 */
export interface ToolApprovalResponse {
  readonly approvalId: Id;
  readonly executionId: Id;
  readonly decision: ToolApprovalDecision;
}

/** A plugin lifecycle failure, reduced to safe, enumerable facts. */
export interface PluginFailureSummary {
  readonly operation: "enable" | "disable";
  readonly phase: "permissions" | "activate" | "commit" | "dispose";
  readonly code: "PLUGIN_PERMISSION_DENIED" | "PLUGIN_OPERATION_FAILED";
  readonly message: string;
  readonly cleanupFailureCount: number;
}

/**
 * The plugin as the protocol sees it. A projection, never a `PluginInfo` re-export.
 *
 * Three facts that used to be one are separated here, because a client that
 * cannot tell them apart cannot act honestly: `status` is the *actual* lifecycle
 * of this host instance, `desiredEnabled` is the durable intent that survives a
 * restart, and `restartRequired` is about configuration alone — a pending
 * configuration is not the same thing as a plugin that is off when it was asked
 * to be on.
 */
export interface PluginSummary {
  readonly id: Id;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly permissions: readonly "storage"[];
  /** The actual lifecycle of this host instance. */
  readonly status: "disabled" | "enabling" | "enabled" | "disabling" | "error";
  readonly lastFailure?: PluginFailureSummary;
  /** The durable desired-enabled intent; a restart aims for this, not for `status`. */
  readonly desiredEnabled: boolean;
  /** The desired configuration revision, or null when the plugin has no configuration contract. */
  readonly configRevision: Revision | null;
  /** The configuration revision this instance actually bound, or null. */
  readonly effectiveConfigRevision: Revision | null;
  /**
   * Whether a restart would run a configuration this instance does not.
   *
   * It is derived from the two revisions alone: `desiredEnabled` disagreeing
   * with `status` is not a restart requirement, because a lifecycle change
   * applies without one.
   */
  readonly restartRequired: boolean;
  /**
   * Whether the plugin is not serving what it was asked for: it is in the error
   * state, or its desired intent is enabled and its actual lifecycle is not.
   */
  readonly unavailable: boolean;
}

/** Fields every canonical conversation item carries. */
export interface CanonicalBase {
  /** Stable across restarts and page reloads: the session and log position it was recorded at. */
  readonly id: Id;
  readonly turnId: Id;
  /**
   * The committed log position this item was projected from.
   *
   * It is what makes a page's coverage checkable and a turn fragment
   * recognizable: two items from the same turn carry the same `turnId` and
   * ordered `seq`s, and an item boundary in the middle of a turn is visible as
   * exactly that rather than as a finished conversation.
   */
  readonly seq: LogPosition;
}

/**
 * The published, settled conversation item.
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
      /**
       * The managed execution this call was, when the record carries one.
       * Absent on records written before managed execution existed — which is
       * not corruption, just history that predates the fact.
       */
      readonly executionId?: Id;
    })
  | (CanonicalBase & {
      readonly kind: "tool-result";
      readonly invocationId: Id;
      readonly callId: string;
      readonly name: string;
      readonly ok: boolean;
      readonly content: string;
      readonly executionId?: Id;
      /**
       * Whether the call was dispatched, when the record says. Absent is
       * `unknown`: a record from before this fact existed may describe a run
       * that executed or one that was refused, and nothing here may be read
       * backwards into "no side effect happened".
       */
      readonly disposition?: "executed" | "not-executed";
    });

/**
 * Why a session refuses new work.
 *
 * `unknown-execution` is the conservative one: a run had a durable running
 * marker and no committed terminal, so whether it produced side effects cannot
 * be decided from the record. `host-fault` is the host's own failure to commit
 * a session's outcome safely. Neither is repairable in this phase; a blocked
 * session can still be read, renamed and deleted.
 */
export type BlockedReason = "unknown-execution" | "host-fault";

/**
 * One session's durable identity, metadata and high-water — everything about a
 * session except its conversation.
 *
 * History is deliberately absent: it is read through `sessions.history` pages,
 * because a full array cannot be a bounded read and would make "the whole
 * session" an unprovable claim.
 */
export interface SessionSummary {
  readonly sessionId: Id;
  /** Bumped only by creating a new session; a deleted identity is never reused. */
  readonly generation: number;
  /** Bounded, non-empty display text. Never generated by a model call. */
  readonly title: string;
  /** Host clock epoch milliseconds at creation; never client-provided. */
  readonly createdAt: number;
  /** Host clock epoch milliseconds of the last metadata change; never moves backwards. */
  readonly updatedAt: number;
  readonly status: "ready" | "blocked";
  /** Set exactly when `status` is `blocked`. */
  readonly blockedReason: BlockedReason | null;
  /** Bumped by every change to this summary; the CAS token for rename and delete. */
  readonly metadataRevision: Revision;
  /** Bumped only when a settled turn is appended to canonical history. */
  readonly historyRevision: Revision;
  /** The committed next seq: this session's history high-water. */
  readonly committedSeq: LogPosition;
  /** The one active run, or null. Every terminal run leaves this null. */
  readonly activeRunId: Id | null;
}

export type RunStatus =
  | "accepted"
  | "running"
  | "completed"
  | "limited"
  | "failed"
  | "cancelled"
  | "interrupted";

export type EndReason =
  | "completed"
  | "max_steps"
  | "error"
  | "cancelled"
  | "host_error"
  | "interrupted";

/**
 * What a restart is allowed to say about a run the previous host did not finish.
 *
 * `not-started` is provable: the run was committed as accepted and no running
 * marker was ever committed, so nothing was dispatched. `unknown` is the
 * conservative half — a running marker exists, and the record cannot say
 * whether the execution had produced effects before the process died. It is a
 * statement about evidence, never a claim that a tool ran.
 */
export type ExecutionKnowledge = "not-started" | "unknown";

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
      /**
       * The managed execution this occurrence is. Every call a Host runs has
       * one, and it is what ties this card to an approval and to the canonical
       * record the call will become.
       */
      readonly executionId: Id;
      readonly callId: string;
      readonly name: string;
      readonly input: DisplayInput;
      /** Filled by `run.tool.result`; null while the call is unsettled. */
      readonly result: null | {
        readonly ok: boolean;
        readonly content: string;
        /**
         * Whether the call was dispatched at all. `ok: false` is never a
         * substitute for this: an executed failure and a call the host refused
         * to run are different facts with the same `ok`.
         */
        readonly disposition: "executed" | "not-executed";
      };
    };

/** The tool variant on its own, for events that carry exactly one tool item. */
export type LiveToolItem = Extract<LiveItem, { kind: "tool" }>;

/**
 * A run's durable facts, without any timeline.
 *
 * Timestamps and the execution knowledge are the durable record's own fields:
 * they survive a restart, which is what lets a client tell "accepted three
 * seconds ago on this host" from "accepted before a restart that never
 * started it".
 */
export interface RunBase {
  readonly runId: Id;
  readonly submissionId: Id;
  readonly sessionId: Id;
  /** The accepted original user text, verbatim. */
  readonly text: string;
  /** Core's turn id once observed; null before the turn has produced one, or never. */
  readonly turnId: Id | null;
  readonly cancelRequested: boolean;
  readonly acceptedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

/**
 * A run that still owns the execution lease. `live` is the current timeline,
 * `liveTruncated` says whether the host stopped publishing into it for size —
 * a truncated timeline claims nothing about what it left out.
 */
export type ActiveRunSnapshot = RunBase &
  (
    | {
        readonly status: "accepted";
        readonly endReason: null;
        readonly error: null;
        readonly executionKnowledge: null;
        readonly live: readonly LiveItem[];
        readonly liveTruncated: boolean;
      }
    | {
        readonly status: "running";
        readonly endReason: null;
        readonly error: null;
        readonly executionKnowledge: null;
        readonly live: readonly LiveItem[];
        readonly liveTruncated: boolean;
      }
  );

/**
 * A run whose outcome is final. `live` is always null: drafts never become history.
 *
 * `interrupted` is its own terminal, not a flavour of failure. It means a
 * previous host stopped without committing an outcome, and it carries the
 * evidence class rather than an error code — replacing it with `failed` would
 * claim the run failed, and it may not have.
 */
export type TerminalRunSnapshot = RunBase &
  (
    | {
        readonly status: "completed";
        readonly endReason: "completed";
        readonly error: null;
        readonly executionKnowledge: null;
        readonly live: null;
      }
    | {
        readonly status: "limited";
        readonly endReason: "max_steps";
        readonly error: null;
        readonly executionKnowledge: null;
        readonly live: null;
      }
    | {
        readonly status: "cancelled";
        readonly endReason: "cancelled";
        readonly error: null;
        readonly executionKnowledge: null;
        readonly live: null;
      }
    | {
        readonly status: "failed";
        readonly endReason: "error" | "host_error";
        readonly error: ProtocolError;
        readonly executionKnowledge: null;
        readonly live: null;
      }
    | {
        readonly status: "interrupted";
        readonly endReason: "interrupted";
        readonly error: null;
        readonly executionKnowledge: ExecutionKnowledge;
        readonly live: null;
      }
  );

export type RunSnapshot = ActiveRunSnapshot | TerminalRunSnapshot;

/** The durable half of a run, for listings: the same facts, with no timeline at all. */
export type RunSummary = RunBase & {
  readonly status: RunStatus;
  readonly endReason: EndReason | null;
  readonly error: ProtocolError | null;
  readonly executionKnowledge: ExecutionKnowledge | null;
};

/** Where a subscription's snapshot ends and its event stream begins. */
export interface Watermark {
  readonly streamId: Id;
  readonly sequence: Sequence;
}

/** The storage this host is serving, as it describes itself to a client. */
export interface StorageIdentity {
  readonly storageId: Id;
  /**
   * `durable` survives the process; `ephemeral` is honest about not surviving it.
   * A durable backend that fails never reports `ephemeral` instead.
   */
  readonly retention: "durable" | "ephemeral";
  readonly schemaVersion: number;
}

/**
 * One bounded page of the session directory.
 *
 * `items` is a window, never the whole directory: `hasMore` says another page
 * exists, and `nextCursor` is how to reach it. `collectionRevision` is the
 * version of the directory this page was cut from — a cursor taken under an
 * older revision is refused rather than stitched onto newer facts.
 */
export interface SessionSummaryPage {
  readonly items: readonly SessionSummary[];
  readonly collectionRevision: Revision;
  readonly nextCursor: Id | null;
  readonly hasMore: boolean;
}

/** One bounded page of a session's runs, newest first. */
export interface RunSummaryPage {
  readonly items: readonly RunSummary[];
  readonly collectionRevision: Revision;
  readonly nextCursor: Id | null;
  readonly hasMore: boolean;
}

/** The three collection revisions every catalogue change advances. */
export interface CollectionRevisions {
  readonly sessions: Revision;
  readonly runs: Revision;
  readonly plugins: Revision;
}

/** The half-open committed-log range one history page accounts for. */
export interface HistoryCoverage {
  readonly fromSeq: LogPosition;
  readonly toSeq: LogPosition;
}

/**
 * One bounded page of committed history, read against a fixed fence.
 *
 * The fence is the identity of a traversal: it is the session's committed
 * next seq at the moment the first page was asked for, and it never moves.
 * Turns appended afterwards are simply outside the fence and belong to a later
 * traversal; they never invalidate a cursor, and a page inside the fence always
 * describes the same immutable facts.
 *
 * Items are in log order (ascending `seq`), so a client prepends what it
 * receives. The two boundary flags say whether the page's ends fall on turn
 * boundaries: a page that splits a turn is a fragment and must not be shown as
 * a finished turn, while `atStart`/`atFence` say whether this is where reading
 * stops.
 */
export interface HistoryPage {
  readonly storageId: Id;
  readonly sessionId: Id;
  readonly generation: number;
  readonly historyRevision: Revision;
  readonly fenceSeq: LogPosition;
  readonly direction: "backward";
  readonly items: readonly CanonicalItem[];
  readonly coverage: HistoryCoverage;
  readonly startsAtTurnBoundary: boolean;
  readonly endsAtTurnBoundary: boolean;
  /** True when this page's coverage reaches seq 0. */
  readonly atStart: boolean;
  /** True when this page's coverage reaches the fence. */
  readonly atFence: boolean;
  /** How to read the next older page inside this fence, or null when there is none. */
  readonly nextCursor: Id | null;
}

/**
 * One settings namespace, as a bounded read of its desired and effective state.
 *
 * The two revisions are the whole point: `desiredRevision` is what the store
 * holds and what a client compares against to write, and `effectiveRevision` is
 * what the host instance is actually running — `null` only for a namespace this
 * instance never made effective, which a ready host does not have. They
 * disagree exactly when a restart is pending, and the values are carried whole
 * because this is the one read that is *asked* for a namespace; a snapshot
 * carries only the summary.
 */
export interface SettingsSnapshot {
  readonly namespace: Id;
  readonly desiredRevision: Revision;
  readonly effectiveRevision: Revision | null;
  /** Whether a restart would apply a desired revision this instance does not run. */
  readonly restartRequired: boolean;
  readonly desiredValue: JsonValue;
  readonly effectiveValue: JsonValue | null;
}

/**
 * The fixed, bounded summary of one namespace, for the snapshot every
 * subscriber receives.
 *
 * The values are deliberately absent: a snapshot carries the state a client
 * needs to plan around — which revisions are in force, and whether anything is
 * waiting for a restart — and the values themselves are read on demand through
 * `settings.get`. Nothing here can grow with the size of a setting.
 */
export interface SettingsSummary {
  readonly namespace: Id;
  readonly desiredRevision: Revision;
  readonly effectiveRevision: Revision | null;
  readonly restartRequired: boolean;
}

/**
 * The bounded current state a `subscriptions.open` installs. A cut, not a
 * database: each window says how much of its collection it holds.
 */
export interface HostSnapshot {
  readonly hostInstanceId: Id;
  readonly watermark: Watermark;
  readonly storage: StorageIdentity;
  readonly collections: CollectionRevisions;
  readonly sessions: SessionSummaryPage;
  readonly runs: RunSummaryPage;
  readonly plugins: readonly PluginSummary[];
  /**
   * The host's own two namespaces, fixed in order: `host` then `model`. Plugin
   * configuration is not here — it is plugin state, and it travels in the
   * plugin summaries.
   */
  readonly settings: readonly SettingsSummary[];
  /**
   * The approval the Host is currently holding, or null.
   *
   * At most one: this host runs one execution at a time, and an approval
   * belongs to the execution that is waiting on it. An approval that is not
   * here is not a state a client may invent an answer for.
   */
  readonly approval: ApprovalSnapshot | null;
}

/**
 * A client-side derived view. Never transmitted on its own; `activeRun` must
 * agree with `session.activeRunId` or the client state is inconsistent.
 */
export interface ConversationPresentationSnapshot {
  readonly session: SessionSummary;
  readonly activeRun: RunSnapshot | null;
}

/** The client capabilities a logical connection declares during `host.describe`. */
export interface ClientCapabilities {
  readonly reverseRequests: boolean;
}

/**
 * The host capabilities a Host declares. Only real, tested support may be
 * claimed: a profile this host does not implement is `false`, not absent, so a
 * client can tell "not supported" from "not asked".
 */
export interface HostCapabilities {
  readonly sessions: boolean;
  readonly runs: boolean;
  readonly plugins: boolean;
  readonly subscriptions: boolean;
  readonly reverseRequests: boolean;
  /** Fixed-fence history paging. */
  readonly historyPages: boolean;
  /** `sessions.rename` / `sessions.delete`. */
  readonly sessionMutations: boolean;
  /** Settings reads and CAS updates. */
  readonly settings: boolean;
  /** Tool policy and approval-gated execution. */
  readonly approvals: boolean;
}

/**
 * The safety limits this host actually enforces.
 *
 * Published because they are facts a client has to plan around, not protocol
 * constants: a host with different storage may enforce different numbers. Each
 * one is a per-read, per-write or per-frame bound. None of them is a cap on
 * how much history may accumulate.
 */
export interface HostLimits {
  /** Concurrent runs. `1` in this phase, including a run still waiting to settle. */
  readonly maxActiveRuns: number;
  /** Raw UTF-8 bytes one run's input may occupy, checked before admission. */
  readonly maxInputBytes: number;
  /** Encoded bytes one durable record may occupy. */
  readonly maxRecordBytes: number;
  /** Items one page may carry. */
  readonly maxPageItems: number;
  /** Encoded bytes one page payload may occupy. */
  readonly maxPageBytes: number;
  /** Encoded bytes one protocol frame may occupy. */
  readonly maxFrameBytes: number;
  /** Bytes one connection's outbox may hold before the host gives up on it. */
  readonly maxOutboxBytes: number;
  /** Code units one session title may occupy. */
  readonly maxTitleChars: number;
}

/** The `host.describe` result: identity, agreed generation, capabilities and limits. */
export interface HostDescription {
  readonly protocolVersion: "2";
  readonly hostInstanceId: Id;
  readonly host: { readonly name: string; readonly version: string };
  /** The storage behind this host, stable across restarts of a durable backend. */
  readonly storage: StorageIdentity;
  readonly capabilities: HostCapabilities;
  /** The client capabilities this logical connection was initialized with. */
  readonly clientCapabilities: ClientCapabilities;
  /** Implementation limits, published honestly; none of them caps total history. */
  readonly limits: HostLimits;
}

/** Where an event belongs. Scope ids must agree with the payload's own ids. */
export type EventScope =
  | { readonly kind: "host" }
  | { readonly kind: "session"; readonly sessionId: Id }
  | { readonly kind: "run"; readonly sessionId: Id; readonly runId: Id }
  | { readonly kind: "plugin"; readonly pluginId: Id };
