/**
 * The shell when the connection is what fails: a lost connection, a lost
 * answer, and a host that is not the same host any more.
 *
 * The rules under test are the platform's, seen from a page: a dropped
 * connection keeps the last presentation but never upgrades a run to
 * completed; an unanswered write is shown as unconfirmed and is never
 * resent on its own; and a new host instance is a different host — its
 * directory replaces the old one, and the old one's history is not carried
 * over or replayed.
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

async function connectPage(session: BrowserSession, pageUrl: string): Promise<void> {
  await session.navigate(pageUrl);
  await session.waitFor(
    'document.querySelector("[data-testid=connection-status]")?.textContent ?? ""',
    (value) => value.includes("已就绪"),
    20000,
    "the shell to become ready",
  );
}

async function openShell(): Promise<OpenShell> {
  const acceptance = await startShellAcceptance();
  const session = await launchBrowser({ executable: browser ?? "" });
  open.push({
    close: async () => {
      await session.close();
      await acceptance.close();
    },
  });
  await connectPage(session, acceptance.pageUrl);
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

async function sendText(session: BrowserSession, text: string): Promise<void> {
  await session.type('[data-testid="composer-input"]', text);
  await session.click('[data-testid="send-button"]');
}

const textOf = (selector: string): string => `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`;
const countOf = (selector: string): string => `String(document.querySelectorAll(${JSON.stringify(selector)}).length)`;
const connectionStatus = 'document.querySelector("[data-testid=connection-status]")?.textContent ?? ""';
const runStatus = 'document.querySelector("[data-testid=run-status]")?.textContent ?? ""';

describe("the shell across reconnects, in a real browser", () => {
  it.skipIf(browser === undefined)(
    "survives a dropped connection and resyncs the same host",
    async () => {
      const { acceptance, session } = await openShell();

      await createSession(session);
      await sendText(session, "慢慢来 你好");
      await session.waitFor(countOf('[data-testid="live-text"]'), (value) => value !== "0", 15000, "the run to start");

      // The connection dies while the run keeps going on the host.
      acceptance.controls.closeConnections();
      await session.waitFor(connectionStatus, (value) => value.includes("连接已断开"), 15000, "the lost connection");

      // The last presentation stays readable, and nothing claims it completed.
      expect(await session.evaluate<string>(countOf('[data-testid="msg-user"]'))).toBe("1");
      expect(await session.evaluate<string>(runStatus)).not.toContain("已完成");
      // Writes are off while the presentation cannot be trusted.
      expect(await session.evaluate<boolean>('document.querySelector("[data-testid=send-button]").disabled')).toBe(true);

      // The run finishes with nobody watching, then the run is re-synced.
      acceptance.model.openGate();
      await session.waitFor('String(document.querySelector("[data-testid=reconnect-button]").disabled)', (value) => value === "false", 15000, "reconnect to become available");
      await session.click('[data-testid="reconnect-button"]');
      await session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 20000, "the reconnected shell");

      await session.waitFor(runStatus, (value) => value.includes("已完成"), 15000, "the completed run after resync");
      expect(await session.evaluate<boolean>(`${textOf('[data-testid="msg-assistant"]')}.includes("收到：慢慢来 你好")`)).toBe(true);
      // One prompt, one answer: the live draft did not become a second bubble.
      expect(await session.evaluate<string>(countOf('[data-testid="msg-user"]'))).toBe("1");

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "shows an unconfirmed submission instead of resending it",
    async () => {
      const { acceptance, session } = await openShell();

      await createSession(session);
      // The answer to this submission dies with its connection.
      acceptance.controls.dropNextStartResponse();
      await sendText(session, "你好");

      await session.waitFor(
        'document.querySelector("[data-testid=unknown-panel]") !== null ? "yes" : ""',
        (value) => value === "yes",
        15000,
        "the unconfirmed submission panel",
      );
      expect(await session.evaluate<boolean>('document.body.textContent.includes("可能已被接受并执行")')).toBe(true);

      // The host really did accept and run it, exactly once.
      await session.waitFor(countOf('[data-testid="unknown-item"]'), (value) => value === "1", 5000, "the unconfirmed record");
      expect(acceptance.model.requests.length).toBe(1);

      // After a reconnect the history shows the run; the record is still open
      // until the user resolves it, and nothing was sent twice.
      await session.click('[data-testid="reconnect-button"]');
      await session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 20000, "the reconnected shell");
      await session.waitFor(textOf('[data-testid="msg-assistant"]'), (value) => value.includes("收到：你好"), 15000, "the run the host really executed");
      expect(await session.evaluate<string>(countOf('[data-testid="unknown-item"]'))).toBe("1");
      expect(acceptance.model.requests.length).toBe(1);

      // The explicit check resolves it against the host.
      await session.click('[data-testid="unknown-check"]');
      await session.waitFor(
        'document.querySelector("[data-testid=unknown-panel]") === null ? "gone" : ""',
        (value) => value === "gone",
        10000,
        "the record to be resolved",
      );
      expect(await session.evaluate<boolean>('document.body.textContent.includes("已被 Host 接受")')).toBe(true);
      expect(acceptance.model.requests.length).toBe(1);

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "treats a restarted host as a different host",
    async () => {
      // The whole application restarts on the same ports — the page, its
      // binding and the host — which is what a host restart looks like to a
      // browser that was left open.
      const first = await startShellAcceptance();
      const pageOrigin = new URL(first.pageUrl).origin;
      const bindingOrigin = first.bindingOrigin;

      const session = await launchBrowser({ executable: browser ?? "" });
      open.push({ close: () => session.close() });
      await connectPage(session, first.pageUrl);

      const firstInstance = await session.evaluate<string>(textOf('[data-testid="host-instance"]'));
      await createSession(session);
      await sendText(session, "你好");
      await session.waitFor(textOf('[data-testid="msg-assistant"]'), (value) => value.includes("收到：你好"), 15000, "a completed run on the first host");

      await first.close();
      // The same page is reloaded from the same origin; the new host takes over.
      const pagePort = Number(new URL(pageOrigin).port);
      const bindingPort = Number(new URL(bindingOrigin).port);
      const second = await startShellAcceptance({ pagePort, bindingPort });
      open.push({ close: () => second.close() });

      await session.reload();
      await session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 20000, "the restarted host");

      const secondInstance = await session.evaluate<string>(textOf('[data-testid="host-instance"]'));
      expect(secondInstance).not.toBe(firstInstance);
      // The new host's directory replaces the old one: no sessions, no history.
      await session.waitFor(textOf('[data-testid="sessions-empty"]'), (value) => value.length > 0, 10000, "the empty directory of the new host");
      expect(await session.evaluate<string>(countOf('[data-testid="msg-assistant"]'))).toBe("0");
      expect(await session.evaluate<string>(countOf('[data-testid="session-item"][data-selected=true]'))).toBe("0");
      // And nothing was replayed onto it.
      expect(second.model.requests.length).toBe(0);

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );
});
