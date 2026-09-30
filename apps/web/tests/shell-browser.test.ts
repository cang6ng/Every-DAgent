/**
 * The generic shell, in a real browser, against a real host.
 *
 * Nothing application-level is mocked: the page is the built artifact, the
 * client is the shipped client, the binding is the shipped binding and the host
 * is a real host running a real registry, loop and runtime. The only stand-in
 * is the model — a fixture that answers deterministically, because no test may
 * call a provider. Every action goes through the page: clicks and typing, not
 * calls into the client.
 *
 * The happy paths live here; cancellation, failures, limited runs and raw
 * protocol faults live in `shell-faults.browser.test.ts`, and connection loss
 * and restarts in `shell-reconnect.browser.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { findBrowser, launchBrowser, type BrowserSession } from "./helpers/chrome-cdp.js";
import { startShellAcceptance, type ShellAcceptance } from "./helpers/shell-server.js";

const browser = findBrowser();

interface OpenShell {
  readonly acceptance: ShellAcceptance;
  readonly session: BrowserSession;
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const resource of open.splice(0)) await resource.close();
});

async function openShell(acceptance?: ShellAcceptance): Promise<OpenShell> {
  const server = acceptance ?? (await startShellAcceptance());
  const session = await launchBrowser({ executable: browser ?? "" });
  open.push({
    close: async () => {
      await session.close();
      if (acceptance === undefined) await server.close();
    },
  });
  await session.navigate(server.pageUrl);
  await session.waitFor(
    'document.querySelector("[data-testid=connection-status]")?.textContent ?? ""',
    (value) => value.includes("已就绪"),
    20000,
    "the shell to become ready",
  );
  return { acceptance: server, session };
}

async function createSession(session: BrowserSession): Promise<string> {
  await session.click('[data-testid="new-session"]');
  return await session.waitFor(
    'document.querySelector("[data-testid=session-item][data-selected=true]")?.getAttribute("data-session-id") ?? ""',
    (value) => value.length > 0,
    10000,
    "a created session to be selected",
  );
}

async function enablePlugin(session: BrowserSession, pluginId: string): Promise<void> {
  await session.click(`[data-testid="plugin-enable"][data-plugin-id="${pluginId}"]`);
  await session.waitFor(
    `document.querySelector('[data-testid=plugin-item][data-plugin-id=${pluginId}] [data-testid=plugin-status]')?.textContent ?? ""`,
    (value) => value === "enabled",
    10000,
    `the ${pluginId} plugin to become enabled`,
  );
}

async function sendText(session: BrowserSession, text: string): Promise<void> {
  await session.type('[data-testid="composer-input"]', text);
  await session.click('[data-testid="send-button"]');
}

const textOf = (selector: string): string => `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`;
const countOf = (selector: string): string => `String(document.querySelectorAll(${JSON.stringify(selector)}).length)`;

describe("the generic shell in a real browser", () => {
  it.skipIf(browser === undefined)(
    "connects, shows the host as ready and starts with no sessions",
    async () => {
      const { session } = await openShell();

      expect(await session.waitFor(textOf('[data-testid="host-panel"]'), (value) => value.includes("every-dagent-host"), 10000, "the host identity")).toContain("every-dagent-host");
      await session.waitFor(textOf('[data-testid="sessions-empty"]'), (value) => value.length > 0, 5000, "the empty session list");
      await session.waitFor(textOf('[data-testid="no-session"]'), (value) => value.length > 0, 5000, "the no-session placeholder");

      // Every registered plugin is listed, disabled until enabled.
      expect(await session.waitFor(countOf('[data-testid="plugin-item"]'), (value) => value === "3", 5000, "the plugin list")).toBe("3");
      expect(await session.evaluate<boolean>('document.body.textContent.includes("Calculator")')).toBe(true);
      expect(await session.evaluate<boolean>('document.body.textContent.includes("Text Stats")')).toBe(true);

      // The page says where history lives.
      expect(await session.evaluate<boolean>('document.body.textContent.includes("Host 停止后")')).toBe(true);

      console.log(`screenshot: ${await session.screenshot("shell-connected")}`);
      expect(session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "creates a session and completes a streamed run",
    async () => {
      const { acceptance, session } = await openShell();

      await createSession(session);
      await sendText(session, "慢慢来 你好");

      // The first chunk is visible while the run is still open: that is the
      // live area, distinct from history.
      await session.waitFor(countOf('[data-testid="live-text"]'), (value) => value !== "0", 15000, "the live text");
      expect(await session.evaluate<boolean>('document.body.textContent.includes("正在思考")')).toBe(true);
      await session.waitFor('document.querySelector("[data-testid=run-status]")?.textContent ?? ""', (value) => value.includes("运行中"), 5000, "the running status");
      expect(await session.evaluate<boolean>('document.querySelector("[data-testid=send-button]").disabled')).toBe(true);

      acceptance.model.openGate();

      await session.waitFor('document.querySelector("[data-testid=run-status]")?.textContent ?? ""', (value) => value.includes("已完成"), 15000, "the completed run");
      // The live draft is gone and the recorded answer is in history.
      expect(await session.evaluate<string>(countOf('[data-testid="live-text"]'))).toBe("0");
      expect(await session.evaluate<boolean>(`${textOf('[data-testid="msg-assistant"]')}.includes("收到：慢慢来 你好")`)).toBe(true);
      expect(await session.evaluate<string>(countOf('[data-testid="msg-user"]'))).toBe("1");
      // The host is free again: a new draft can be sent.
      await session.type('[data-testid="composer-input"]', "再试一次");
      expect(await session.evaluate<boolean>('document.querySelector("[data-testid=send-button]").disabled')).toBe(false);

      console.log(`screenshot: ${await session.screenshot("shell-completed")}`);
      expect(session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "shows calculator calls and results as generic cards",
    async () => {
      const { acceptance, session } = await openShell();

      await enablePlugin(session, "calculator");
      await createSession(session);
      await sendText(session, "算一下 6*7");

      await session.waitFor(textOf('[data-testid="msg-assistant"]'), (value) => value.includes("计算结果是 42"), 20000, "the tool-backed answer");

      // One call card and one result card, both generic, both the calculator's.
      expect(await session.evaluate<string>(countOf('[data-testid="tool-card"][data-tool-name="calculator"]'))).toBe("2");
      expect(await session.evaluate<string>(textOf('[data-testid="tool-input-json"]'))).toContain('"a": 6');
      expect(await session.evaluate<string>(textOf('[data-testid="tool-result-content"]'))).toContain("42");
      // The real tool ran exactly once for this submission.
      expect(acceptance.textStats.executions).toEqual([]);
      console.log(`screenshot: ${await session.screenshot("shell-tool-cards")}`);

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "shows a second plugin's tool through the same generic card",
    async () => {
      const { acceptance, session } = await openShell();

      // Enable the second plugin through its panel.
      await enablePlugin(session, "text-stats");

      await createSession(session);
      await sendText(session, "统计一下");

      await session.waitFor(textOf('[data-testid="msg-assistant"]'), (value) => value.includes("统计结果是"), 20000, "the second plugin's answer");
      expect(await session.evaluate<string>(countOf('[data-testid="tool-card"][data-tool-name="text-stats"]'))).toBe("2");
      expect(await session.evaluate<string>(textOf('[data-testid="tool-result-content"]'))).toContain("characters");
      // The tool really ran, with the input the model sent.
      expect(acceptance.textStats.executions).toEqual([{ text: "hello world" }]);

      // And it can be taken away again through the same panel.
      await session.click('[data-testid="plugin-disable"][data-plugin-id="text-stats"]');
      await session.waitFor(
        'document.querySelector("[data-testid=plugin-item][data-plugin-id=text-stats] [data-testid=plugin-status]")?.textContent ?? ""',
        (value) => value === "disabled",
        10000,
        "the plugin to become disabled",
      );

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "restores the session selection after a page reload",
    async () => {
      const { acceptance, session } = await openShell();

      const sessionId = await createSession(session);
      await sendText(session, "你好");
      await session.waitFor(textOf('[data-testid="msg-assistant"]'), (value) => value.includes("收到：你好"), 15000, "the completed answer");

      await session.reload();

      // The page reconnects from its own URL and the selection is restored...
      await session.waitFor(
        'document.querySelector("[data-testid=connection-status]")?.textContent ?? ""',
        (value) => value.includes("已就绪"),
        20000,
        "the shell to become ready again",
      );
      await session.waitFor(
        `document.querySelector('[data-testid="session-item"][data-session-id=${JSON.stringify(sessionId)}]')?.getAttribute("data-selected") ?? ""`,
        (value) => value === "true",
        10000,
        "the selection to be restored",
      );

      // ...and history comes from the host, not from a second copy of the draft.
      await session.waitFor(textOf('[data-testid="msg-assistant"]'), (value) => value.includes("收到：你好"), 10000, "history from the host");
      expect(await session.evaluate<string>(countOf('[data-testid="msg-user"]'))).toBe("1");
      expect(acceptance.model.requests.length).toBeGreaterThan(0);

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );
});
