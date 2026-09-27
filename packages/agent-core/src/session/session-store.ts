import { restoreSession } from "./session.js";
import type { Session } from "./session.js";
import type { SessionEvent } from "./session-event.js";

/**
 * Where a session's log is kept outside the Session.
 *
 * The store is the host's business, not the Core's: the AgentLoop and the
 * AgentRuntime never see one, and `Session` does not know it exists. That is what
 * keeps a storage failure out of a turn's outcome — a host flushes the events a turn
 * added once the turn is over, and decides for itself what to do if the flush fails.
 *
 * Every method is asynchronous because a real store does I/O; the in-memory one
 * exists to run the same seam without a file.
 */
export interface SessionStore {
  /** Declares a session. Declaring an id twice is a programming error. */
  create(sessionId: string): Promise<void>;
  /** The session as it was recorded, or null when this store never saw the id. */
  load(sessionId: string): Promise<Session | null>;
  /**
   * Appends the events that continue the stored log.
   *
   * Strictly append-only: an event that is not the next one means the caller has lost
   * track of what it stored, which is its own bug to fix rather than something to
   * paper over here. Either the whole batch is accepted or none of it is.
   */
  append(sessionId: string, events: readonly SessionEvent[]): Promise<void>;
}

export function createMemorySessionStore(): SessionStore {
  return new MemorySessionStore();
}

class MemorySessionStore implements SessionStore {
  private readonly logs = new Map<string, SessionEvent[]>();

  async create(sessionId: string): Promise<void> {
    if (this.logs.has(sessionId)) {
      throw new Error(`session "${sessionId}" is already in this store`);
    }
    this.logs.set(sessionId, []);
  }

  async load(sessionId: string): Promise<Session | null> {
    const log = this.logs.get(sessionId);
    if (log === undefined) return null;

    // Restored from a fresh array, so a loaded session appending to its own log
    // cannot write through to this store. What the events themselves share is the
    // Core's usual shallow boundary: their envelopes and top-level `data` are copied,
    // nested payloads (a tool call's `input`) stay by reference.
    return restoreSession(sessionId, [...log]);
  }

  async append(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    const log = this.logs.get(sessionId);
    if (log === undefined) {
      throw new Error(`unknown session "${sessionId}"`);
    }

    // Checked before anything is stored: a batch the caller lost track of must not be
    // half-applied, or it could not be retried after the caller works out where it is.
    for (const [offset, event] of events.entries()) {
      if (event.seq !== log.length + offset) {
        throw new Error(
          `session "${sessionId}" holds ${log.length} events: seq ${event.seq} does not continue it`,
        );
      }
    }

    log.push(...events);
  }
}
