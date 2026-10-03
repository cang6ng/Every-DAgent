/**
 * The acceptance host: a real host, the real shell server, the real page.
 *
 * Nothing in the acceptance path is mocked at the application level. The host
 * is `createHost` with two real plugins and the offline model; the shell server
 * is the product composition; the page is the built artifact the command line
 * would serve. The only seam this helper adds is the channel ward: how a
 * binding channel reaches the host is composition, and the acceptance uses
 * that seam exactly the way a deployment would use it for tracing — to drop
 * one answer, or to end a connection, and then watch what the shell does about
 * it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHost, type Host } from "@every-dagent/host";
import { TEST_BOOTSTRAP, testComposition } from "../../../../tests/helpers/test-composition.js";
import { createCalculatorPlugin } from "@every-dagent/plugin-calculator";
import type { Plugin, PluginContext } from "@every-dagent/plugin-system";
import type { ProtocolChannel } from "@every-dagent/protocol";

import { buildApp } from "../../scripts/build.mjs";
import { startShellServer, type ShellServer } from "../../src/server/shell-server.js";
import { offlineModel, type OfflineModel } from "./offline-model.js";
import { textStatsPlugin, type TextStatsPluginFixture } from "../../../../tests/fixtures/text-stats-plugin.js";

export interface ShellControls {
  /** The next `runs.start` answer dies with its connection instead of arriving. */
  dropNextStartResponse(): void;
  /** How many times a response was dropped this way. */
  readonly drops: number;
  /** Holds the next `sessions.create` answer until `releaseCreateAnswer` is called. */
  holdNextCreateAnswer(): void;
  /** Releases a held create answer, if one is held. */
  releaseCreateAnswer(): void;
  /** Ends every open connection without touching the host or its runs. */
  closeConnections(): void;
  /** Open logical connections, as the binding sees them. */
  connections(): number;
  /**
   * Every `runs.start` request that actually crossed the binding.
   *
   * This is the count "nothing was replayed" has to be stated in: a host's
   * submission dedup would swallow a duplicate request, and a model request
   * count would never see it — only the transport sees what was really sent.
   */
  startRequests(): number;
}

/**
 * A plugin that cannot activate, carrying a fake secret in its failure.
 *
 * Its cleanup fails too, which is what puts the manager into the `error` state
 * rather than back to `disabled` — the only state in which a plugin genuinely
 * cannot be operated on. The acceptance uses it to check two things at once:
 * that a failed activation becomes a safe, enumerable summary in the page —
 * and that the raw failure text, which here contains something that must never
 * be shown, does not travel with it.
 */
export function failingPlugin(): Plugin {
  return {
    manifest: {
      id: "always-broken",
      name: "Always Broken",
      version: "0.0.1",
      description: "A plugin whose activation always fails.",
    },
    activate(context: PluginContext): void {
      context.onDispose((): void => {
        throw new Error("cleanup failed as well: the other half is hunter2-cleanup-secret");
      });
      throw new Error("activation failed: the vault code is hunter2-should-not-leak");
    },
  };
}

export interface ShellAcceptance {
  readonly host: Host;
  readonly shell: ShellServer;
  readonly model: OfflineModel;
  readonly textStats: TextStatsPluginFixture;
  readonly controls: ShellControls;
  readonly pageUrl: string;
  readonly bindingOrigin: string;
  /** Ends the servers and then the host: the host is truly gone afterwards. */
  close(): Promise<void>;
}

export interface ShellAcceptanceOptions {
  /** Fixed ports, for a test that restarts the whole application in place. */
  readonly pagePort?: number;
  readonly bindingPort?: number;
}

const buildDirectory = mkdtempSync(join(tmpdir(), "every-dagent-shell-build-"));
process.once("exit", () => {
  try {
    rmSync(buildDirectory, { recursive: true, force: true });
  } catch {
    // A temp directory the OS will reclaim; the test result does not depend on it.
  }
});

let building: Promise<string> | undefined;

/** The built artifact, once per process. */
export async function ensureShellBuild(): Promise<string> {
  if (building === undefined) {
    building = buildApp({ outDir: join(buildDirectory, "dist") }).then((result) => result.outDir);
  }
  return await building;
}

function safeParse(frame: string): { readonly kind?: unknown; readonly method?: unknown; readonly requestId?: unknown } | null {
  try {
    const value = JSON.parse(frame) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface Ward {
  readonly wrap: (channel: ProtocolChannel) => ProtocolChannel;
  readonly controls: ShellControls;
}

function createWard(): Ward {
  const connections = new Set<ProtocolChannel>();
  let armed = false;
  let drops = 0;
  let holdCreate = false;
  let heldCreateAnswer: (() => void) | null = null;
  let startRequestsSeen = 0;

  return {
    wrap: (channel: ProtocolChannel): ProtocolChannel => {
      connections.add(channel);
      /** The request ids this connection carries that belong to `runs.start`. */
      const startRequestIds = new Set<string>();
      /** The request ids this connection carries that belong to `sessions.create`. */
      const createRequests = new Set<string>();
      return {
        send(frame: string): void {
          const parsed = safeParse(frame);
          if (armed) {
            if (
              parsed !== null &&
              parsed.kind === "host-response" &&
              typeof parsed.requestId === "string" &&
              startRequestIds.has(parsed.requestId)
            ) {
              // The answer is lost with the connection that carried it: the
              // client can no longer learn whether the host accepted the run.
              armed = false;
              drops += 1;
              connections.delete(channel);
              channel.close();
              return;
            }
          }
          if (
            holdCreate &&
            parsed !== null &&
            parsed.kind === "host-response" &&
            typeof parsed.requestId === "string" &&
            createRequests.has(parsed.requestId)
          ) {
            // Parked, not dropped: the answer exists and will arrive, just not
            // yet — the window a user gets to move on before it lands.
            holdCreate = false;
            heldCreateAnswer = () => {
              channel.send(frame);
            };
            return;
          }
          channel.send(frame);
        },
        listen(listener): () => void {
          return channel.listen({
            onFrame(frame: string): void {
              const parsed = safeParse(frame);
              if (parsed !== null && parsed.kind === "client-request" && typeof parsed.requestId === "string") {
                if (parsed.method === "runs.start") {
                  startRequestIds.add(parsed.requestId);
                  startRequestsSeen += 1;
                }
                if (parsed.method === "sessions.create") createRequests.add(parsed.requestId);
              }
              listener.onFrame(frame);
            },
            onClose(): void {
              listener.onClose();
            },
          });
        },
        close(): void {
          connections.delete(channel);
          channel.close();
        },
      };
    },
    controls: {
      dropNextStartResponse(): void {
        armed = true;
      },
      get drops(): number {
        return drops;
      },
      holdNextCreateAnswer(): void {
        holdCreate = true;
      },
      releaseCreateAnswer(): void {
        const resume = heldCreateAnswer;
        heldCreateAnswer = null;
        resume?.();
      },
      closeConnections(): void {
        for (const channel of [...connections]) {
          connections.delete(channel);
          channel.close();
        }
      },
      connections(): number {
        return connections.size;
      },
      startRequests(): number {
        return startRequestsSeen;
      },
    },
  };
}

export interface ApprovalAcceptance {
  readonly host: Host;
  readonly shell: ShellServer;
  /** The page that answers approvals: the harness, not the shell. */
  readonly harnessUrl: string;
  /** Every value the counter tool was handed, in order. */
  readonly executions: readonly unknown[];
  close(): Promise<void>;
}

/**
 * The M4 acceptance host: a tool the trusted policy will not run without an
 * approval, and a browser to answer it.
 *
 * This is a *carrier* acceptance, not a UI one: the host runs a real loop with
 * a real policy, the binding carries the `tool.approval` request to a real
 * browser, and the page answers with the shipped client's typed handler. M5
 * owns the shell's own approval experience, so the page here is deliberately
 * the minimal harness rather than the shell.
 */
export async function startApprovalAcceptance(): Promise<ApprovalAcceptance> {
  const outDir = await ensureShellBuild();
  const model = offlineModel();
  const executions: unknown[] = [];
  const counter: Plugin = {
    manifest: { id: "counter", name: "Counter", version: "1.0.0", description: "Counts one call per approval." },
    activate(context: PluginContext): void {
      context.tools.register({
        name: "counter",
        description: "Counts.",
        inputSchema: { type: "object" },
        execute: async (input: unknown): Promise<string> => {
          executions.push(input);
          return `count:${executions.length}`;
        },
      });
    },
  };

  const host = await createHost({
    bootstrap: TEST_BOOTSTRAP,
    composition: testComposition({
      modelClient: model.client,
      // The trusted side decides: this tool is a side effect, and the Host will
      // not run it without a client's approval.
      toolPolicy: { revision: 1, decide: () => "require-approval" },
    }),
    plugins: [counter],
  });
  const shell = await startShellServer({ host, staticRoot: join(outDir, "public") });

  return {
    host,
    shell,
    harnessUrl: `${new URL(shell.pageUrl).origin}/approval-harness.html?binding=${encodeURIComponent(shell.bindingOrigin)}`,
    executions,
    async close(): Promise<void> {
      await shell.close();
      await host.shutdown();
    },
  };
}

export async function startShellAcceptance(options: ShellAcceptanceOptions = {}): Promise<ShellAcceptance> {
  const outDir = await ensureShellBuild();
  const model = offlineModel();
  const textStats = textStatsPlugin();
  const ward = createWard();

  const host = await createHost({
    bootstrap: TEST_BOOTSTRAP,
    composition: testComposition({ modelClient: model.client }),
    plugins: [createCalculatorPlugin(), textStats.plugin, failingPlugin()],
  });
  const shell = await startShellServer({
    host,
    staticRoot: join(outDir, "public"),
    wrapChannel: ward.wrap,
    ...(options.pagePort === undefined ? {} : { port: options.pagePort }),
    ...(options.bindingPort === undefined ? {} : { bindingPort: options.bindingPort }),
  });

  return {
    host,
    shell,
    model,
    textStats,
    controls: ward.controls,
    pageUrl: shell.pageUrl,
    bindingOrigin: shell.bindingOrigin,
    async close(): Promise<void> {
      await shell.close();
      try {
        await host.shutdown();
      } catch {
        // The fixture's `always-broken` plugin cannot be released once it is in
        // the error state, and the host says so instead of pretending — that
        // honesty is asserted where it matters (in the host's own tests); here
        // it must not turn a passing acceptance into a teardown failure.
      }
    },
  };
}
