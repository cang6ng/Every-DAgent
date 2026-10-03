/**
 * M3 — the host composes from persisted configuration.
 *
 * These are the composition-level facts: a store is initialized once from the
 * trusted defaults and never overwritten, a stored value is re-validated before
 * it becomes effective, the effective settings really drive the runtime (loop
 * budget, system prompt, model profile), and a composition that fails leaves
 * nothing of the store behind.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createHost, type BootstrapSettings, type ComposeInput, type TrustedComposition } from "@every-dagent/host";

import { TEST_BOOTSTRAP, testComposition } from "../../../tests/helpers/test-composition.js";
import {
  awaitRunTerminal,
  composeTestHost,
  connect,
  constantTool,
  createSessionThrough,
  scriptedModel,
  testPlugin,
  textReply,
  toolReply,
} from "./helpers/harness.js";
import { openRepository, SCHEMA_VERSION } from "../src/repository.js";

const LIMITS = { maxRecordBytes: 64 * 1024 };

async function withTempDir<T>(act: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-m3-compose-"));
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

/** The bootstrap a test varies one field at a time from. */
function bootstrap(overrides: {
  readonly systemPrompt?: string;
  readonly maxSteps?: number;
  readonly maxModelAttempts?: number;
  readonly model?: unknown;
} = {}): BootstrapSettings {
  return {
    host: {
      systemPrompt: overrides.systemPrompt ?? "",
      loop: {
        maxSteps: overrides.maxSteps ?? 12,
        maxModelAttempts: overrides.maxModelAttempts ?? 3,
      },
    },
    model: (overrides.model ?? { provider: "test", model: "test-model" }) as BootstrapSettings["model"],
  };
}

describe("initialization", () => {
  it("writes the trusted defaults once, and never overwrites a stored intent", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const first = await composeTestHost({
        modelClient: scriptedModel([textReply("unused")]).client,
        location: path,
        bootstrap: bootstrap({ systemPrompt: "the first prompt", maxSteps: 5, maxModelAttempts: 2 }),
      });
      const stored = first.repository.getSettingsNamespace("host");
      expect(stored?.revision).toBe(1);
      expect(stored?.schemaVersion).toBe(1);
      expect(JSON.parse(stored?.valueJson ?? "null")).toEqual({
        systemPrompt: "the first prompt",
        loop: { maxSteps: 5, maxModelAttempts: 2 },
      });
      const model = first.repository.getSettingsNamespace("model");
      expect(model?.revision).toBe(1);
      expect(JSON.parse(model?.valueJson ?? "null")).toEqual({ provider: "test", model: "test-model" });
      await first.host.shutdown();

      // A restart with *different* defaults: the store keeps what it holds.
      const second = await composeTestHost({
        modelClient: scriptedModel([textReply("unused")]).client,
        location: path,
        bootstrap: bootstrap({ systemPrompt: "a later prompt", maxSteps: 1, maxModelAttempts: 1 }),
      });
      expect(JSON.parse(second.repository.getSettingsNamespace("host")?.valueJson ?? "null")).toEqual({
        systemPrompt: "the first prompt",
        loop: { maxSteps: 5, maxModelAttempts: 2 },
      });
      expect(second.repository.getSettingsNamespace("host")?.revision).toBe(1);
      await second.host.shutdown();

      // And the store is still the same store: one schema, one identity.
      const probe = openRepository({ location: path, limits: LIMITS });
      expect(probe.schemaVersion).toBe(SCHEMA_VERSION);
      probe.close();
    });
  });

  it("refuses a store that holds only half of the managed configuration", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const seeding = openRepository({ location: path, limits: LIMITS });
      seeding.initializeConfiguration({
        at: 1,
        namespaces: [
          { namespace: "host", schemaVersion: 1, valueJson: JSON.stringify(bootstrap().host) },
        ],
        pluginIntents: [],
      });
      seeding.close();

      await expect(
        composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client, location: path }),
      ).rejects.toThrow(/configuration/i);

      // Refusing is not completing: the missing namespace was not invented.
      const probe = openRepository({ location: path, limits: LIMITS });
      expect(probe.getSettingsNamespace("model")).toBeUndefined();
      expect(probe.getSettingsNamespace("host")?.revision).toBe(1);
      probe.close();
    });
  });

  it("refuses a stored value the composition no longer accepts, before composing", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const seeding = openRepository({ location: path, limits: LIMITS });
      seeding.initializeConfiguration({
        at: 1,
        namespaces: [
          { namespace: "host", schemaVersion: 1, valueJson: JSON.stringify(bootstrap().host) },
          {
            namespace: "model",
            schemaVersion: 1,
            valueJson: JSON.stringify({ provider: "retired", model: "gone" }),
          },
        ],
        pluginIntents: [],
      });
      seeding.close();

      let composed = false;
      const composition = testComposition({
        modelClient: scriptedModel([textReply("unused")]).client,
        catalog: [{ provider: "test", model: "test-model" }],
        onCompose: () => {
          composed = true;
        },
      });

      await expect(
        createHost({
          bootstrap: TEST_BOOTSTRAP,
          composition,
          plugins: [],
          persistence: { kind: "sqlite", location: path },
        }),
      ).rejects.toThrow(/configuration/i);
      // The refusal happened before execution was built: nothing composed, and
      // a stored value is never quietly replaced by the bootstrap default.
      expect(composed).toBe(false);
      const probe = openRepository({ location: path, limits: LIMITS });
      expect(JSON.parse(probe.getSettingsNamespace("model")?.valueJson ?? "null")).toEqual({
        provider: "retired",
        model: "gone",
      });
      probe.close();
    });
  });
});

describe("what the effective settings drive", () => {
  it("handsthe composition the effective host and model settings with their revisions", async () => {
    await withTempDir(async (dir) => {
      const seen: ComposeInput[] = [];
      const composed = await composeTestHost({
        modelClient: scriptedModel([textReply("unused")]).client,
        location: storePath(dir),
        bootstrap: bootstrap({ systemPrompt: "configured", maxSteps: 7, maxModelAttempts: 2 }),
        composition: testComposition({
          modelClient: scriptedModel([textReply("unused")]).client,
          onCompose: (input) => seen.push(input),
        }),
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]?.host).toEqual({
        systemPrompt: "configured",
        loop: { maxSteps: 7, maxModelAttempts: 2 },
      });
      expect(seen[0]?.model).toEqual({ provider: "test", model: "test-model" });
      expect(seen[0]?.revisions).toEqual({ host: 1, model: 1 });
      await composed.host.shutdown();
    });
  });

  it("runs the loop at the effective step budget", async () => {
    await withTempDir(async () => {
      const model = scriptedModel([toolReply("call-1", "observer", {})]);
      const composed = await composeTestHost({
        modelClient: model.client,
        plugins: [testPlugin({ id: "tools", tools: [constantTool("observer")] })],
        bootstrap: bootstrap({ maxSteps: 1 }),
      });
      const client = connect(composed.host);
      await client.describe();
      // The tool has to be registered for the step to be declarable at all: a
      // managed step that names a tool the registry does not have is refused
      // before anything runs, which is a different question than the budget.
      await client.call("plugins.enable", { pluginId: "tools" });
      const session = await createSessionThrough(client);

      const started = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: "sub-budget",
        text: "one step",
      });
      const terminal = await awaitRunTerminal(client, started.result?.run.runId as string);

      // One step was allowed, the tool asked for another, and the turn stopped
      // there — the number the store holds is the number the loop spent.
      expect(terminal.status).toBe("limited");
      expect(terminal.endReason).toBe("max_steps");
      expect(model.requests).toHaveLength(1);
      client.detach();
      await composed.host.shutdown();
    });
  });

  it("applies the effective system prompt to the default context builder", async () => {
    await withTempDir(async () => {
      const model = scriptedModel([textReply("hello")]);
      const composed = await composeTestHost({
        modelClient: model.client,
        bootstrap: bootstrap({ systemPrompt: "be brief" }),
      });
      const client = connect(composed.host);
      await client.describe();
      const session = await createSessionThrough(client);
      const started = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: "sub-prompt",
        text: "hello",
      });
      await awaitRunTerminal(client, started.result?.run.runId as string);

      expect(model.requests[0]?.systemPrompt).toBe("be brief");
      client.detach();
      await composed.host.shutdown();
    });
  });

  it("treats an empty system prompt as no system prompt at all", async () => {
    await withTempDir(async () => {
      const model = scriptedModel([textReply("hello")]);
      const composed = await composeTestHost({ modelClient: model.client, bootstrap: bootstrap() });
      const client = connect(composed.host);
      await client.describe();
      const session = await createSessionThrough(client);
      const started = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: "sub-no-prompt",
        text: "hello",
      });
      await awaitRunTerminal(client, started.result?.run.runId as string);
      expect(model.requests[0]?.systemPrompt).toBeUndefined();
      client.detach();
      await composed.host.shutdown();
    });
  });
});

describe("startup failures", () => {
  it("releases the store when the composition refuses, so the next start can open it", async () => {
    await withTempDir(async (dir) => {
      const path = storePath(dir);
      const refusing: TrustedComposition = {
        validateModel: () => ({ ok: true }),
        compose: async () => {
          throw new Error("the composition refused");
        },
      };

      await expect(
        createHost({
          bootstrap: TEST_BOOTSTRAP,
          composition: refusing,
          plugins: [],
          persistence: { kind: "sqlite", location: path },
        }),
      ).rejects.toThrow(/refused/);

      // The file is free, and the configuration the failed start initialized is
      // the durable one: it was committed before the composition ran.
      const composed = await composeTestHost({
        modelClient: scriptedModel([textReply("unused")]).client,
        location: path,
      });
      expect(composed.repository.getSettingsNamespace("host")?.revision).toBe(1);
      await composed.host.shutdown();

      const probe = new DatabaseSync(path);
      const version = probe.prepare("PRAGMA user_version").get() as { readonly user_version?: number };
      expect(version.user_version).toBe(SCHEMA_VERSION);
      probe.close();
    });
  });

  it("disposes the execution it took when a later startup step fails", async () => {
    await withTempDir(async (dir) => {
      let disposed = 0;
      const composition = testComposition({
        modelClient: scriptedModel([textReply("unused")]).client,
        dispose: () => {
          disposed += 1;
        },
      });

      // A catalogue the host cannot publish inside one frame: the failure is
      // after the composition handed execution over, so the host must release
      // it rather than leave it alive with no host to serve.
      await expect(
        composeTestHost({
          modelClient: scriptedModel([textReply("unused")]).client,
          composition,
          location: storePath(dir),
          plugins: [
            testPlugin({ id: "huge", name: "Huge", description: "d".repeat(200 * 1024) }),
          ],
        }),
      ).rejects.toThrow(/frame|room/i);
      expect(disposed).toBe(1);
    });
  });
});
