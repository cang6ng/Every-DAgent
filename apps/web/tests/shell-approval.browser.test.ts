/**
 * M4's browser acceptance: a real Chrome answering a real tool approval.
 *
 * The host runs a real loop with a trusted policy that refuses to run its tool
 * without an approval; the binding carries the `tool.approval` request to the
 * page; the page is the shipped client with a typed handler and two buttons.
 * Every action goes through the browser — a click is a decision — and every
 * assertion about execution counts is made against the tool that really ran.
 *
 * The page is the minimal harness, not the Shell: M4 ships no rich approval UI,
 * and the shell's own pages are asserted unchanged by their own files.
 */

import { afterEach, describe, expect, it } from "vitest";

import { findBrowser, launchBrowser, type BrowserSession } from "./helpers/chrome-cdp.js";
import { startApprovalAcceptance, type ApprovalAcceptance } from "./helpers/shell-server.js";

const browser = findBrowser();

interface OpenHarness {
  readonly acceptance: ApprovalAcceptance;
  readonly session: BrowserSession;
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const resource of open.splice(0)) await resource.close();
});

const textOf = (selector: string): string =>
  `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`;

async function openHarness(): Promise<OpenHarness> {
  const acceptance = await startApprovalAcceptance();
  const session = await launchBrowser({ executable: browser ?? "" });
  open.push({
    close: async () => {
      await session.close();
      await acceptance.close();
    },
  });
  await session.navigate(acceptance.harnessUrl);
  await session.waitFor(textOf('[data-testid="harness-status"]'), (value) => value === "ready", 20000, "the harness to connect");
  await session.waitFor(textOf('[data-testid="connection-status"]'), (value) => value === "ready", 20000, "the client to be ready");
  return { acceptance, session };
}

/** Starts one run and waits for the approval card to be on screen. */
async function startAndWaitForApproval(harness: OpenHarness): Promise<void> {
  await harness.session.click('[data-testid="start-run"]');
  await harness.session.waitFor(
    'String(document.querySelector("[data-testid=approval-card]")?.dataset.visible ?? "false")',
    (value) => value === "true",
    15000,
    "the approval card",
  );
  await harness.session.waitFor(textOf('[data-testid="approval-name"]'), (value) => value === "counter", 10000, "the tool name");
  await harness.session.waitFor(textOf('[data-testid="approval-status"]'), (value) => value === "pending", 10000, "a pending approval");
}

describe("the browser answers a tool approval", () => {
  it.skipIf(browser === undefined)("runs nothing until the browser approves, then runs exactly once", async () => {
    const harness = await openHarness();
    await startAndWaitForApproval(harness);

    // Nothing has run: the card is up, the buttons are live, and the tool has
    // not been entered.
    expect(harness.acceptance.executions).toEqual([]);
    await harness.session.waitFor(
      textOf('[data-testid="approval-can-respond"]'),
      (value) => value === "true",
      10000,
      "the page to be allowed to answer",
    );

    await harness.session.click('[data-testid="approve"]');
    await harness.session.waitFor(textOf('[data-testid="run-status"]'), (value) => value === "completed", 15000, "the run to complete");

    expect(harness.acceptance.executions).toEqual([{ n: 1 }]);
    await harness.session.waitFor(
      textOf('[data-testid="tool-result"]'),
      (value) => value.includes('"disposition":"executed"') && value.includes("count:1"),
      10000,
      "the executed result on the card",
    );
  }, 30000);

  it.skipIf(browser === undefined)("runs nothing when the browser rejects, and says so", async () => {
    const harness = await openHarness();
    await startAndWaitForApproval(harness);

    await harness.session.click('[data-testid="reject"]');
    await harness.session.waitFor(textOf('[data-testid="run-status"]'), (value) => value === "completed", 15000, "the run to complete");

    expect(harness.acceptance.executions).toEqual([]);
    // The refusal is a recorded, not-executed observation — the page shows the
    // fixed sentence and never a claim that something ran.
    await harness.session.waitFor(
      textOf('[data-testid="tool-result"]'),
      (value) => value.includes('"disposition":"not-executed"') && value.includes("not executed"),
      10000,
      "the refused result on the card",
    );
  }, 30000);

  it.skipIf(browser === undefined)("keeps the approval answerable across a reconnect, and runs it once after approving", async () => {
    const harness = await openHarness();
    await startAndWaitForApproval(harness);
    expect(harness.acceptance.executions).toEqual([]);

    // The browser reconnects while the approval is pending: the old delivery
    // ends, the Host's business record does not, and a fresh delivery arrives
    // over the new stream.
    await harness.session.click('[data-testid="reconnect"]');
    await harness.session.waitFor(
      textOf('[data-testid="connection-status"]'),
      (value) => value === "ready",
      20000,
      "the reconnect to settle",
    );
    await harness.session.waitFor(
      textOf('[data-testid="approval-can-respond"]'),
      (value) => value === "true",
      15000,
      "the approval to be answerable again",
    );
    expect(harness.acceptance.executions).toEqual([]);

    await harness.session.click('[data-testid="approve"]');
    await harness.session.waitFor(textOf('[data-testid="run-status"]'), (value) => value === "completed", 15000, "the run to complete");
    expect(harness.acceptance.executions).toEqual([{ n: 1 }]);
  }, 30000);
});
