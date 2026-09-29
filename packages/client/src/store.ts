/**
 * The presentation store: one immutable snapshot, published only when it
 * changed, and one notification per change.
 *
 * The state is small on purpose. It holds the local connection status, the
 * host's description, and the presentation replica the host's snapshot and
 * events build — nothing else, and nothing that a plain operation response is
 * allowed to touch. `getSnapshot()` returns the same object until a real change
 * happens, and `subscribe` hears about each change exactly once.
 */

import type { HostDescription, HostSnapshot } from "@every-dagent/protocol";

import type { ClientError } from "./errors.js";

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

/** Everything a reader may see about this client. Frozen, and replaced whole. */
export interface ClientSnapshot {
  readonly status: ConnectionStatus;
  readonly description: HostDescription | null;
  readonly presentation: HostSnapshot | null;
  readonly presentationHost: PresentationHost;
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
  return Object.freeze({
    status: patch.status ?? current.status,
    description: patch.description !== undefined ? patch.description : current.description,
    presentation: patch.presentation !== undefined ? patch.presentation : current.presentation,
    presentationHost: patch.presentationHost ?? current.presentationHost,
    stale: patch.stale ?? current.stale,
    error: patch.error !== undefined ? patch.error : current.error,
  });
}

function differs(current: ClientSnapshot, next: ClientSnapshot): boolean {
  return (
    current.status !== next.status ||
    current.description !== next.description ||
    current.presentation !== next.presentation ||
    current.presentationHost !== next.presentationHost ||
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
