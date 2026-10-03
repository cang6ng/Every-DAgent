/**
 * The strict browser acceptance gate.
 *
 * The ordinary suite treats a missing browser as a skip — that is how the
 * offline run stays honest without one. This script is the other direction: it
 * *requires* a real browser, runs the named acceptance files, and then reads
 * the machine report to prove that every required case actually ran and
 * passed. A missing browser, a failed launch, a skip, a todo, a zero-collected
 * file or a missing report are all failures here; exit code 0 alone is not
 * evidence, because a suite that skipped still exits 0.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const root = dirname(dirname(packageRoot));

const BROWSER_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Every case that must be observed as passed, by file. */
const REQUIRED = [
  {
    file: "apps/web/tests/browser-smoke.test.ts",
    titles: ["creates a connection, streams downstream and posts upstream"],
  },
  {
    file: "apps/web/tests/shell-browser.test.ts",
    titles: [
      "connects, shows the host as ready and starts with no sessions",
      "creates a session and completes a streamed run",
      "shows calculator calls and results as generic cards",
      "shows a second plugin's tool through the same generic card",
      "keeps a newer selection and its draft when a create answer arrives late",
      "restores the session selection after a page reload",
    ],
  },
  {
    file: "apps/web/tests/shell-faults.browser.test.ts",
    titles: [
      "keeps start off while a run is in flight and cancels on request",
      "marks a max-steps run as limited, not completed",
      "marks a failed run as failed and keeps its partial text out of history",
      "shows a plugin activation failure as a safe summary without a retry",
      "refuses a non-JSON tool input before any tool runs, and keeps tool text inert",
      "renders a dangerous tool result as inert text without executing it",
    ],
  },
  {
    file: "apps/web/tests/shell-reconnect.browser.test.ts",
    titles: [
      "follows a still-running stream across a reconnect",
      "survives a dropped connection and resyncs the same host",
      "shows an unconfirmed submission instead of resending it",
      "treats a restarted host as a different host",
    ],
  },
  {
    // M4's own carrier acceptance: the browser answers a real tool approval.
    file: "apps/web/tests/shell-approval.browser.test.ts",
    titles: [
      "runs nothing until the browser approves, then runs exactly once",
      "runs nothing when the browser rejects, and says so",
      "keeps the approval answerable across a reconnect, and runs it once after approving",
    ],
  },
];

function findBrowser() {
  const override = process.env["EVERY_DAGENT_BROWSER"];
  if (override !== undefined) {
    if (override === "" || override === "none") return undefined;
    return existsSync(override) ? override : undefined;
  }
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function fail(message) {
  console.error(`browser acceptance FAILED: ${message}`);
  process.exit(1);
}

const browser = findBrowser();
if (browser === undefined) {
  fail("no browser found; set EVERY_DAGENT_BROWSER to its executable to run this gate");
}

const version =
  spawnSync(browser, ["--version"], { encoding: "utf8" }).stdout?.trim() || "(version unavailable)";
console.log(`browser: ${browser}`);
console.log(`version: ${version}`);

const directory = mkdtempSync(join(tmpdir(), "every-dagent-browser-gate-"));
const reportPath = join(directory, "report.json");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");

const files = REQUIRED.map((entry) => entry.file);
const exitCode = await new Promise((resolve) => {
  const child = spawn(
    process.execPath,
    [
      vitest,
      "run",
      ...files,
      "--no-cache",
      "--exclude",
      "**/.zcode/**",
      "--reporter=json",
      `--outputFile=${reportPath.replace(/\\/g, "/")}`,
    ],
    {
      cwd: root,
      // `0` lifts the explicit disable; the tests still probe for a real browser.
      env: { ...process.env, EVERY_DAGENT_NO_BROWSER: "0", EVERY_DAGENT_BROWSER: browser },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let noise = "";
  child.stdout.on("data", (chunk) => {
    noise += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    noise += chunk.toString("utf8");
  });
  child.on("error", () => resolve(-1));
  child.on("close", (code) => {
    if (code !== 0) {
      console.error(noise.slice(-4000));
    }
    resolve(code ?? -1);
  });
});

try {
  if (exitCode !== 0) fail(`the vitest run exited with ${exitCode}`);

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    fail(`the machine report is missing or unreadable at ${reportPath}`);
  }

  const byFile = new Map();
  for (const fileResult of report.testResults ?? []) {
    byFile.set(String(fileResult.name).replace(/\\/g, "/"), fileResult.assertionResults ?? []);
  }

  let checked = 0;
  for (const entry of REQUIRED) {
    const match = [...byFile.entries()].find(([name]) => name.endsWith(entry.file));
    if (match === undefined) fail(`no report for ${entry.file} (the file did not run)`);
    const [, assertions] = match;

    for (const title of entry.titles) {
      checked += 1;
      const found = assertions.find((assertion) => assertion.title === title);
      if (found === undefined) fail(`${entry.file}: the required case never ran: "${title}"`);
      if (found.status !== "passed") {
        fail(`${entry.file}: "${title}" was reported as ${found.status}, not passed`);
      }
    }
    for (const assertion of assertions) {
      if (assertion.status !== "passed") {
        fail(`${entry.file}: "${assertion.title}" was ${assertion.status}; this gate admits no skips`);
      }
    }
  }

  console.log(`browser acceptance PASSED: ${checked} required cases, all passed, no skips`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
