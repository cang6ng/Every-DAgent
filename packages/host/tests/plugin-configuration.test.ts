/**
 * M3 — durable plugin configuration and intent.
 *
 * The plugin half of the milestone: an intent that survives a restart, a
 * configuration that is validated when it is written and again when it is read,
 * a desired/effective split that a plugin can observe, and the failure
 * behaviour that decides whether the host comes up at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { PluginConfigValue, PluginConfiguration } from "@every-dagent/plugin-system";

import type { Repository } from "../src/repository.js";
import { openRepository } from "../src/repository.js";
import {
  composeTestHost,
  connect,
  constantTool,
  failingPlugin,
  flush,
  scriptedModel,
  testPlugin,
  textReply,
} from "./helpers/harness.js";
import type { ComposedHost } from "../src/host.js";

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-m3-plugins-"));
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

function storePath(dir: string): string {
  return join(dir, "state.db");
}

/** A configuration contract over `{ level: number }`. */
function levelContract(overrides: Partial<PluginConfiguration> = {}): PluginConfiguration {
  return {
    schemaVersion: 1,
    defaultValue: { level: 1 },
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { level?: unknown }).level === "number",
    ...overrides,
  };
}

/** A model that answers nothing: these tests are about plugins, not turns. */
function quietModel() {
  return scriptedModel([textReply("unused")]);
}

/** One durable host over `path`, with the plugins and model a test wants. */
async function hostAt(
  path: string,
  options: {
    readonly plugins: Parameters<typeof composeTestHost>[0]["plugins"];
    readonly onState?: (state: unknown) => void;
  },
): Promise<ComposedHost> {
  return composeTestHost(
    { modelClient: quietModel().client, plugins: options.plugins, location: path },
    options.onState === undefined ? {} : { onState: options.onState as never },
  );
}

describe("the intent is committed before the lifecycle runs", () => {
  it("has the intent durably recorded by the time a plugin activates", async () => {
    await withTempDir(async (dir) => {
      const trace: { intentAtActivation: boolean | undefined } = { intentAtActivation: undefined };
      let repository: Repository | undefined;
      const plugin = testPlugin({
        id: "watcher",
        tools: [],
        activate: () => {
          trace.intentAtActivation = repository?.getPluginIntent("watcher")?.desiredEnabled;
        },
      });

      const composed = await composeTestHost(
        { modelClient: quietModel().client, plugins: [plugin], location: storePath(dir) },
        { onRepository: (observed) => (repository = observed) },
      );
      const client = connect(composed.host);
      await client.describe();

      const enabled = await client.call("plugins.enable", { pluginId: "watcher" });
      expect(enabled.error).toBeUndefined();
      // The plugin's own activation saw the durable intent already committed.
      expect(trace.intentAtActivation).toBe(true);

      client.detach();
      await composed.host.shutdown();
    });
  });

  it("runs no lifecycle at all when the intent cannot be committed", async () => {
    await withTempDir(async (dir) => {
      let activations = 0;
      const plugin = testPlugin({
        id: "counted",
        tools: [],
        activate: () => {
          activations += 1;
        },
      });

      const composed = await composeTestHost({
        modelClient: quietModel().client,
        plugins: [plugin],
        location: storePath(dir),
      });
      const client = connect(composed.host);
      await client.describe();

      // The next COMMIT of a plugin-intent write fails while its rollback still
      // runs: the store proves the batch never landed, and the write is refused
      // rather than left unjudged. This is the "persistence failed" half of the
      // rule; the "outcome unknown" half is the repository's own evidence
      // (checked where the store lives), and both stop the lifecycle.
      const originalExec = DatabaseSync.prototype.exec;
      const originalPrepare = DatabaseSync.prototype.prepare;
      let armed = true;
      let fired = 0;
      DatabaseSync.prototype.prepare = function patchedPrepare(this: DatabaseSync, sql: string) {
        if (sql.startsWith("INSERT INTO plugin_intents")) armed = true;
        return originalPrepare.call(this, sql);
      };
      DatabaseSync.prototype.exec = function patchedExec(this: DatabaseSync, sql: string): void {
        if (sql === "COMMIT" && armed && fired === 0) {
          fired += 1;
          armed = false;
          throw new Error("injected: the commit receipt was lost");
        }
        originalExec.call(this, sql);
      };

      try {
        const refused = await client.call("plugins.enable", { pluginId: "counted" });
        expect(refused.error?.code).toBe("STORAGE_UNAVAILABLE");
      } finally {
        DatabaseSync.prototype.exec = originalExec;
        DatabaseSync.prototype.prepare = originalPrepare;
      }
      expect(fired).toBe(1);

      // Nothing ran, and the store does not claim an intent it could not keep.
      expect(activations).toBe(0);
      expect(composed.repository.getPluginIntent("counted")?.desiredEnabled).toBe(false);

      client.detach();
      await composed.host.shutdown();
    });
  });

  it("keeps the desired intent when the lifecycle fails, and tells the truth about it", async () => {
    await withTempDir(async () => {
      const composed = await composeTestHost({
        modelClient: quietModel().client,
        plugins: [failingPlugin("broken")],
      });
      const client = connect(composed.host);
      await client.describe();

      const failed = await client.call("plugins.enable", { pluginId: "broken" });
      expect(failed.error?.code).toBe("PLUGIN_OPERATION_FAILED");

      // The intent the client asked for is durable and published; the actual
      // state is the failure, and it says so rather than pretending either.
      expect(composed.repository.getPluginIntent("broken")?.desiredEnabled).toBe(true);
      const summary = (await client.call("plugins.list", {})).result?.plugins[0];
      expect(summary?.desiredEnabled).toBe(true);
      expect(summary?.status).toBe("disabled");
      expect(summary?.unavailable).toBe(true);
      expect(summary?.restartRequired).toBe(false);

      client.detach();
      await composed.host.shutdown();
    });
  });

  it("lets a plugin in the error state still be disabled, intent first", async () => {
    await withTempDir(async () => {
      const composed = await composeTestHost({
        modelClient: quietModel().client,
        plugins: [failingPlugin("boom", { cleanupFails: true })],
      });
      const client = connect(composed.host);
      await client.describe();

      const failed = await client.call("plugins.enable", { pluginId: "boom" });
      expect(failed.error?.code).toBe("PLUGIN_OPERATION_FAILED");
      expect((await client.call("plugins.list", {})).result?.plugins[0]?.status).toBe("error");

      // The manager refuses to operate on an error-state plugin, and that must
      // not stop the intent from being recorded — otherwise every restart would
      // try to enable it again.
      const disabled = await client.call("plugins.disable", { pluginId: "boom" });
      expect(disabled.error?.code).toBe("PLUGIN_UNAVAILABLE");
      expect(composed.repository.getPluginIntent("boom")?.desiredEnabled).toBe(false);
      const summary = (await client.call("plugins.list", {})).result?.plugins[0];
      expect(summary?.desiredEnabled).toBe(false);
      expect(summary?.status).toBe("error");
      expect(summary?.unavailable).toBe(true);

      client.detach();
      // The plugin whose cleanup failed cannot be released, and the host says
      // so rather than pretending it was.
      await expect(composed.host.shutdown()).rejects.toThrow(/could not release/);
    });
  });
});

describe("what a restart restores", () => {
  it("activates nothing for a plugin that was left disabled", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      let activations = 0;
      const plugin = () =>
        testPlugin({
          id: "off",
          tools: [constantTool("off-tool")],
          activate: () => {
            activations += 1;
          },
        });

      const first = await composeTestHost({ modelClient: quietModel().client, plugins: [plugin()], location: path });
      const client = connect(first.host);
      await client.describe();
      await client.call("plugins.enable", { pluginId: "off" });
      await client.call("plugins.disable", { pluginId: "off" });
      expect(activations).toBe(1);
      client.detach();
      await first.host.shutdown();

      const second = await composeTestHost({ modelClient: quietModel().client, plugins: [plugin()], location: path });
      const again = connect(second.host);
      await again.describe();
      expect(activations).toBe(1);
      const summary = (await again.call("plugins.list", {})).result?.plugins[0];
      expect(summary?.status).toBe("disabled");
      expect(summary?.desiredEnabled).toBe(false);
      expect(summary?.unavailable).toBe(false);
      again.detach();
      await second.host.shutdown();
    });
  });

  it("attempts once, and only once, for a plugin that was left enabled", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      let activations = 0;
      let repository: Repository | undefined;
      let checkIntent = false;
      const plugin = () =>
        testPlugin({
          id: "on",
          tools: [],
          activate: () => {
            activations += 1;
            // Checked on the first host, whose repository the test is watching:
            // an activation happens after the intent it serves is durable, and
            // never before.
            if (checkIntent) expect(repository?.getPluginIntent("on")?.desiredEnabled).toBe(true);
          },
        });

      const first = await composeTestHost(
        { modelClient: quietModel().client, plugins: [plugin()], location: path },
        { onRepository: (observed) => (repository = observed) },
      );
      const client = connect(first.host);
      await client.describe();
      checkIntent = true;
      await client.call("plugins.enable", { pluginId: "on" });
      expect(activations).toBe(1);
      checkIntent = false;
      client.detach();
      await first.host.shutdown();

      const second = await composeTestHost(
        { modelClient: quietModel().client, plugins: [plugin()], location: path },
        { onRepository: (observed) => (repository = observed) },
      );
      const again = connect(second.host);
      await again.describe();
      expect(activations).toBe(2);
      const summary = (await again.call("plugins.list", {})).result?.plugins[0];
      expect(summary?.status).toBe("enabled");
      expect(summary?.desiredEnabled).toBe(true);
      expect(summary?.unavailable).toBe(false);
      again.detach();
      await second.host.shutdown();
    });
  });

  it("comes up with an unavailable plugin when its activation fails, and does not retry", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      let attempts = 0;
      const plugin = () =>
        testPlugin({
          id: "flaky",
          tools: [],
          activate: () => {
            attempts += 1;
            throw new Error("activation refused");
          },
        });

      const first = await composeTestHost({ modelClient: quietModel().client, plugins: [plugin()], location: path });
      const client = connect(first.host);
      await client.describe();
      await client.call("plugins.enable", { pluginId: "flaky" });
      expect(attempts).toBe(1);
      client.detach();
      await first.host.shutdown();

      // The restart attempts once more, fails, and still comes up: the failure
      // belongs to the plugin, and the catalogue reports it.
      const second = await composeTestHost({ modelClient: quietModel().client, plugins: [plugin()], location: path });
      const again = connect(second.host);
      await again.describe();
      expect(attempts).toBe(2);
      const summary = (await again.call("plugins.list", {})).result?.plugins[0];
      expect(summary?.desiredEnabled).toBe(true);
      expect(summary?.status).toBe("disabled");
      expect(summary?.unavailable).toBe(true);
      await flush();
      expect(attempts).toBe(2);

      again.detach();
      await second.host.shutdown();
    });
  });

  it("refuses to become ready when a restore's cleanup did not converge", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const first = await composeTestHost({
        modelClient: quietModel().client,
        plugins: [testPlugin({ id: "dirty", tools: [] })],
        location: path,
      });
      const client = connect(first.host);
      await client.describe();
      await client.call("plugins.enable", { pluginId: "dirty" });
      client.detach();
      await first.host.shutdown();

      // The restart's activation fails *and* its cleanup fails, so the plugin
      // may still own tools and resources: no ready host comes out of that.
      await expect(
        composeTestHost({
          modelClient: quietModel().client,
          plugins: [failingPlugin("dirty", { cleanupFails: true })],
          location: path,
        }),
      ).rejects.toThrow(/cleanup did not converge/);

      // And the store is free again: the failed startup released it.
      const probe = openRepository({ location: path, limits: { maxRecordBytes: 64 * 1024 } });
      expect(probe.getPluginIntent("dirty")?.desiredEnabled).toBe(true);
      probe.close();
    });
  });
});

describe("a plugin's configuration", () => {
  it("initializes the declared default once, and validates it again on every start", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const seen: PluginConfigValue[] = [];
      const plugin = (contract: PluginConfiguration) =>
        testPlugin({
          id: "configured",
          tools: [],
          configuration: contract,
          activate: (context) => {
            if (context.config !== undefined) seen.push(context.config);
          },
        });

      const first = await composeTestHost({
        modelClient: quietModel().client,
        plugins: [plugin(levelContract())],
        location: path,
      });
      const client = connect(first.host);
      await client.describe();
      await client.call("plugins.enable", { pluginId: "configured" });
      expect(seen).toEqual([{ level: 1 }]);
      expect(first.repository.getSettingsNamespace("plugin:configured")?.revision).toBe(1);
      expect(JSON.parse(first.repository.getSettingsNamespace("plugin:configured")?.valueJson ?? "null")).toEqual({
        level: 1,
      });
      client.detach();
      await first.host.shutdown();

      // The second start reads the stored value, not the default: the default
      // is used exactly once, when there is nothing stored to use.
      const second = await composeTestHost({
        modelClient: quietModel().client,
        plugins: [plugin(levelContract({ defaultValue: { level: 99 } }))],
        location: path,
      });
      const again = connect(second.host);
      await again.describe();
      await again.call("plugins.enable", { pluginId: "configured" });
      expect(seen.at(-1)).toEqual({ level: 1 });
      again.detach();
      await second.host.shutdown();
    });
  });

  it("keeps the current effective configuration while the desired revision is pending", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const seen: PluginConfigValue[] = [];
      const plugin = () =>
        testPlugin({
          id: "pending",
          tools: [],
          configuration: levelContract(),
          activate: (context) => {
            if (context.config !== undefined) seen.push(context.config);
          },
        });

      const first = await composeTestHost({ modelClient: quietModel().client, plugins: [plugin()], location: path });
      const client = connect(first.host);
      await client.describe();
      await client.call("plugins.enable", { pluginId: "pending" });
      expect(seen).toEqual([{ level: 1 }]);
      client.detach();
      await first.host.shutdown();

      // Somebody writes a *new* desired revision directly to the store, exactly
      // as a settings update would: revision 2, value {level: 2}.
      const writer = openRepository({ location: path, limits: { maxRecordBytes: 64 * 1024 } });
      const updated = writer.updateSettingsNamespace({
        namespace: "plugin:pending",
        expectedRevision: 1,
        schemaVersion: 1,
        valueJson: JSON.stringify({ level: 2 }),
        at: Date.now(),
      });
      expect(updated.kind).toBe("updated");
      writer.close();

      // This instance still runs revision 1: a disable/enable cycle inside it
      // must bind the configuration it actually started with, and a restart is
      // what makes revision 2 effective.
      const second = await composeTestHost({
        modelClient: quietModel().client,
        plugins: [plugin()],
        location: path,
      });
      const again = connect(second.host);
      await again.describe();
      const summary = (await again.call("plugins.list", {})).result?.plugins[0];
      expect(summary?.configRevision).toBe(2);
      expect(summary?.effectiveConfigRevision).toBe(2);
      expect(summary?.restartRequired).toBe(false);
      await again.call("plugins.enable", { pluginId: "pending" });
      expect(seen.at(-1)).toEqual({ level: 2 });
      again.detach();
      await second.host.shutdown();

      // And a third start, this time with a *new* desired revision pending
      // before it starts: the instance that comes up binds what it read.
      const writer2 = openRepository({ location: path, limits: { maxRecordBytes: 64 * 1024 } });
      writer2.updateSettingsNamespace({
        namespace: "plugin:pending",
        expectedRevision: 2,
        schemaVersion: 1,
        valueJson: JSON.stringify({ level: 3 }),
        at: Date.now(),
      });
      writer2.close();
      const third = await composeTestHost({ modelClient: quietModel().client, plugins: [plugin()], location: path });
      const thirdClient = connect(third.host);
      await thirdClient.describe();
      await thirdClient.call("plugins.enable", { pluginId: "pending" });
      expect(seen.at(-1)).toEqual({ level: 3 });
      thirdClient.detach();
      await third.host.shutdown();
    });
  });

  it("refuses to start when a stored configuration no longer satisfies its own contract", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const plugin = () => testPlugin({ id: "strict", tools: [], configuration: levelContract() });

      const first = await composeTestHost({ modelClient: quietModel().client, plugins: [plugin()], location: path });
      await first.host.shutdown();

      // A value the current validator refuses: the store is not repaired and
      // the default is not substituted.
      const writer = openRepository({ location: path, limits: { maxRecordBytes: 64 * 1024 } });
      writer.updateSettingsNamespace({
        namespace: "plugin:strict",
        expectedRevision: 1,
        schemaVersion: 1,
        valueJson: JSON.stringify({ level: "not a number" }),
        at: Date.now(),
      });
      writer.close();

      await expect(
        composeTestHost({ modelClient: quietModel().client, plugins: [plugin()], location: path }),
      ).rejects.toThrow(/configuration/);

      const probe = openRepository({ location: path, limits: { maxRecordBytes: 64 * 1024 } });
      expect(JSON.parse(probe.getSettingsNamespace("plugin:strict")?.valueJson ?? "null")).toEqual({
        level: "not a number",
      });
      expect(probe.getSettingsNamespace("plugin:strict")?.revision).toBe(2);
      probe.close();
    });
  });

  it("refuses to start when the stored schema version is not the contract's", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const first = await composeTestHost({
        modelClient: quietModel().client,
        plugins: [testPlugin({ id: "versioned", tools: [], configuration: levelContract() })],
        location: path,
      });
      await first.host.shutdown();

      const writer = new DatabaseSync(path);
      writer.prepare("UPDATE settings_namespaces SET schema_version = 7 WHERE namespace = 'plugin:versioned'").run();
      writer.close();

      await expect(
        composeTestHost({
          modelClient: quietModel().client,
          plugins: [testPlugin({ id: "versioned", tools: [], configuration: levelContract() })],
          location: path,
        }),
      ).rejects.toThrow(/configuration/);
    });
  });

  it("leaves a plugin that lost its configuration contract alone, without loading it", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      // A store that carries a configuration for a plugin this build registers
      // without a contract, and an intent row for a plugin it does not register
      // at all: both are retained, and neither is loaded, published or removed.
      const writer = openRepository({ location: path, limits: { maxRecordBytes: 64 * 1024 } });
      writer.initializeConfiguration({
        at: 1,
        namespaces: [
          {
            namespace: "host",
            schemaVersion: 1,
            valueJson: JSON.stringify({ systemPrompt: "", loop: { maxSteps: 12, maxModelAttempts: 3 } }),
          },
          { namespace: "model", schemaVersion: 1, valueJson: JSON.stringify({ provider: "test", model: "test-model" }) },
          { namespace: "plugin:plain", schemaVersion: 1, valueJson: JSON.stringify({ level: 5 }) },
          { namespace: "plugin:retired", schemaVersion: 1, valueJson: JSON.stringify({ level: 6 }) },
        ],
        pluginIntents: [
          { pluginId: "plain", desiredEnabled: false },
          { pluginId: "retired", desiredEnabled: true },
        ],
      });
      writer.close();

      // `plain` is registered without a contract; `retired` is not registered
      // at all. Both keep their rows, and the host comes up.
      const composed = await composeTestHost({
        modelClient: quietModel().client,
        plugins: [testPlugin({ id: "plain", tools: [] })],
        location: path,
      });
      const client = connect(composed.host);
      await client.describe();
      const catalogue = (await client.call("plugins.list", {})).result?.plugins ?? [];
      expect(catalogue.map((plugin) => plugin.id)).toEqual(["plain"]);
      // A plugin with no contract has no configuration revision to report.
      expect(catalogue[0]?.configRevision).toBeNull();
      expect(catalogue[0]?.effectiveConfigRevision).toBeNull();

      client.detach();
      await composed.host.shutdown();

      const probe = openRepository({ location: path, limits: { maxRecordBytes: 64 * 1024 } });
      expect(JSON.parse(probe.getSettingsNamespace("plugin:plain")?.valueJson ?? "null")).toEqual({ level: 5 });
      expect(probe.getPluginIntent("retired")?.desiredEnabled).toBe(true);
      expect(JSON.parse(probe.getSettingsNamespace("plugin:retired")?.valueJson ?? "null")).toEqual({ level: 6 });
      probe.close();
    });
  });
});
