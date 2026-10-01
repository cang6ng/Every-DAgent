/**
 * The shell when things go wrong: a busy host, a cancel request, a run that
 * hits the step budget, a run that fails, a plugin that cannot activate, and
 * inputs that are not JSON.
 *
 * The bar in every case is the same: the page says what actually happened and
 * nothing more. A cancel request is not a stop, `limited` is not a completion,
 * a failed run's draft is not history, an error plugin has no retry, and a
 * tool step the durable profile cannot carry is refused before any tool runs —
 * shown as the failure it is, never as a call that was guessed at.
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

async function openShell(): Promise<OpenShell> {
  const acceptance = await startShellAcceptance();
  const session = await launchBrowser({ executable: browser ?? "" });
  open.push({
    close: async () => {
      await session.close();
      await acceptance.close();
    },
  });
  await session.navigate(acceptance.pageUrl);
  await session.waitFor(
    'document.querySelector("[data-testid=connection-status]")?.textContent ?? ""',
    (value) => value.includes("已就绪"),
    20000,
    "the shell to become ready",
  );
  return { acceptance, session };
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
const runStatus = 'document.querySelector("[data-testid=run-status]")?.textContent ?? ""';

/** Polls a fact in the test process (a fixture's own state, not the page's). */
async function waitForNode(predicate: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("the shell when things go wrong, in a real browser", () => {
  it.skipIf(browser === undefined)(
    "keeps start off while a run is in flight and cancels on request",
    async () => {
      const { acceptance, session } = await openShell();

      await createSession(session);
      await sendText(session, "慢慢来 你好");
      await session.waitFor(countOf('[data-testid="live-text"]'), (value) => value !== "0", 15000, "the run to start");

      // While a run holds the host: start is off, plugin mutations are off.
      expect(await session.evaluate<boolean>('document.querySelector("[data-testid=send-button]").disabled')).toBe(true);
      expect(await session.evaluate<boolean>('document.querySelector("[data-testid=plugins-busy]") !== null')).toBe(true);
      expect(
        await session.evaluate<boolean>('document.querySelector("[data-testid=plugin-enable][data-plugin-id=calculator]").disabled'),
      ).toBe(true);

      // Cancel is a request: the page says requested, not stopped.
      await session.click('[data-testid="cancel-button"]');
      await session.waitFor(
        'document.querySelector("[data-testid=cancel-requested]") !== null ? "yes" : ""',
        (value) => value === "yes",
        10000,
        "the cancel request to be shown",
      );
      expect(await session.evaluate<string>(runStatus)).toContain("运行中");

      // A draft typed while the submission is in flight survives the send.
      await session.type('[data-testid="composer-input"]', "下一句");

      // The run only ends when it really settles.
      acceptance.model.openGate();
      await session.waitFor(runStatus, (value) => value.includes("已取消"), 15000, "the cancelled run");
      expect(await session.evaluate<boolean>('document.body.textContent.includes("不会因此回滚")')).toBe(true);
      // The chunk that arrived after the abort is not history.
      expect(await session.evaluate<string>(countOf('[data-testid="msg-assistant"]'))).toBe("0");
      expect(await session.evaluate<string>(countOf('[data-testid="msg-user"]'))).toBe("1");
      expect(await session.evaluate<string>('document.querySelector("[data-testid=composer-input]").value')).toBe("下一句");
      // The host is free again: that draft can be sent.
      await session.waitFor('String(document.querySelector("[data-testid=send-button]").disabled)', (value) => value === "false", 10000, "start to come back");

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "marks a max-steps run as limited, not completed",
    async () => {
      const { session } = await openShell();

      await createSession(session);
      await sendText(session, "一直做");

      await session.waitFor(runStatus, (value) => value.includes("达到步数上限"), 30000, "the limited run");
      expect(await session.evaluate<boolean>('document.body.textContent.includes("不是一次完整回答")')).toBe(true);
      expect(await session.evaluate<string>(runStatus)).not.toContain("已完成");

      // Twelve steps, each a call and a result, each shown exactly once. The
      // turn is longer than one history page carries: the newest page arrives
      // on its own, and the older ones are read the way a reader reads them —
      // never stitched silently into one conversation nobody read.
      await session.waitFor(countOf('[data-testid="tool-card"]'), (value) => value !== "0", 20000, "the newest history page");
      const footer = 'document.querySelector(".conversation__foot")?.textContent ?? ""';
      for (let page = 0; page < 4; page += 1) {
        if ((await session.evaluate<string>(countOf('[data-testid="tool-card"]'))) === "24") break;
        if ((await session.evaluate<string>(countOf('[data-testid="load-older"]'))) === "0") break;
        const loaded = await session.evaluate<string>(footer);
        await session.click('[data-testid="load-older"]');
        await session.waitFor(footer, (value) => value !== loaded, 20000, "the older history page");
      }
      expect(await session.evaluate<string>(countOf('[data-testid="tool-card"]'))).toBe("24");
      expect(await session.evaluate<string>(countOf('[data-testid="live-run"]'))).toBe("0");

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "marks a failed run as failed and keeps its partial text out of history",
    async () => {
      const { session } = await openShell();

      await createSession(session);
      await sendText(session, "然后失败");

      await session.waitFor(runStatus, (value) => value.includes("失败"), 20000, "the failed run");
      expect(await session.evaluate<string>(textOf('[data-testid="run-error"]'))).toContain("INTERNAL_ERROR");

      // The half sentence the model produced is gone with the draft, and the
      // prompt that never completed is not answered in history.
      expect(await session.evaluate<boolean>('document.body.textContent.includes("不会进入历史的半句")')).toBe(false);
      expect(await session.evaluate<string>(countOf('[data-testid="msg-assistant"]'))).toBe("0");
      expect(await session.evaluate<string>(countOf('[data-testid="msg-user"]'))).toBe("1");

      // The session is still usable: a failure of one run is not a blocked session.
      await sendText(session, "你好");
      await session.waitFor(textOf('[data-testid="msg-assistant"]'), (value) => value.includes("收到：你好"), 15000, "a new run to complete");

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "shows a plugin activation failure as a safe summary without a retry",
    async () => {
      const { session } = await openShell();

      await session.click('[data-testid="plugin-enable"][data-plugin-id="always-broken"]');
      await session.waitFor(
        'document.querySelector("[data-testid=plugin-item][data-plugin-id=always-broken] [data-testid=plugin-status]")?.textContent ?? ""',
        (value) => value === "error",
        10000,
        "the plugin to fail",
      );

      const failure = await session.evaluate<string>(
        textOf('[data-testid="plugin-item"][data-plugin-id="always-broken"] [data-testid="plugin-failure"]'),
      );
      expect(failure).toContain("activate");
      expect(failure).toContain("PLUGIN_OPERATION_FAILED");

      // The raw failure text — with its fake secret — never reached the page.
      expect(await session.evaluate<boolean>('document.body.textContent.includes("hunter2-should-not-leak")')).toBe(false);
      // No reset, no retry: an error plugin cannot be operated on.
      expect(
        await session.evaluate<boolean>(
          'document.querySelector("[data-testid=plugin-item][data-plugin-id=always-broken] [data-testid=plugin-enable]") === null',
        ),
      ).toBe(true);
      expect(
        await session.evaluate<boolean>(
          'document.querySelector("[data-testid=plugin-item][data-plugin-id=always-broken] [data-testid=plugin-error-note]") !== null',
        ),
      ).toBe(true);

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "refuses a non-JSON tool input before any tool runs, and keeps tool text inert",
    async () => {
      const { acceptance, session } = await openShell();

      await enablePlugin(session, "text-stats");
      await createSession(session);
      await sendText(session, "奇怪输入");

      // The step cannot be part of a durable conversation, so it is refused
      // before the tool is reached: the tool's own execution count stays zero,
      // and the page is told the run failed rather than shown a tool call that
      // never existed.
      await session.waitFor(runStatus, (value) => value.includes("失败"), 20000, "the refused run to be shown as failed");
      expect(acceptance.textStats.executions).toEqual([]);
      expect(await session.evaluate<string>(countOf('[data-testid="tool-card"]'))).toBe("0");
      expect(await session.evaluate<string>(countOf('[data-testid="tool-input-unavailable"]'))).toBe("0");
      expect(await session.evaluate<string>(countOf('[data-testid="msg-assistant"]'))).toBe("0");

      // What a tool or a message carries is text, never a program. The echo
      // being waited on has to be *this* round's: the refused round left no
      // assistant message behind, so the first one that appears is this one.
      const scriptText = "<script>window.__pwned = 1</script>";
      await sendText(session, scriptText);
      await session.waitFor(countOf('[data-testid="msg-assistant"]'), (value) => value === "1", 15000, "this round's echo to arrive");
      expect(
        await session.evaluate<string>(
          `document.querySelectorAll('[data-testid="msg-assistant"]')[0]?.textContent ?? ""`,
        ),
      ).toContain(scriptText);
      expect(await session.evaluate<boolean>('String(window.__pwned) === "undefined"')).toBe(true);
      expect(await session.evaluate<boolean>('document.querySelectorAll("img").length === 0')).toBe(true);

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "renders a dangerous tool result as inert text without executing it",
    async () => {
      const { acceptance, session } = await openShell();

      // A real tool really returns markup-shaped text, and the model is held
      // after that observation exists: the live card can be asserted while it
      // *is* the live card, not after it has quietly become history.
      await enablePlugin(session, "text-stats");
      await createSession(session);
      acceptance.model.holdNextDangerousResult();
      await sendText(session, "危险结果");

      // The lock is the model's own park: from here the run cannot settle, so
      // everything below reads a frozen live phase rather than a race.
      await waitForNode(() => acceptance.model.dangerousResultParked(), "the model to park after the tool result");

      const liveResult = '[data-testid="live-run"] [data-testid="tool-result-content"]';
      await session.waitFor(textOf(liveResult), (value) => value.includes("__tool_pwned"), 20000, "this round's tool result in the live area");
      expect(acceptance.textStats.executions).toEqual([{ text: "危险结果" }]);

      // The run is still open, and the result is in the live area and nowhere
      // else: nothing has settled into history yet.
      expect(await session.evaluate<string>(runStatus)).toContain("运行中");
      expect(await session.evaluate<string>(countOf('[data-testid="live-run"]'))).toBe("1");
      expect(await session.evaluate<string>(countOf('[data-testid="tool-card"]'))).toBe("1");
      expect(await session.evaluate<string>(countOf('[data-testid="live-run"] [data-testid="tool-card"]'))).toBe("1");
      expect(await session.evaluate<string>(countOf('[data-testid="msg-assistant"]'))).toBe("0");

      const liveText = await session.evaluate<string>(textOf(liveResult));
      expect(liveText).toContain('<script>window.__tool_pwned = 1</script>');
      expect(liveText).toContain("onerror=");
      expect(await session.evaluate<boolean>('String(window.__tool_pwned) !== "undefined"')).toBe(false);
      expect(
        await session.evaluate<string>(
          countOf('[data-testid="tool-result-content"] script, [data-testid="tool-result-content"] img'),
        ),
      ).toBe("0");
      expect(await session.evaluate<string>(countOf("img"))).toBe("0");

      // Release: the run settles, the live area empties, the card becomes
      // history — and is asked the same questions there.
      acceptance.model.releaseDangerousResult();
      await session.waitFor(runStatus, (value) => value.includes("已完成"), 20000, "the run to finish");
      expect(await session.evaluate<string>(countOf('[data-testid="live-run"]'))).toBe("0");

      const canonicalResult = textOf('[data-testid="tool-result-content"]');
      await session.waitFor(canonicalResult, (value) => value.includes("__tool_pwned"), 10000, "the canonical tool result");
      expect(
        await session.evaluate<string>(countOf('[data-testid="tool-card"][data-tool-name="text-stats"]')),
      ).toBe("2");
      const canonicalText = await session.evaluate<string>(canonicalResult);
      expect(canonicalText).toContain('<script>window.__tool_pwned = 1</script>');
      expect(canonicalText).toContain("onerror=");
      expect(await session.evaluate<boolean>('String(window.__tool_pwned) !== "undefined"')).toBe(false);
      expect(
        await session.evaluate<string>(
          countOf('[data-testid="tool-result-content"] script, [data-testid="tool-result-content"] img'),
        ),
      ).toBe("0");
      expect(await session.evaluate<string>(countOf("img"))).toBe("0");
      // The payload is only ever in the tool result; the round's assistant
      // message does not carry it, so these assertions are not reading a message.
      expect(await session.evaluate<string>(textOf('[data-testid="msg-assistant"]'))).not.toContain("__tool_pwned");

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );
});
