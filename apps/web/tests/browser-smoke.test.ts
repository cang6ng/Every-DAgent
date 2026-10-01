/**
 * The browser proof: the binding, driven by a real browser's own fetch.
 *
 * The fixture page is loaded from a *different* origin than the binding — the
 * way a real deployment looks — and the binding's origin allowlist (and the
 * exact CORS answer that follows from it) is what lets it through. A page that
 * cannot set the transport header cannot create a connection at all, which is
 * the point of that header.
 *
 * Chrome is driven over its own DevTools protocol with the WebSocket Node
 * already has: nothing new in the dependency tree, and no test framework inside
 * the page. When no Chrome is present the test skips with a message rather than
 * pretending to have run.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ProtocolChannel } from "@every-dagent/protocol";

import { startHttpBinding } from "../src/index.js";
import { findBrowser } from "./helpers/chrome-cdp.js";

const FIXTURE = fileURLToPath(new URL("fixtures/transport-smoke.html", import.meta.url));

// The same probe the shell's browser files use, on purpose: the strict gate
// names one browser via EVERY_DAGENT_BROWSER, and a smoke with its own private
// list would be free to drive a different one — or none — while the gate
// reported on what it found.
const browser = findBrowser();

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface DevToolsTarget {
  readonly id: string;
  readonly webSocketDebuggerUrl?: string;
}

/** A bare DevTools connection: navigate once, then ask the page what it sees. */
interface DevTools {
  navigate(url: string): Promise<void>;
  read(expression: string, until: (value: string) => boolean, timeoutMs: number): Promise<string>;
  close(): void;
}

async function connectDevTools(port: number, timeoutMs: number): Promise<DevTools> {
  const deadline = Date.now() + timeoutMs;
  let target: DevToolsTarget | undefined;
  while (target === undefined) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await response.json()) as DevToolsTarget[];
      // A real page, not an extension's background target: `--headless` still
      // loads extensions unless it is told not to, and they claim the first slot.
      target = targets.find(
        (candidate) =>
          candidate.webSocketDebuggerUrl !== undefined &&
          (candidate as { readonly type?: string }).type === "page",
      );
    } catch {
      // Still starting.
    }
    if (target === undefined) {
      if (Date.now() > deadline) throw new Error("the browser never came up");
      await delay(50);
    }
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl ?? "");
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve();
    });
    socket.addEventListener("error", () => {
      reject(new Error("the devtools socket failed"));
    });
  });

  const answers = new Map<number, (value: unknown) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { readonly id?: number };
    if (message.id === undefined) return;
    const resolve = answers.get(message.id);
    if (resolve !== undefined) {
      answers.delete(message.id);
      resolve(message);
    }
  });

  let nextId = 0;
  const call = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    nextId += 1;
    const id = nextId;
    const answer = new Promise<unknown>((resolve) => {
      answers.set(id, resolve);
    });
    socket.send(JSON.stringify({ id, method, params }));
    return await answer;
  };

  const valueOf = (message: unknown): string => {
    const result = (message as { readonly result?: { readonly result?: { readonly value?: unknown } } }).result
      ?.result?.value;
    return typeof result === "string" ? result : "";
  };

  return {
    async navigate(url: string): Promise<void> {
      await call("Page.enable", {});
      await call("Page.navigate", { url });
    },

    async read(expression: string, until: (value: string) => boolean, readTimeoutMs: number): Promise<string> {
      const readDeadline = Date.now() + readTimeoutMs;
      for (;;) {
        const value = valueOf(await call("Runtime.evaluate", { expression, returnByValue: true }));
        if (until(value)) return value;
        if (Date.now() > readDeadline) throw new Error(`the page never reported: ${expression}`);
        await delay(100);
      }
    },

    close(): void {
      socket.close();
    },
  };
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

describe("a real browser against the binding", () => {
  it.skipIf(browser === undefined)(
    "creates a connection, streams downstream and posts upstream",
    async () => {
      if (browser === undefined) {
        // Unreachable with `skipIf`, and kept so the branch is explicit: the
        // suite reports a skip, and a skip is not a pass.
        console.log("transport-smoke: NOT RUN (no browser found)");
        return;
      }

    // The page's own origin, which the binding has to allow explicitly.
    const page = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(readFileSync(FIXTURE));
    });
    await new Promise<void>((resolve) => {
      page.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const pageOrigin = `http://127.0.0.1:${(page.address() as { port: number }).port}`;

    // An echo: whatever arrives upstream goes back downstream, so the page can
    // see its own frame come home.
    const binding = await startHttpBinding({
      originAllowlist: [pageOrigin],
      onConnection: (channel: ProtocolChannel) => {
        channel.listen({
          onFrame: (frame: string): void => {
            // The frame is opaque here: a frame is a string, and this binding
            // never looks inside one.
            channel.send(JSON.stringify({ direction: "downstream", payload: frame }));
          },
          onClose: (): void => undefined,
        });
      },
    });
    open.push({
      close: async () => {
        await binding.close();
        await new Promise<void>((resolve) => {
          page.close(() => {
            resolve();
          });
        });
      },
    });

    const debugPort = 9222 + Math.floor(Math.random() * 500);
    const profile = mkdtempSync(join(tmpdir(), "every-dagent-smoke-"));
    const child: ChildProcess = spawn(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${debugPort}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );

    try {
      const devtools = await connectDevTools(debugPort, 20000);
      try {
        await devtools.navigate(
          `${pageOrigin}/transport-smoke.html?binding=${encodeURIComponent(binding.origin)}`,
        );
        const verdict = await devtools.read(
          // The fixture's own title says "pending" until the page is done; only
          // a settled verdict counts as an answer.
          'document.title === "transport-smoke: PASS" || document.title === "transport-smoke: FAIL" ? `${document.title}|${document.querySelector("#result")?.textContent ?? ""}` : ""',
          (value) => value.length > 0,
          25000,
        );

        const [title = "", resultLine = ""] = verdict.split("|");
        const result = JSON.parse(resultLine) as {
          readonly created: number;
          readonly stream: number;
          readonly posted: number;
          readonly tokenInUrl: boolean;
          readonly received: readonly string[];
        };

        expect(title, `page report: ${resultLine}`).toBe("transport-smoke: PASS");
        expect(result).toMatchObject({ created: 201, stream: 200, posted: 204, tokenInUrl: false });
        // What the page holds is a frame — a string — and the echo's own JSON is
        // inside it: the transport wrapped and unwrapped it, and nothing more.
        expect(result.received.map((frame) => JSON.parse(frame) as unknown)).toEqual([
          { direction: "downstream", payload: "browser-frame-1" },
        ]);
      } finally {
        devtools.close();
      }
      } finally {
        child.kill();
        await delay(200);
        try {
          rmSync(profile, { recursive: true, force: true });
        } catch {
          // A profile directory in the OS temp folder that a just-killed browser
          // still holds open; the test's result does not depend on it.
        }
      }
    },
    90000,
  );
});
