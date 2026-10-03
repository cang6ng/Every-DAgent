import { describe, expect, it } from "vitest";

import type { ProtocolChannel } from "@every-dagent/protocol";

import {
  connect,
  constantTool,
  cooperativeTool,
  createSessionThrough,
  failingPlugin,
  flush,
  gate,
  gatedTool,
  scriptedModel,
  testHost,
  testPlugin,
  textReply,
  toolReply,
} from "./helpers/harness.js";

describe("shutdown", () => {
  it("aborts the active run, waits for it, and then releases the plugins", async () => {
    let disposed = 0;
    const host = await testHost({
      modelClient: scriptedModel([toolReply("call-1", "polite", {})]).client,
      plugins: [
        testPlugin({
          id: "tools",
          tools: [cooperativeTool("polite")],
          activate: (context) => {
            context.onDispose(() => {
              disposed += 1;
            });
          },
        }),
      ],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "sub-shutdown",
      text: "stop me",
    });

    await host.shutdown();

    // The run settled as cancelled, and only then was the plugin released.
    expect(disposed).toBe(1);
  });

  it("stays pending while an accepted execution has not settled", async () => {
    const started = gate();
    const release = gate();
    const host = await testHost({
      modelClient: scriptedModel([toolReply("call-1", "stubborn", {})]).client,
      plugins: [testPlugin({ id: "tools", tools: [gatedTool("stubborn", release, started)] })],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);

    await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "sub-stubborn",
      text: "never give up",
    });
    // The tool is in flight: aborting it is a request, not a settlement.
    await started.promise;

    let settled = false;
    const shutdown = host.shutdown().then(() => {
      settled = true;
    });

    // The tool ignores the signal: the host does not claim it stopped.
    await flush();
    expect(settled).toBe(false);

    release.open();
    await shutdown;
    expect(settled).toBe(true);
  });

  it("waits for an accepted activation before cleaning anything up", async () => {
    const activation = gate();
    const order: string[] = [];
    const host = await testHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [
        testPlugin({
          id: "slow",
          tools: [constantTool("slow-tool")],
          activate: async (context) => {
            context.onDispose(() => {
              order.push("slow-disposed");
            });
            await activation.promise;
            order.push("slow-activated");
          },
        }),
      ],
    });
    const client = connect(host);
    await client.describe();

    // The response can never arrive: shutdown closes the connection first.
    void client.call("plugins.enable", { pluginId: "slow" }).catch(() => undefined);
    await flush();

    let settled = false;
    const shutdown = host.shutdown().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    activation.open();
    await shutdown;

    // The activation finished before the cleanup started, not after it.
    expect(order).toEqual(["slow-activated", "slow-disposed"]);
  });

  it("does not retry a plugin stuck in the error state, and says so", async () => {
    let otherDisposed = 0;
    const host = await testHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [
        failingPlugin("boom", { cleanupFails: true }),
        testPlugin({
          id: "healthy",
          tools: [constantTool("healthy-tool")],
          activate: (context) => {
            context.onDispose(() => {
              otherDisposed += 1;
            });
          },
        }),
      ],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "boom" });
    await client.call("plugins.enable", { pluginId: "healthy" });

    const listing = (await client.call("plugins.list", {})).result?.plugins ?? [];
    expect(listing.find((plugin) => plugin.id === "boom")?.status).toBe("error");

    await expect(host.shutdown()).rejects.toThrow(/could not release/);
    // The rest of the plugins were still released.
    expect(otherDisposed).toBe(1);
  });

  it("refuses new connections once it has begun", async () => {
    const host = await testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const client = connect(host);
    await client.describe();

    await host.shutdown();

    expect(() => connect(host)).toThrow(/shutting down/);
    // And the connection that existed is over.
    expect(client.isClosed).toBe(true);
  });

  it("answers the same promise however many times it is called", async () => {
    const host = await testHost({ modelClient: scriptedModel([textReply("unused")]).client });

    const first = host.shutdown();
    const second = host.shutdown();

    expect(second).toBe(first);
    await first;
  });

  it("resolves when there was nothing to stop", async () => {
    const host = await testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    await expect(host.shutdown()).resolves.toBeUndefined();
  });
});

/** Attaches the same host twice through a channel that calls back on close. */
function wrapWithCallback(inner: ProtocolChannel, onClose: () => void): ProtocolChannel {
  return {
    send: (frame: string): void => {
      inner.send(frame);
    },
    listen: (listener): (() => void) => inner.listen(listener),
    close: (): void => {
      inner.close();
      onClose();
    },
  };
}

function outcomeOf(promise: Promise<unknown>): Promise<{ status: string; error?: unknown }> {
  return promise.then(
    () => ({ status: "fulfilled" }),
    (error: unknown) => ({ status: "rejected", error }),
  );
}

describe("shutdown completion ownership", () => {
  it("shares one shutdown with a connection that closes back into the host", async () => {
    let disposed = 0;
    let reentered: Promise<void> | undefined;
    const host = await testHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [
        testPlugin({
          id: "tools",
          tools: [constantTool("unused-tool")],
          activate: (context) => {
            context.onDispose(() => {
              disposed += 1;
            });
          },
        }),
      ],
    });
    const client = connect(host, {
      wrapHostChannel: (channel) =>
        wrapWithCallback(channel, () => {
          // Closing the connection happens inside the executor; a second
          // cleanup must not be started from it.
          reentered = host.shutdown();
        }),
    });
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });

    const outer = host.shutdown();
    await outer;

    expect(reentered).toBe(outer);
    expect(disposed).toBe(1);
  });

  it("shares one shutdown with an abort listener that calls back into the host", async () => {
    const started = gate();
    let disposed = 0;
    let reentered: Promise<void> | undefined;
    const host = await testHost({
      modelClient: scriptedModel([toolReply("call-1", "reenter", {})]).client,
      plugins: [
        testPlugin({
          id: "tools",
          tools: [
            {
              name: "reenter",
              description: "calls back into the host when the turn is aborted",
              inputSchema: {},
              execute: async (_input, context) => {
                started.open();
                await new Promise<void>((resolve) => {
                  context.signal.addEventListener(
                    "abort",
                    () => {
                      reentered = host.shutdown();
                      resolve();
                    },
                    { once: true },
                  );
                });
                return "stopped";
              },
            },
          ],
          activate: (context) => {
            context.onDispose(() => {
              disposed += 1;
            });
          },
        }),
      ],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "tools" });
    const session = await createSessionThrough(client);
    await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId: "sub-abort-reentry",
      text: "abort me",
    });
    // The call is in flight: the abort below is what its listener reacts to.
    await started.promise;

    const outer = host.shutdown();
    await outer;

    expect(reentered).toBe(outer);
    expect(disposed).toBe(1);
  });

  it("does not resolve while a deferred cleanup is still running", async () => {
    const release = gate();
    const host = await testHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [
        testPlugin({
          id: "slow-cleanup",
          tools: [constantTool("slow-tool")],
          activate: (context) => {
            context.onDispose(() => release.promise);
          },
        }),
      ],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "slow-cleanup" });

    let settled = false;
    const shutdown = host.shutdown().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    release.open();
    await shutdown;
    expect(settled).toBe(true);
  });

  it("gives every caller the same rejection when a cleanup fails", async () => {
    const host = await testHost({
      modelClient: scriptedModel([textReply("unused")]).client,
      plugins: [
        testPlugin({
          id: "angry-cleanup",
          tools: [constantTool("tool")],
          activate: (context) => {
            context.onDispose(() => {
              throw new Error("cleanup said: super-secret-token");
            });
          },
        }),
      ],
    });
    const client = connect(host);
    await client.describe();
    await client.call("plugins.enable", { pluginId: "angry-cleanup" });

    const first = host.shutdown();
    const second = host.shutdown();
    const third = host.shutdown();
    const outcomes = await Promise.all([outcomeOf(first), outcomeOf(second), outcomeOf(third)]);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(outcomes[0]?.error).toBe(outcomes[1]?.error);
    expect(outcomes[1]?.error).toBe(outcomes[2]?.error);
    expect(String((outcomes[0]?.error as Error).message)).toContain("angry-cleanup");
    expect(String((outcomes[0]?.error as Error).message)).not.toContain("super-secret-token");

    // A later call gets the same settled outcome, not a fresh attempt.
    expect(host.shutdown()).toBe(first);
    expect((await outcomeOf(host.shutdown())).status).toBe("rejected");
  });

  it("returns the same settled outcome to a later caller after a clean shutdown", async () => {
    const host = await testHost({ modelClient: scriptedModel([textReply("unused")]).client });

    const first = host.shutdown();
    await first;

    expect(host.shutdown()).toBe(first);
    await expect(host.shutdown()).resolves.toBeUndefined();
  });
});
