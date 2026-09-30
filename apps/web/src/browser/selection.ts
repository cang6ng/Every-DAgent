/**
 * Which session the shell is looking at, and where that choice is kept.
 *
 * The choice is a pair — a host instance and a session id — and it is stored
 * that way on purpose. A session id alone would survive a reconnect to a
 * different host and silently re-select a session that was never selected;
 * with the instance attached, a selection from another host simply does not
 * resolve, and the shell shows nothing selected rather than something wrong.
 *
 * The storage seam is structural, not the DOM: a `sessionStorage` satisfies it,
 * and so does an object a test hands over, and neither the controller nor this
 * module needs a browser to be type-checked.
 */

export interface SessionSelection {
  readonly hostInstanceId: string;
  readonly sessionId: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SelectionStorage {
  read(): SessionSelection | null;
  write(selection: SessionSelection | null): void;
}

const SELECTION_KEY = "every-dagent.selection";

/** A pair read from storage, or nothing: a half-written record is not a selection. */
function parseSelection(raw: string | null): SessionSelection | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { readonly hostInstanceId?: unknown; readonly sessionId?: unknown };
    if (typeof parsed.hostInstanceId !== "string" || typeof parsed.sessionId !== "string") return null;
    if (parsed.hostInstanceId === "" || parsed.sessionId === "") return null;
    return { hostInstanceId: parsed.hostInstanceId, sessionId: parsed.sessionId };
  } catch {
    return null;
  }
}

/**
 * The selection kept in a web storage area.
 *
 * Storage can refuse to work (a sandboxed document, a privacy mode); when it
 * does, the selection simply does not persist across loads. That is a missing
 * convenience, not an error worth interrupting a user with.
 */
export function selectionStorage(storage: StorageLike): SelectionStorage {
  return {
    read(): SessionSelection | null {
      try {
        return parseSelection(storage.getItem(SELECTION_KEY));
      } catch {
        return null;
      }
    },
    write(selection: SessionSelection | null): void {
      try {
        if (selection === null) {
          storage.removeItem(SELECTION_KEY);
        } else {
          storage.setItem(SELECTION_KEY, JSON.stringify(selection));
        }
      } catch {
        // As above: the selection lives for this page load only.
      }
    },
  };
}

/** An in-memory storage area, for compositions without a browser. */
export function memorySelectionStorage(initial: SessionSelection | null = null): SelectionStorage {
  let current = initial;
  return {
    read: (): SessionSelection | null => current,
    write: (selection: SessionSelection | null): void => {
      current = selection;
    },
  };
}
