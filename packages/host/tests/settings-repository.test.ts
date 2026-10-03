/**
 * The durable configuration store (schema 3): initialization, CAS and the
 * plugin intent.
 *
 * These are the storage-level facts the M3 configuration surface stands on, so
 * they are checked at the storage level: one transaction per write, a revision
 * that only moves forward, a conflict that writes nothing, an initialization
 * that never overwrites, and a lost COMMIT receipt that is answered from the
 * batch's own evidence rather than from a guess.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  CommitOutcomeUnknownError,
  CorruptRecordError,
  openRepository,
  SCHEMA_VERSION,
  StorageOpenError,
  type Repository,
} from "../src/repository.js";

const LIMITS = { maxRecordBytes: 64 * 1024 };

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-m3-store-"));
  try {
    return await act(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A store still held by a host that failed the test is not the failure.
    }
  }
}

/**
 * A store written the way the previous build wrote one: the version-1 tables
 * plus the version-2 owner binding, recorded as schema 2.
 */
function writeV2Store(path: string): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, title TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      metadata_revision INTEGER NOT NULL, history_revision INTEGER NOT NULL,
      committed_seq INTEGER NOT NULL, status TEXT NOT NULL, blocked_reason TEXT, active_run_id TEXT
    );
    CREATE TABLE deleted_sessions (session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, deleted_at INTEGER NOT NULL);
    CREATE TABLE session_events (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, turn_id TEXT NOT NULL, type TEXT NOT NULL, time INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE turns (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL, reason TEXT NOT NULL,
      run_id TEXT, PRIMARY KEY (session_id, turn_id)
    );
    CREATE INDEX turns_by_start ON turns (session_id, start_seq DESC);
    CREATE UNIQUE INDEX turns_by_owner ON turns (run_id) WHERE run_id IS NOT NULL;
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, session_id TEXT NOT NULL, text TEXT NOT NULL,
      accepted_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, host_instance_id TEXT NOT NULL,
      status TEXT NOT NULL, end_reason TEXT, error_code TEXT, execution_knowledge TEXT, turn_id TEXT,
      cancel_requested INTEGER NOT NULL, committed_from_seq INTEGER, committed_to_seq INTEGER
    );
    CREATE INDEX runs_by_session ON runs (session_id, accepted_at DESC, run_id DESC);
    CREATE TABLE submissions (
      submission_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      run_id TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE collections (name TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    INSERT INTO collections (name, revision) VALUES ('sessions', 0), ('runs', 0), ('plugins', 0);
  `);
  database.prepare("INSERT INTO meta (key, value) VALUES ('storageId', ?)").run("legacy-storage");
  database
    .prepare(
      `INSERT INTO sessions (session_id, generation, title, created_at, updated_at, metadata_revision,
         history_revision, committed_seq, status, blocked_reason, active_run_id)
       VALUES ('s-legacy', 1, 'legacy', 1, 1, 0, 0, 0, 'ready', NULL, NULL)`,
    )
    .run();
  database.exec("PRAGMA user_version = 2");
  database.close();
}

/** One namespace row, exactly as a client-visible update would leave it. */
function namespaceInput(namespace: string, value: unknown, schemaVersion = 1) {
  return { namespace, schemaVersion, valueJson: JSON.stringify(value) };
}

function storedValue(repository: Repository, namespace: string): unknown {
  const record = repository.getSettingsNamespace(namespace);
  return record === undefined ? undefined : (JSON.parse(record.valueJson) as unknown);
}

describe("schema 3 and the configuration a store starts with", () => {
  it("a fresh store records the new schema and holds no configuration", async () => {
    await withTempDir((dir) => {
      const repository = openRepository({ location: join(dir, "state.db"), limits: LIMITS });
      expect(repository.schemaVersion).toBe(SCHEMA_VERSION);
      expect(repository.getSettingsNamespace("host")).toBeUndefined();
      expect(repository.getSettingsNamespace("model")).toBeUndefined();
      expect(repository.getPluginIntent("calculator")).toBeUndefined();
      repository.close();
    });
  });

  it("the ephemeral carrier is the same store, only shorter-lived", () => {
    const ephemeral = openRepository({ location: ":memory:", limits: LIMITS });
    expect(ephemeral.retention).toBe("ephemeral");
    expect(ephemeral.schemaVersion).toBe(SCHEMA_VERSION);
    ephemeral.initializeConfiguration({
      at: 5,
      namespaces: [namespaceInput("host", { systemPrompt: "" })],
      pluginIntents: [{ pluginId: "calculator", desiredEnabled: false }],
    });
    expect(storedValue(ephemeral, "host")).toEqual({ systemPrompt: "" });
    expect(ephemeral.getPluginIntent("calculator")?.desiredEnabled).toBe(false);

    const update = ephemeral.updateSettingsNamespace({
      ...namespaceInput("host", { systemPrompt: "ephemeral" }),
      expectedRevision: 1,
      at: 6,
    });
    expect(update.kind).toBe("updated");
    expect(storedValue(ephemeral, "host")).toEqual({ systemPrompt: "ephemeral" });
    ephemeral.close();
  });

  it("migrates a schema-2 store to 3 without inventing a configuration", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "legacy.db");
      writeV2Store(path);

      const repository = openRepository({ location: path, limits: LIMITS });
      expect(repository.schemaVersion).toBe(SCHEMA_VERSION);
      // The migration added the tables and nothing else: no namespace was
      // seeded, and no plugin's intent was imagined on its behalf.
      expect(repository.getSettingsNamespace("host")).toBeUndefined();
      expect(repository.getSettingsNamespace("model")).toBeUndefined();
      expect(repository.getPluginIntent("calculator")).toBeUndefined();
      // The facts the old build wrote are exactly as they were.
      expect(repository.getSession("s-legacy")?.title).toBe("legacy");
      repository.close();

      // And the configuration surface works on the migrated store in the very
      // next step, which is what "the migration is complete" has to mean.
      const reopened = openRepository({ location: path, limits: LIMITS });
      reopened.initializeConfiguration({
        at: 9,
        namespaces: [namespaceInput("host", { systemPrompt: "migrated" })],
        pluginIntents: [],
      });
      expect(storedValue(reopened, "host")).toEqual({ systemPrompt: "migrated" });
      reopened.close();
    });
  });

  it("a migration that cannot finish leaves the store exactly where it was", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "legacy.db");
      writeV2Store(path);
      // A table already occupying the name the migration needs: the migration
      // cannot run, and what it must not do is advance the version or leave
      // half of its own schema behind.
      const before = new DatabaseSync(path);
      before.exec("CREATE TABLE settings_namespaces (foreign_layout TEXT NOT NULL)");
      before.close();

      expect(() => openRepository({ location: path, limits: LIMITS })).toThrow(StorageOpenError);

      const after = new DatabaseSync(path);
      const version = after.prepare("PRAGMA user_version").get() as { readonly user_version?: number };
      expect(version.user_version).toBe(2);
      const tables = after
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { readonly name?: string }[];
      expect(tables.map((row) => row.name)).not.toContain("plugin_intents");
      expect(tables.map((row) => row.name)).toContain("sessions");
      const row = after.prepare("SELECT foreign_layout FROM settings_namespaces").all();
      expect(row).toEqual([]);
      after.close();
    });
  });
});

describe("initialization", () => {
  it("writes one configuration atomically and never overwrites it", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    repository.initializeConfiguration({
      at: 10,
      namespaces: [
        namespaceInput("host", { systemPrompt: "first", loop: { maxSteps: 4, maxModelAttempts: 2 } }),
        namespaceInput("model", { provider: "test", model: "test-model" }, 1),
      ],
      pluginIntents: [{ pluginId: "calculator", desiredEnabled: false }],
    });

    const host = repository.getSettingsNamespace("host");
    expect(host?.revision).toBe(1);
    expect(host?.schemaVersion).toBe(1);
    expect(host?.updatedAt).toBe(10);
    expect(storedValue(repository, "host")).toEqual({
      systemPrompt: "first",
      loop: { maxSteps: 4, maxModelAttempts: 2 },
    });

    // A second initialization is a refusal, and the stored intent is the first
    // one — never the later offer.
    expect(() =>
      repository.initializeConfiguration({
        at: 11,
        namespaces: [namespaceInput("host", { systemPrompt: "second" })],
        pluginIntents: [{ pluginId: "calculator", desiredEnabled: true }],
      }),
    ).toThrow(StorageOpenError);
    expect(storedValue(repository, "host")).toEqual({
      systemPrompt: "first",
      loop: { maxSteps: 4, maxModelAttempts: 2 },
    });
    expect(repository.getPluginIntent("calculator")?.desiredEnabled).toBe(false);
    expect(repository.getSettingsNamespace("host")?.revision).toBe(1);
    repository.close();
  });

  it("a batch whose rows are not all absent writes none of them", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    repository.initializeConfiguration({
      at: 10,
      namespaces: [namespaceInput("host", { systemPrompt: "first" })],
      pluginIntents: [],
    });

    expect(() =>
      repository.initializeConfiguration({
        at: 11,
        namespaces: [namespaceInput("model", { provider: "test", model: "m" }), namespaceInput("host", { systemPrompt: "x" })],
        pluginIntents: [{ pluginId: "calculator", desiredEnabled: false }],
      }),
    ).toThrow(StorageOpenError);

    // Nothing from the refused batch: no model namespace, no plugin intent.
    expect(repository.getSettingsNamespace("model")).toBeUndefined();
    expect(repository.getPluginIntent("calculator")).toBeUndefined();
    repository.close();
  });

  it("refuses a namespace this build does not write, and a value past the profile bound", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    expect(() =>
      repository.initializeConfiguration({
        at: 1,
        namespaces: [namespaceInput("Host", { systemPrompt: "" })],
        pluginIntents: [],
      }),
    ).toThrow(StorageOpenError);
    expect(() =>
      repository.initializeConfiguration({
        at: 1,
        namespaces: [namespaceInput("plugin:Not-A-Plugin", {})],
        pluginIntents: [],
      }),
    ).toThrow(StorageOpenError);
    expect(() =>
      repository.initializeConfiguration({
        at: 1,
        namespaces: [namespaceInput("host", "x".repeat(20 * 1024))],
        pluginIntents: [],
      }),
    ).toThrow(StorageOpenError);
    expect(() => repository.getSettingsNamespace("Host")).toThrow(StorageOpenError);
    expect(() => repository.getPluginIntent("Bad Id")).toThrow(StorageOpenError);
    repository.close();
  });
});

describe("compare-and-set", () => {
  it("advances one revision per write and refuses a stale expectation with zero write", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    repository.initializeConfiguration({
      at: 1,
      namespaces: [namespaceInput("host", { systemPrompt: "a" })],
      pluginIntents: [],
    });

    const first = repository.updateSettingsNamespace({
      ...namespaceInput("host", { systemPrompt: "b" }),
      expectedRevision: 1,
      at: 2,
    });
    expect(first.kind).toBe("updated");
    if (first.kind !== "updated") throw new Error("unreachable");
    expect(first.record.revision).toBe(2);
    expect(storedValue(repository, "host")).toEqual({ systemPrompt: "b" });

    const stale = repository.updateSettingsNamespace({
      ...namespaceInput("host", { systemPrompt: "c" }),
      expectedRevision: 1,
      at: 3,
    });
    expect(stale.kind).toBe("revision-conflict");
    if (stale.kind !== "revision-conflict") throw new Error("unreachable");
    expect(stale.record.revision).toBe(2);
    // Zero write: the value is the one the accepted update wrote.
    expect(storedValue(repository, "host")).toEqual({ systemPrompt: "b" });
    expect(repository.getSettingsNamespace("host")?.revision).toBe(2);

    const missing = repository.updateSettingsNamespace({
      ...namespaceInput("model", { provider: "test", model: "m" }),
      expectedRevision: 1,
      at: 4,
    });
    expect(missing.kind).toBe("not-found");
    expect(repository.getSettingsNamespace("model")).toBeUndefined();
    repository.close();
  });

  it("namespaces do not share a revision: one moving does not conflict another", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    repository.initializeConfiguration({
      at: 1,
      namespaces: [namespaceInput("host", { systemPrompt: "a" }), namespaceInput("model", { provider: "p", model: "m" })],
      pluginIntents: [],
    });

    expect(
      repository.updateSettingsNamespace({
        ...namespaceInput("host", { systemPrompt: "b" }),
        expectedRevision: 1,
        at: 2,
      }).kind,
    ).toBe("updated");
    // The model namespace never moved, so its revision is still the one it was
    // initialized with — a client holding it is not stale.
    expect(repository.getSettingsNamespace("model")?.revision).toBe(1);
    expect(
      repository.updateSettingsNamespace({
        ...namespaceInput("model", { provider: "p2", model: "m" }),
        expectedRevision: 1,
        at: 3,
      }).kind,
    ).toBe("updated");
    repository.close();
  });

  it("a revision at the safe-integer ceiling fails closed", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    repository.initializeConfiguration({
      at: 1,
      namespaces: [namespaceInput("host", { systemPrompt: "a" })],
      pluginIntents: [],
    });
    // The ceiling itself, written the way only a different build could have.
    (
      repository as unknown as { database: DatabaseSync }
    ).database
      .prepare("UPDATE settings_namespaces SET revision = ? WHERE namespace = 'host'")
      .run(Number.MAX_SAFE_INTEGER);

    expect(() =>
      repository.updateSettingsNamespace({
        ...namespaceInput("host", { systemPrompt: "b" }),
        expectedRevision: Number.MAX_SAFE_INTEGER,
        at: 2,
      }),
    ).toThrow(StorageOpenError);
    expect(repository.getSettingsNamespace("host")?.revision).toBe(Number.MAX_SAFE_INTEGER);
    repository.close();
  });

  it("a settings row this build did not write is refused, not repaired", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    const database = (repository as unknown as { database: DatabaseSync }).database;
    database.exec("DROP TABLE settings_namespaces");
    database.exec(
      `CREATE TABLE settings_namespaces (
         namespace TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, revision INTEGER NOT NULL,
         value_json TEXT NOT NULL, updated_at INTEGER NOT NULL
       )`,
    );
    database
      .prepare("INSERT INTO settings_namespaces VALUES ('host', 0, 1, '{}', 1)")
      .run();
    expect(() => repository.getSettingsNamespace("host")).toThrow(CorruptRecordError);
    repository.close();
  });
});

describe("commit evidence", () => {
  /**
   * Interferes with the next COMMIT so the batch lands for real and the caller
   * still sees an error — the lost receipt the store's own evidence has to
   * reconcile. `damage` runs after the commit and before the error, so the
   * evidence can be made to disagree with itself.
   */
  function loseNextCommit(damage?: (database: DatabaseSync) => void): { injected(): number; restore(): void } {
    const originalExec = DatabaseSync.prototype.exec;
    const originalPrepare = DatabaseSync.prototype.prepare;
    let armed = false;
    let fired = 0;

    DatabaseSync.prototype.prepare = function patchedPrepare(this: DatabaseSync, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (sql.startsWith("UPDATE settings_namespaces SET")) armed = true;
      return statement;
    };

    DatabaseSync.prototype.exec = function patchedExec(this: DatabaseSync, sql: string): void {
      if (sql === "COMMIT" && armed && fired === 0) {
        fired += 1;
        armed = false;
        originalExec.call(this, sql);
        damage?.(this);
        throw new Error("injected: the commit receipt was lost");
      }
      originalExec.call(this, sql);
    };

    return {
      injected: () => fired,
      restore: () => {
        DatabaseSync.prototype.exec = originalExec;
        DatabaseSync.prototype.prepare = originalPrepare;
      },
    };
  }

  it("confirms a settings write whose receipt was lost when the batch is there", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    repository.initializeConfiguration({
      at: 1,
      namespaces: [namespaceInput("host", { systemPrompt: "a" })],
      pluginIntents: [],
    });

    const injection = loseNextCommit();
    try {
      const outcome = repository.updateSettingsNamespace({
        ...namespaceInput("host", { systemPrompt: "b" }),
        expectedRevision: 1,
        at: 2,
      });
      expect(injection.injected()).toBe(1);
      expect(outcome.kind).toBe("updated");
      if (outcome.kind !== "updated") throw new Error("unreachable");
      expect(outcome.record.revision).toBe(2);
      expect(storedValue(repository, "host")).toEqual({ systemPrompt: "b" });
    } finally {
      injection.restore();
    }
    repository.close();
  });

  it("asks the store rather than guessing when the evidence disagrees", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    repository.initializeConfiguration({
      at: 1,
      namespaces: [namespaceInput("host", { systemPrompt: "a" })],
      pluginIntents: [],
    });

    const injection = loseNextCommit((database) => {
      // The batch landed, and then somebody rewrote its value: the receipt is
      // lost and the evidence no longer describes this write.
      database
        .prepare("UPDATE settings_namespaces SET value_json = '{\"systemPrompt\":\"tampered\"}' WHERE namespace = 'host'")
        .run();
    });
    try {
      expect(() =>
        repository.updateSettingsNamespace({
          ...namespaceInput("host", { systemPrompt: "b" }),
          expectedRevision: 1,
          at: 2,
        }),
      ).toThrow(CommitOutcomeUnknownError);
    } finally {
      injection.restore();
    }
    repository.close();
  });
});

describe("plugin intent", () => {
  it("records a desired-enabled intent idempotently and reads it back", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    const enabled = repository.setPluginDesiredEnabled({ pluginId: "calculator", desiredEnabled: true, at: 3 });
    expect(enabled).toEqual({ pluginId: "calculator", desiredEnabled: true, updatedAt: 3 });

    const again = repository.setPluginDesiredEnabled({ pluginId: "calculator", desiredEnabled: true, at: 4 });
    expect(again.desiredEnabled).toBe(true);
    expect(again.updatedAt).toBe(4);

    const disabled = repository.setPluginDesiredEnabled({ pluginId: "calculator", desiredEnabled: false, at: 5 });
    expect(disabled.desiredEnabled).toBe(false);
    expect(repository.getPluginIntent("calculator")?.desiredEnabled).toBe(false);
    expect(repository.getPluginIntent("other")).toBeUndefined();
    repository.close();
  });

  it("confirms a lost intent receipt from the store's own row", () => {
    const repository = openRepository({ location: ":memory:", limits: LIMITS });
    const originalExec = DatabaseSync.prototype.exec;
    const originalPrepare = DatabaseSync.prototype.prepare;
    let fired = 0;
    DatabaseSync.prototype.prepare = function patchedPrepare(this: DatabaseSync, sql: string) {
      const statement = originalPrepare.call(this, sql);
      return statement;
    };
    DatabaseSync.prototype.exec = function patchedExec(this: DatabaseSync, sql: string): void {
      if (sql === "COMMIT" && fired === 0) {
        fired += 1;
        originalExec.call(this, sql);
        throw new Error("injected: the commit receipt was lost");
      }
      originalExec.call(this, sql);
    };

    try {
      const record = repository.setPluginDesiredEnabled({ pluginId: "calculator", desiredEnabled: true, at: 7 });
      expect(fired).toBe(1);
      expect(record.desiredEnabled).toBe(true);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.prepare = originalPrepare;
    }
    repository.close();
  });
});
