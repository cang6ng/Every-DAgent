/**
 * The presentation store: one immutable snapshot, published only when it
 * changed, and one notification per change.
 *
 * The state is small on purpose, and every part of it is a different kind of
 * fact. `description` is what the host says it is; `presentation` is the bounded
 * directory the host published — a window, not a database; `live` is the drafts
 * of runs still executing, which are display state and never history; `history`
 * is what this client has actually read of each session's committed
 * `history` is what this client has actually read of each session's committed
 * conversation, with its gaps left visible; `settings` is the configuration
 * this client has read, with what it has only been *told* about marked stale.
 * `getSnapshot()` returns the same object until a real change happens, and
 * `subscribe` hears about each change exactly once.
 */

import type {
  ActiveRunSnapshot,
  HostDescription,
  HostSnapshot,
  Id,
  ToolApprovalDecision,
} from "@every-dagent/protocol";

import type { HistoryMap } from "./fold.js";
import type { ClientError } from "./errors.js";
import { EMPTY_SETTINGS, type SettingsMap } from "./settings.js";

/** Where this client's connection is. `connected` is not `ready`. */
export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "syncing"
  | "ready"
  | "lost"
  | "protocol-error";

/**
 * Which host the retained presentation came from.
 *
 * `unconfirmed` means a new connection has not described itself yet, so the old
 * presentation is still displayed but is not claimed to be current;
 * `previous` means the new connection reaches a *different* host instance, and
 * the old presentation is not this host's state at all.
 */
export type PresentationHost = "none" | "unconfirmed" | "current" | "previous";

export type LiveMap = Readonly<Record<Id, ActiveRunSnapshot>>;

/**
 * What this client has done with the approval delivery it was handed.
 *
 * It is deliberately *local* state, and separate from the Host's business
 * snapshot: `sent` means an answer left this client and the Host has not said
 * anything since — never that the execution was approved. Only the Host's own
 * `approval.updated` (and the business snapshot it folds into) says what was
 * decided, and a client that showed "approved" because it sent an approval
 * would be showing its own wish.
 */
export type ApprovalReplyState =
  | { readonly state: "none" }
  | {
      readonly state: "pending";
      readonly requestId: Id;
      readonly approvalId: Id;
      readonly executionId: Id;
    }
  | {
      readonly state: "sent";
      readonly approvalId: Id;
      readonly executionId: Id;
      readonly decision: ToolApprovalDecision;
    }
  | { readonly state: "closed"; readonly approvalId: Id; readonly executionId: Id }
  | { readonly state: "failed"; readonly approvalId: Id; readonly executionId: Id };

export const NO_APPROVAL_REPLY: ApprovalReplyState = Object.freeze({ state: "none" });

/** Everything a reader may see about this client. Frozen, and replaced whole. */
export interface ClientSnapshot {
  readonly status: ConnectionStatus;
  readonly description: HostDescription | null;
  readonly presentation: HostSnapshot | null;
  readonly presentationHost: PresentationHost;
  /** The live timelines of runs this connection watched start. Never history. */
  readonly live: LiveMap;
  /** What has been loaded of each session's committed history, gaps included. */
  readonly history: HistoryMap;
  /**
   * The configuration namespaces this client has read, and what it knows about
   * the ones it has only heard about. A cache, bounded and explicitly stale
   * when it may be: nothing here is a claim about a host it is not talking to.
   */
  readonly settings: SettingsMap;
  /**
   * What this client has done with the approval delivery it holds.
   *
   * `pending` is the only state in which a caller may answer: it means a
   * `tool.approval` request is outstanding on the current stream and no answer
   * has left this client yet.
   */
  readonly approvalReply: ApprovalReplyState;
  /**
   * Whether a caller may answer the current approval *from here*.
   *
   * The Host's `canRespond` is necessary and not sufficient: this flag also
   * requires a synchronized, current connection with an outstanding delivery.
   * A client whose delivery ended — a disconnect, a replaced stream, a
   * reconnected host — shows this false while the Host's business snapshot may
   * still say `pending`.
   */
  readonly approvalCanRespond: boolean;
  /** True while the presentation is retained but no longer live. */
  readonly stale: boolean;
  /** The last terminal error — a protocol violation or a lost connection. */
  readonly error: ClientError | null;
}

export interface PresentationStore {
  get(): ClientSnapshot;
  /** Applies only fields that are present, and publishes only if one actually differs. */
  update(patch: Partial<ClientSnapshot>): void;
  subscribe(listener: () => void): () => void;
}

function merge(current: ClientSnapshot, patch: Partial<ClientSnapshot>): ClientSnapshot {
  const merged = {
    status: patch.status ?? current.status,
    description: patch.description !== undefined ? patch.description : current.description,
    presentation: patch.presentation !== undefined ? patch.presentation : current.presentation,
    presentationHost: patch.presentationHost ?? current.presentationHost,
    live: patch.live !== undefined ? patch.live : current.live,
    history: patch.history !== undefined ? patch.history : current.history,
    settings: patch.settings !== undefined ? patch.settings : current.settings,
    approvalReply: patch.approvalReply ?? current.approvalReply,
    stale: patch.stale ?? current.stale,
    error: patch.error !== undefined ? patch.error : current.error,
  };
  return Object.freeze({ ...merged, approvalCanRespond: canRespondFrom(merged) });
}

/**
 * The one place the two halves of "may answer" are combined.
 *
 * It is derived, never stored from a patch: every input is a fact about the
 * connection or the folded presentation, and a flag a caller could set would
 * be a client claiming a capability it does not have.
 */
function canRespondFrom(snapshot: {
  readonly status: ConnectionStatus;
  readonly presentation: HostSnapshot | null;
  readonly presentationHost: PresentationHost;
  readonly approvalReply: ApprovalReplyState;
  readonly stale: boolean;
}): boolean {
  if (snapshot.status !== "ready" || snapshot.stale) return false;
  if (snapshot.presentationHost !== "current") return false;
  const approval = snapshot.presentation?.approval;
  if (approval === undefined || approval === null || !approval.canRespond) return false;
  if (snapshot.approvalReply.state !== "pending") return false;
  return (
    snapshot.approvalReply.approvalId === approval.approvalId &&
    snapshot.approvalReply.executionId === approval.executionId
  );
}

function differs(current: ClientSnapshot, next: ClientSnapshot): boolean {
  return (
    current.status !== next.status ||
    current.description !== next.description ||
    current.presentation !== next.presentation ||
    current.presentationHost !== next.presentationHost ||
    current.live !== next.live ||
    current.history !== next.history ||
    current.settings !== next.settings ||
    current.approvalReply !== next.approvalReply ||
    current.approvalCanRespond !== next.approvalCanRespond ||
    current.stale !== next.stale ||
    current.error !== next.error
  );
}

export function createStore(): PresentationStore {
  let state: ClientSnapshot = Object.freeze({
    status: "disconnected",
    description: null,
    presentation: null,
    presentationHost: "none",
    live: Object.freeze({}),
    history: Object.freeze({}),
    settings: EMPTY_SETTINGS,
    approvalReply: NO_APPROVAL_REPLY,
    approvalCanRespond: false,
    stale: false,
    error: null,
  });
  let listeners: (() => void)[] = [];

  return {
    get: (): ClientSnapshot => state,

    update(patch: Partial<ClientSnapshot>): void {
      const next = merge(state, patch);
      if (!differs(state, next)) return;
      state = next;

      // A listener is foreign code: one that throws must not stop the others,
      // and must never be mistaken for a protocol fault.
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // Deliberately swallowed: the client's state is already consistent.
        }
      }
    },

    subscribe(listener: () => void): () => void {
      listeners.push(listener);
      return (): void => {
        listeners = listeners.filter((candidate) => candidate !== listener);
      };
    },
  };
}
