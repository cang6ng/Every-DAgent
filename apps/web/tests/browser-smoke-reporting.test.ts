/**
 * How the browser smoke reports itself.
 *
 * The smoke test runs a real browser when there is one, and must say "not run"
 * when there is not — a suite that reports a skip as a pass is a suite that
 * cannot tell you what it checked. This test runs that file in a child process
 * with the browser suppressed and reads the machine-readable report, rather
 * than trusting the console output.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");

interface VitestJsonReport {
  readonly testResults: readonly {
    readonly name: string;
    readonly assertionResults: readonly {
      readonly title: string;
      readonly status: string;
      readonly failureMessages: readonly string[];
    }[];
  }[];
}

describe("the browser smoke's own reporting", () => {
  it(
    "reports a missing browser as skipped, never as passed",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "every-dagent-report-"));
      // Forward slashes: a Windows path inside an argument is not always read as
      // one, and vitest takes this one as a path.
      const output = `${directory.replace(/\\/g, "/")}/report.json`;
      try {
        const exitCode = await new Promise<number>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              vitest,
              "run",
              "apps/web/tests/browser-smoke.test.ts",
              "--no-cache",
              "--exclude",
              "**/.zcode/**",
              "--reporter=json",
              `--outputFile=${output}`,
            ],
            {
              cwd: root,
              env: { ...process.env, EVERY_DAGENT_NO_BROWSER: "1" },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let noise = "";
          child.stdout.on("data", (chunk: Buffer) => {
            noise += chunk.toString("utf8");
          });
          child.stderr.on("data", (chunk: Buffer) => {
            noise += chunk.toString("utf8");
          });
          child.on("error", reject);
          child.on("close", (code) => {
            if (code !== 0) console.error("the reporting probe failed:", noise.slice(-2000));
          });
          child.on("close", (code) => {
            resolve(code ?? -1);
          });
        });

        const report = JSON.parse(readFileSync(output, "utf8")) as VitestJsonReport;
        const results = report.testResults.flatMap((file) => file.assertionResults);
        expect(results).toHaveLength(1);

        const [result] = results;
        expect(result?.title).toContain("creates a connection");
        // The distinction the finding was about: a skip is its own status.
        expect(result?.status).toBe("skipped");
        expect(result?.status).not.toBe("passed");
        // A skipped suite is still a successful run of the suite.
        expect(exitCode).toBe(0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    120000,
  );
});
