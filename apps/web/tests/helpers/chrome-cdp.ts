/**
 * A bare Chrome driver, over the DevTools protocol the browser itself speaks.
 *
 * There is no test framework in the page and nothing new in the dependency
 * tree: a headless browser is spawned against a temporary profile, the page
 * target is found through `/json/list`, and everything after that is
 * `Runtime.evaluate`, `Page.navigate` and screenshots. Real input goes through
 * the same path a person would use — a click is a click on an element, typing
 * sets the value through the prototype setter and fires `input`, exactly what
 * React listens for — because a driver that pokes a component's state directly
 * would not be evidence about the page.
 *
 * Two modes matter to the callers: `findBrowser` returns nothing when there is
 * no browser (the offline suite skips), while the strict gate refuses to run
 * without one. The missing-browser path is honest in both: a skip is printed
 * as a skip, and no caller of this module ever treats "did not run" as "passed".
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSER_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/**
 * The browser to drive, or nothing.
 *
 * `EVERY_DAGENT_NO_BROWSER=1` is the suite's own switch for saying "offline";
 * `EVERY_DAGENT_BROWSER` names a specific executable (the strict gate sets it
 * after its own probe). Neither is a product behaviour.
 */
export function findBrowser(): string | undefined {
  if (process.env["EVERY_DAGENT_NO_BROWSER"] === "1") return undefined;
  const override = process.env["EVERY_DAGENT_BROWSER"];
  if (override !== undefined && override !== "") {
    return existsSync(override) ? override : undefined;
  }
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface DevToolsTarget {
  readonly id: string;
  readonly type?: string;
  readonly webSocketDebuggerUrl?: string;
}

export interface BrowserOptions {
  readonly executable: string;
  /** The viewport the page is given; a desktop width by default. */
  readonly width?: number;
  readonly height?: number;
  /** Where screenshots are written. Defaults to a fresh temp directory. */
  readonly screenshotDir?: string;
}

export interface BrowserSession {
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Polls an expression until it returns something the predicate accepts. */
  waitFor(expression: string, until: (value: string) => boolean, timeoutMs: number, what: string): Promise<string>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  /** Captures the current viewport; returns the file path. */
  screenshot(name: string): Promise<string>;
  /** Uncaught exceptions the page reported since it loaded. */
  uncaughtExceptions(): readonly string[];
  /** `console.error` calls the page made since it loaded. */
  consoleErrors(): readonly string[];
  close(): Promise<void>;
}

/** Spawns the browser and drives one page in it. */
export async function launchBrowser(options: BrowserOptions): Promise<BrowserSession> {
  const width = options.width ?? 1440;
  const height = options.height ?? 900;
  const screenshotDir = options.screenshotDir ?? mkdtempSync(join(tmpdir(), "every-dagent-shots-"));
  const debugPort = 9222 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), "every-dagent-browser-"));

  const child: ChildProcess = spawn(
    options.executable,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let socket: WebSocket | undefined;
  const uncaught: string[] = [];
  const consoleErrored: string[] = [];

  try {
    const deadline = Date.now() + 20000;
    let target: DevToolsTarget | undefined;
    while (target === undefined) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const targets = (await response.json()) as DevToolsTarget[];
        target = targets.find(
          (candidate) => candidate.webSocketDebuggerUrl !== undefined && candidate.type === "page",
        );
      } catch {
        // Still starting.
      }
      if (target === undefined) {
        if (Date.now() > deadline) throw new Error("the browser never came up");
        await delay(50);
      }
    }

    const connected = new WebSocket(target.webSocketDebuggerUrl ?? "");
    await new Promise<void>((resolve, reject) => {
      connected.addEventListener("open", () => {
        resolve();
      });
      connected.addEventListener("error", () => {
        reject(new Error("the devtools socket failed"));
      });
    });
    socket = connected;

    const answers = new Map<number, (value: unknown) => void>();
    connected.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        readonly id?: number;
        readonly method?: string;
        readonly params?: unknown;
        readonly result?: unknown;
      };
      if (message.id !== undefined) {
        const resolve = answers.get(message.id);
        if (resolve !== undefined) {
          answers.delete(message.id);
          resolve(message);
        }
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        const params = message.params as { readonly exceptionDetails?: { readonly text?: string; readonly exception?: { readonly description?: string } } };
        uncaught.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "unknown exception");
      }
      if (message.method === "Runtime.consoleAPICalled") {
        const params = message.params as { readonly type?: string; readonly args?: readonly { readonly value?: unknown; readonly description?: string }[] };
        if (params.type === "error") {
          consoleErrored.push(params.args?.map((arg) => String(arg.value ?? arg.description ?? "")).join(" ") ?? "");
        }
      }
    });

    let nextId = 0;
    const call = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      nextId += 1;
      const id = nextId;
      const answer = new Promise<unknown>((resolve) => {
        answers.set(id, resolve);
      });
      connected.send(JSON.stringify({ id, method, params }));
      return await answer;
    };

    await call("Page.enable");
    await call("Runtime.enable");
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const evaluate = async <T>(expression: string): Promise<T> => {
      const answer = (await call("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })) as { readonly result?: { readonly result?: { readonly value?: unknown } }; readonly error?: unknown };
      const result = answer.result?.result;
      if (result === undefined) throw new Error(`the page could not evaluate: ${expression}`);
      return result.value as T;
    };

    const session: BrowserSession = {
      async navigate(url: string): Promise<void> {
        await call("Page.navigate", { url });
      },
      async reload(): Promise<void> {
        await call("Page.reload", { ignoreCache: true });
      },
      evaluate,
      async waitFor(expression: string, until: (value: string) => boolean, timeoutMs: number, what: string): Promise<string> {
        const readDeadline = Date.now() + timeoutMs;
        for (;;) {
          let value = "";
          try {
            value = String((await evaluate<string>(`String(${expression})`)) ?? "");
          } catch {
            value = "";
          }
          if (until(value)) return value;
          if (Date.now() > readDeadline) {
            throw new Error(`timed out waiting for ${what}; last value: ${value}`);
          }
          await delay(100);
        }
      },
      async click(selector: string): Promise<void> {
        const outcome = await evaluate<string>(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return "missing"; if (el.disabled) return "disabled"; el.click(); return "clicked"; })()`,
        );
        if (outcome !== "clicked") throw new Error(`could not click ${selector}: ${outcome}`);
      },
      async type(selector: string, text: string): Promise<void> {
        const outcome = await evaluate<string>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (el === null) return "missing";
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
            setter.call(el, ${JSON.stringify(text)});
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return "typed";
          })()`,
        );
        if (outcome !== "typed") throw new Error(`could not type into ${selector}: ${outcome}`);
      },
      async screenshot(name: string): Promise<string> {
        const answer = (await call("Page.captureScreenshot", { format: "png" })) as {
          readonly result?: { readonly data?: string };
        };
        const data = answer.result?.data;
        if (typeof data !== "string") throw new Error("the browser did not return a screenshot");
        const path = join(screenshotDir, `${name}.png`);
        writeFileSync(path, Buffer.from(data, "base64"));
        return path;
      },
      uncaughtExceptions: (): readonly string[] => uncaught,
      consoleErrors: (): readonly string[] => consoleErrored,
      async close(): Promise<void> {
        socket?.close();
        child.kill();
        await delay(200);
        try {
          rmSync(profile, { recursive: true, force: true });
        } catch {
          // A profile directory the just-killed browser still holds; the OS
          // reclaims it and no assertion depends on it.
        }
      },
    };

    return session;
  } catch (error) {
    socket?.close();
    child.kill();
    await delay(200);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // As above.
    }
    throw error;
  }
}
