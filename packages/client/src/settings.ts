/**
 * The settings replica: the namespace values this client has read, and what it
 * knows about the ones it has not.
 *
 * It is a cache and it says so. A namespace enters it when a client *reads* it
 * — a `settings.get` or a `settings.update` answer — and a `settings.updated`
 * event only ever marks what is held as possibly stale and records the revision
 * the host announced. No value is ever built out of an event: an event is a
 * bounded invalidation, and a client that turned one into a value would be
 * showing something the host never said.
 *
 * Two rules keep the replica honest across a flaky connection.
 *
 * Reads are monotone. A late answer for a revision the client has already moved
 * past is answered to whoever asked and never filed, because filing it would
 * make the replica serve a value for a revision it no longer claims.
 *
 * Effective state belongs to one host instance. The cache records the instance
 * it came from, and a connection to a *different* instance drops it: another
 * host's effective revision and value are not this host's facts, and a
 * retained one would be a claim about a process that no longer exists.
 */

import type { HostEvent, SettingsSnapshot } from "@every-dagent/protocol";

/**
 * How much of the settings surface this client keeps, as the current
 * implementation profile: at most eight namespaces, complete values included.
 * Evicting is always safe — the cache is read on demand and a namespace that
 * fell out is simply read again.
 */
export const SETTINGS_CACHE_LIMITS = Object.freeze({ maxNamespaces: 8 });

/** What the client knows about one namespace. */
export interface SettingsEntry {
  readonly namespace: string;
  readonly desiredRevision: number;
  readonly effectiveRevision: number | null;
  readonly restartRequired: boolean;
  /** The last complete read, or null when only an invalidation has arrived. */
  readonly snapshot: SettingsSnapshot | null;
  /** Whether what is held may no longer be current. */
  readonly stale: boolean;
}

export type SettingsMap = Readonly<Record<string, SettingsEntry>>;

export const EMPTY_SETTINGS: SettingsMap = Object.freeze({});

/**
 * The cache, newest-used last.
 *
 * Insertion order is the recency order for a rebuilt entry, so the object's own
 * key order is the LRU order — and every namespace name this surface uses
 * (`host`, `model`, `plugin:<id>`) is a non-numeric string, which is what keeps
 * that order meaningful in JavaScript.
 */
function bounded(map: SettingsMap, refreshed?: string): SettingsMap {
  const entries = Object.entries(map);
  const ordered = refreshed === undefined ? entries : [...entries.filter(([key]) => key !== refreshed), ...entries.filter(([key]) => key === refreshed)];
  const kept = ordered.slice(Math.max(0, ordered.length - SETTINGS_CACHE_LIMITS.maxNamespaces));
  return Object.freeze(Object.fromEntries(kept));
}

/**
 * Files one complete read.
 *
 * A read whose revision is older than what is already held changes nothing: the
 * caller still receives the host's answer, and the replica keeps the newer fact
 * rather than stepping backwards.
 */
export function applySettingsSnapshot(map: SettingsMap, snapshot: SettingsSnapshot): SettingsMap {
  const existing = map[snapshot.namespace];
  if (existing !== undefined && existing.desiredRevision > snapshot.desiredRevision) return map;

  const entry: SettingsEntry = Object.freeze({
    namespace: snapshot.namespace,
    desiredRevision: snapshot.desiredRevision,
    effectiveRevision: snapshot.effectiveRevision,
    restartRequired: snapshot.restartRequired,
    snapshot: Object.freeze(snapshot),
    stale: false,
  });
  return bounded({ ...map, [snapshot.namespace]: entry }, snapshot.namespace);
}

/**
 * Applies one bounded invalidation.
 *
 * The value held, if any, is kept and marked stale — never replaced by
 * something reconstructed from the event — and the revision and restart flag
 * the host announced are recorded, so a reader can act on "a restart is owed"
 * without reading the namespace again.
 */
export function applySettingsInvalidated(
  map: SettingsMap,
  event: { readonly namespace: string; readonly revision: number; readonly restartRequired: boolean },
): SettingsMap {
  const existing = map[event.namespace];
  if (existing === undefined) {
    const entry: SettingsEntry = Object.freeze({
      namespace: event.namespace,
      desiredRevision: event.revision,
      effectiveRevision: null,
      restartRequired: event.restartRequired,
      snapshot: null,
      stale: true,
    });
    return bounded({ ...map, [event.namespace]: entry }, event.namespace);
  }

  const entry: SettingsEntry = Object.freeze({
    ...existing,
    // A late or duplicate invalidation never walks a revision back.
    desiredRevision: Math.max(existing.desiredRevision, event.revision),
    restartRequired:
      event.revision >= existing.desiredRevision ? event.restartRequired : existing.restartRequired,
    stale: true,
  });
  return bounded({ ...map, [event.namespace]: entry }, event.namespace);
}

/**
 * How one event moves the settings replica.
 *
 * Only one event does: a `settings.updated` invalidation. Everything else —
 * sessions, runs, plugins — is a fact about something else, and folding it here
 * would be inventing a settings change out of an unrelated announcement.
 */
export function foldSettingsEvent(map: SettingsMap, event: HostEvent): SettingsMap {
  if (event.type !== "settings.updated") return map;
  return applySettingsInvalidated(map, event.payload);
}

/** Marks everything held as possibly stale, keeping it: the connection is gone. */
export function markSettingsStale(map: SettingsMap): SettingsMap {
  const entries = Object.entries(map);
  if (entries.length === 0) return map;
  if (entries.every(([, entry]) => entry.stale)) return map;
  return Object.freeze(
    Object.fromEntries(entries.map(([namespace, entry]) => [namespace, Object.freeze({ ...entry, stale: true })])),
  );
}

/** Drops everything: what is held describes a host instance this connection is not talking to. */
export function forgetSettings(): SettingsMap {
  return EMPTY_SETTINGS;
}
