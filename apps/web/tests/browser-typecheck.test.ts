/**
 * The browser project actually type-checking the browser half.
 *
 * `apps/web/tsconfig.browser.json` exists so the React sources are compiled
 * under DOM libs — but a config that merely *lists* files proves nothing. The
 * root project's `exclude` is inherited by every extending config, and an
 * inherited `exclude` beats the inheriting config's `include`, so a change to
 * either file can silently leave the program with only the transport files
 * while `tsc` still exits 0. This test runs the real compiler with the real
 * config and checks both halves: it succeeds, and its program contains every
 * browser source that exists on disk — enumerated, so a new file the include
 * drops fails here too.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("../", import.meta.url));

function filesUnder(relative: string): string[] {
  const directory = join(appRoot, relative);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => `${relative}/${entry.name}`.split("\\").join("/"))
    .sort();
}

interface TypecheckRun {
  readonly status: number | null;
  readonly program: readonly string[];
  readonly diagnostics: string;
}

function runBrowserTypecheck(): TypecheckRun {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const result = spawnSync(
    process.execPath,
    [tsc, "--noEmit", "-p", join(appRoot, "tsconfig.browser.json"), "--listFiles"],
    { cwd: appRoot, encoding: "utf8" },
  );

  const program: string[] = [];
  const diagnostics: string[] = [];
  for (const line of `${result.stdout}${result.stderr}`.split(/\r?\n/)) {
    if (line.includes("node_modules")) continue;
    if (line.trim() === "") continue;
    if (/[/\\]apps[/\\]web[/\\]|[/\\]packages[/\\]/.test(line) && !line.includes("error TS")) {
      program.push(line.trim().split("\\").join("/"));
    } else {
      diagnostics.push(line);
    }
  }

  return { status: result.status, program, diagnostics: diagnostics.join("\n") };
}

describe("the browser tsconfig", () => {
  const run = runBrowserTypecheck();

  it("compiles clean", () => {
    expect(run.diagnostics, `tsc reported problems:\n${run.diagnostics}`).toBe("");
    expect(run.status, `tsc exited with ${String(run.status)}`).toBe(0);
  });

  it("enters every file of src/browser into the program", () => {
    // The regression this test exists for: the browser half once compiled to an
    // empty program (an inherited `exclude` quietly emptied the include), and
    // fourteen type errors lived in files nothing checked.
    const expected = filesUnder("src/browser");
    expect(expected.length).toBeGreaterThan(0);
    for (const file of expected) {
      expect(run.program.join("\n"), `${file} is missing from the type-check program`).toContain(file);
    }
  });

  it("covers the channel and the rendering test as well", () => {
    expect(run.program.join("\n")).toContain("apps/web/src/client/http-channel.ts");
    expect(run.program.join("\n")).toContain("apps/web/tests/shell-rendering.test.tsx");
  });

  it("keeps the server half out of the browser program", () => {
    expect(run.program.some((file) => file.includes("apps/web/src/server/"))).toBe(false);
  });
}, 120000);
