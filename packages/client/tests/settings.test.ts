/**
 * The settings replica: bounded, monotone, and honest about what it does not
 * have.
 *
 * The client's half of M3 is a cache with three rules, and each of them is
 * checked here against a scripted host: a read files what the host answered, an
 * invalidation marks what is held as stale without inventing a value, and a
 * connection to a different host instance drops what the previous one said.
 */

import { describe, expect, it } from "vitest";

import type { SettingsSnapshot } from "@every-dagent/protocol";

import {
  EMPTY_SETTINGS,
  SETTINGS_CACHE_LIMITS,
  applySettingsInvalidated,
  applySettingsSnapshot,
  forgetSettings,
  markSettingsStale,
  type SettingsMap,
} from "../src/settings.js";

function snapshot(namespace: string, response: number, effective = response): SettingsSnapshot {
  return {
    namespace,
    desiredRevision: response,
    effectiveRevision: effective,
    restartRequired: response !== effective,
    desiredValue: { value: `desired-${response}` },
    effectiveValue: { value: `effective-${effective}` },
  };
}

describe("what a read files", () => {
  it("keeps the value, the revisions, and no staleness", () => {
    const map = applySettingsSnapshot(EMPTY_SETTINGS, snapshot("host", 1));
    expect(map["host"]?.desiredRevision).toBe(1);
    expect(map["host"]?.effectiveRevision).toBe(1);
    expect(map["host"]?.restartRequired).toBe(false);
    expect(map["host"]?.stale).toBe(false);
    expect(map["host"]?.snapshot?.desiredValue).toEqual({ value: "desired-1" });
  });

  it("does not step backwards for a late answer", () => {
    const afterRead = applySettingsSnapshot(EMPTY_SETTINGS, snapshot("host", 3));
    const late = applySettingsSnapshot(afterRead, snapshot("host", 2));
    // The same object: a replica that had moved on is not walked back by an
    // answer to a question that was asked earlier.
    expect(late).toBe(afterRead);
    expect(late["host"]?.desiredRevision).toBe(3);
    expect(late["host"]?.snapshot?.desiredValue).toEqual({ value: "desired-3" });
  });

  it("keeps at most the profile's namespaces, oldest first out", () => {
    let map: SettingsMap = EMPTY_SETTINGS;
    for (let index = 0; index < SETTINGS_CACHE_LIMITS.maxNamespaces + 3; index += 1) {
      map = applySettingsSnapshot(map, snapshot(`plugin:p${index}`, 1));
    }
    expect(Object.keys(map)).toHaveLength(SETTINGS_CACHE_LIMITS.maxNamespaces);
    // The three oldest are the ones that fell out; the newest is here.
    expect(map["plugin:p0"]).toBeUndefined();
    expect(map["plugin:p2"]).toBeUndefined();
    expect(map["plugin:p3"]).toBeDefined();
    expect(map[`plugin:p${SETTINGS_CACHE_LIMITS.maxNamespaces + 2}`]).toBeDefined();
  });

  it("re-reading an old namespace evicts the least recently read", () => {
    let map: SettingsMap = EMPTY_SETTINGS;
    for (let index = 0; index < SETTINGS_CACHE_LIMITS.maxNamespaces; index += 1) {
      map = applySettingsSnapshot(map, snapshot(`plugin:p${index}`, 1));
    }
    // Touch the oldest, then add one: the *second* oldest is the one that goes.
    map = applySettingsSnapshot(map, snapshot("plugin:p0", 2));
    map = applySettingsSnapshot(map, snapshot("plugin:fresh", 1));

    expect(map["plugin:p0"]?.desiredRevision).toBe(2);
    expect(map["plugin:p1"]).toBeUndefined();
    expect(map["plugin:fresh"]).toBeDefined();
  });
});

describe("what an invalidation does", () => {
  it("marks what is held stale and records the announced revisions", () => {
    const read = applySettingsSnapshot(EMPTY_SETTINGS, snapshot("host", 1));
    const after = applySettingsInvalidated(read, { namespace: "host", revision: 2, restartRequired: true });

    expect(after["host"]?.stale).toBe(true);
    expect(after["host"]?.desiredRevision).toBe(2);
    expect(after["host"]?.restartRequired).toBe(true);
    // The value is exactly what was read; nothing was rebuilt from the event.
    expect(after["host"]?.snapshot).toBe(read["host"]?.snapshot);
  });

  it("records a namespace it has never read, without inventing a value", () => {
    const after = applySettingsInvalidated(EMPTY_SETTINGS, {
      namespace: "plugin:p",
      revision: 4,
      restartRequired: true,
    });
    expect(after["plugin:p"]?.snapshot).toBeNull();
    expect(after["plugin:p"]?.stale).toBe(true);
    expect(after["plugin:p"]?.desiredRevision).toBe(4);
    expect(after["plugin:p"]?.restartRequired).toBe(true);
  });

  it("never walks a revision backwards on a late invalidation", () => {
    const read = applySettingsSnapshot(EMPTY_SETTINGS, snapshot("host", 5, 5));
    const late = applySettingsInvalidated(read, { namespace: "host", revision: 3, restartRequired: false });
    expect(late["host"]?.desiredRevision).toBe(5);
    expect(late["host"]?.restartRequired).toBe(false);
    expect(late["host"]?.stale).toBe(true);
  });

  it("bounds the map the same way a read does", () => {
    let map: SettingsMap = EMPTY_SETTINGS;
    for (let index = 0; index < SETTINGS_CACHE_LIMITS.maxNamespaces + 2; index += 1) {
      map = applySettingsInvalidated(map, { namespace: `plugin:p${index}`, revision: 1, restartRequired: false });
    }
    expect(Object.keys(map)).toHaveLength(SETTINGS_CACHE_LIMITS.maxNamespaces);
  });
});

describe("what a connection change does", () => {
  it("marks everything stale when the connection goes away", () => {
    const read = applySettingsSnapshot(EMPTY_SETTINGS, snapshot("host", 1));
    const stale = markSettingsStale(read);
    expect(stale["host"]?.stale).toBe(true);
    // The value is kept: it may still be true, and it is not claimed to be.
    expect(stale["host"]?.snapshot).toBe(read["host"]?.snapshot);
    // An empty cache is returned as it is, so nothing is published for nothing.
    expect(markSettingsStale(EMPTY_SETTINGS)).toBe(EMPTY_SETTINGS);
    expect(markSettingsStale(stale)).toBe(stale);
  });

  it("forgets everything for a different host instance", () => {
    const read = applySettingsSnapshot(EMPTY_SETTINGS, snapshot("host", 1));
    expect(forgetSettings()).toBe(EMPTY_SETTINGS);
    // The one that has to be thrown away is the map itself, not the entries:
    // another host's effective revision is not this host's fact.
    expect(Object.keys(forgetSettings())).toHaveLength(0);
    expect(read["host"]).toBeDefined();
  });
});
