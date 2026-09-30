/**
 * How the strict browser gate reports itself.
 *
 * The offline suite treats a missing browser as a skip, and that is honest.
 * The strict gate is the opposite contract: no browser means failure, not a
 * skip — a gate that could be satisfied by absence is not a gate. This runs
 * the gate itself with the browser taken away and reads its exit code, so the
 * distinction between "checked" and "did not run" is enforced by a test and
 * not by convention.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const gate = fileURLToPath(new URL("../scripts/verify-browser.mjs", import.meta.url));

async function runGate(environment: Record<string, string>): Promise<{ code: number; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gate], {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? -1, output });
    });
  });
}

describe("the strict browser gate", () => {
  it(
    "fails, rather than skipping, when no browser is available",
    async () => {
      const { code, output } = await runGate({ EVERY_DAGENT_BROWSER: "none" });
      expect(output).toContain("no browser found");
      expect(code).toBe(1);
    },
    60000,
  );

  it(
    "fails when the named browser does not exist",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "every-dagent-gate-"));
      try {
        const { code, output } = await runGate({ EVERY_DAGENT_BROWSER: join(directory, "no-such-chrome.exe") });
        expect(output).toContain("no browser found");
        expect(code).toBe(1);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    60000,
  );
});
