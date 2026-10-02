/**
 * Batch 2 — C4 (host half): a durable mutation and the catalogue version it
 * moved are published together, and a version that cannot be recorded is not
 * swallowed.
 *
 * Publishing is the host's side of the freeze: a replica that asked for a change
 * must be told about it, and a change that reached the wire while the revision
 * still described the old world would leave every client paging a version that
 * never was.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  composeTestHost,
  connect,
  createSessionThrough,
  errorCode,
  flush,
  gatedReply,
  gate,
  runToTerminal,
  scriptedModel,
  testPlugin,
  textReply,
  type TestClient,
} from "./helpers/harness.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A store a failed test still holds is not the failure.
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-batch2-publish-"));
  dirs.push(dir);
  return dir;
}

function pluginsRevision(client: TestClient): number | undefined {
  const invalidated = [...client.events].reverse().find((event) => event.type === "collection.invalidated");
  return invalidated === undefined ? undefined : invalidated.payload.collections.plugins;
}

describe("C4 publication and revisions", () => {
  it("announces a rename with the summary and the catalogue version it moved", async () => {
    const host = composeTestHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host.host);
    try {
      await client.describe();
      await client.call("subscriptions.open", {});
      const session = await createSessionThrough(client);

      const renamed = await client.call("sessions.rename", {
        sessionId: session.sessionId,
        expectedRevision: session.metadataRevision,
        title: "renamed",
      });
      expect(renamed.error).toBeUndefined();
      const summary = renamed.result?.session;

      // The subscriber is told, in the same step, with the very summary the
      // response carries.
      const event = await client.waitForEvent("session.updated");
      expect(event.payload.session.title).toBe("renamed");
      expect(event.payload.session.metadataRevision).toBe(summary?.metadataRevision);
      expect(event.payload.session.sessionId).toBe(session.sessionId);
      expect(event.payload.collections.sessions).toBeGreaterThan(0);

      // And a client that reads afterwards gets the same facts.
      const fresh = await client.call("sessions.get", { sessionId: session.sessionId });
      expect(fresh.result?.session.title).toBe("renamed");
      expect(fresh.result?.session.metadataRevision).toBe(summary?.metadataRevision);
    } finally {
      client.detach();
      await host.host.shutdown();
    }
  });

  it("announces the runs revision a recorded cancel moved", async () => {
    const release = gate();
    const host = composeTestHost({
      modelClient: scriptedModel([gatedReply(release, textReply("finished"))]).client,
    });
    const client = connect(host.host);
    try {
      await client.describe();
      await client.call("subscriptions.open", {});
      const session = await createSessionThrough(client);
      const started = await client.call("runs.start", {
        sessionId: session.sessionId,
        submissionId: "sub-1",
        text: "hold",
      });
      const runId = started.result?.run.runId as string;

      const cancelled = await client.call("runs.cancel", { runId });
      expect(cancelled.error).toBeUndefined();
      expect(cancelled.result?.run.cancelRequested).toBe(true);

      // `run.updated` carries no revisions, so the catalogue move the recorded
      // intent produced is announced on its own.
      const invalidated = await client.waitForEvent("collection.invalidated");
      expect(invalidated.payload.collections.runs).toBeGreaterThan(0);

      release.open();
      await runToTerminal(client, session.sessionId, "unused", "sub-unused").catch(() => undefined);
    } finally {
      release.open();
      client.detach();
      await host.host.shutdown();
    }
  });

  it("publishes a plugin change and its catalogue revision together", async () => {
    const host = composeTestHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [testPlugin({ id: "demo", tools: [] })],
    });
    const client = connect(host.host);
    try {
      await client.describe();
      await client.call("subscriptions.open", {});

      const enabled = await client.call("plugins.enable", { pluginId: "demo" });
      expect(enabled.error).toBeUndefined();
      expect(enabled.result?.plugin.status).toBe("enabled");

      const updated = await client.waitForEvent("plugin.updated");
      expect(updated.payload.plugin.status).toBe("enabled");
      expect(pluginsRevision(client)).toBe(1);

      // A no-op enable changes nothing, so it announces nothing.
      const again = await client.call("plugins.enable", { pluginId: "demo" });
      expect(again.error).toBeUndefined();
      expect(client.events.filter((event) => event.type === "plugin.updated")).toHaveLength(1);
      expect(client.events.filter((event) => event.type === "collection.invalidated")).toHaveLength(1);
    } finally {
      client.detach();
      await host.host.shutdown();
    }
  });

  it("publishes nothing when the catalogue revision cannot be recorded, and stops vouching for writes", async () => {
    const host = composeTestHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [testPlugin({ id: "demo", tools: [] })],
      location: join(tempDir(), "plugin-fault.db"),
    });
    const client = connect(host.host);
    await client.describe();
    await client.call("subscriptions.open", {});

    // The revision write is injected to fail: the lifecycle still runs in the
    // manager, but the host cannot state the catalogue version that has to
    // travel with it.
    (host.repository as unknown as { bumpPluginRevision: () => never }).bumpPluginRevision = () => {
      throw new Error("injected: the revision cannot be recorded");
    };

    const enabled = client.call("plugins.enable", { pluginId: "demo" });
    // The fault boundary closes this connection, so the answer never travels:
    // on a real transport the caller's wait ends as lost/unknown, which is the
    // existing fault semantics rather than a fabricated success.
    void enabled;
    await flush();
    expect(client.isClosed).toBe(true);
    expect(client.events.filter((event) => event.type === "plugin.updated")).toHaveLength(0);
    expect(client.events.filter((event) => event.type === "collection.invalidated")).toHaveLength(0);
    // Nothing durable moved: the catalogue version this host cannot state is
    // exactly the version it did not write.
    expect(host.repository.revisions.plugins).toBe(0);

    // A fresh connection can still read the catalogue — it is this host's own
    // fact — and it says exactly what was published, which is nothing new.
    const reader = connect(host.host);
    try {
      await reader.describe();
      const listed = await reader.call("plugins.list", {});
      expect(listed.result?.plugins[0]?.status).toBe("disabled");

      // Writes are refused: the host no longer claims current state.
      const created = await reader.call("sessions.create", {});
      expect(errorCode(created)).toBe("STORAGE_UNAVAILABLE");
    } finally {
      reader.detach();
    }

    client.detach();
    await host.host.shutdown();
  });
});
