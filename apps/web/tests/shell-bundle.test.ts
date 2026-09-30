/**
 * What the build actually produced.
 *
 * The boundary tests check the source; these check the artifact, from
 * esbuild's own metafile, because the claim that matters is about what a page
 * downloads — a page bundle that reached a host, a provider or a `node:`
 * builtin would be a page that cannot run or that leaked what it must not.
 * The bundle is read as inert text too: the server's names must not appear in
 * the page's file at all.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type BuildAppResult } from "../scripts/build.mjs";

const outDir = mkdtempSync(join(tmpdir(), "every-dagent-bundle-"));
let result: BuildAppResult;

function inputsOf(metafile: BuildAppResult["browserMetafile"]): string[] {
  return Object.keys(metafile.inputs).map((file) => file.replace(/\\/g, "/"));
}

beforeAll(async () => {
  result = await buildApp({ outDir });
}, 60000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("the browser bundle", () => {
  it("contains the shell, React and the client — and nothing behind the protocol", () => {
    const inputs = inputsOf(result.browserMetafile);

    expect(inputs.some((file) => file.endsWith("apps/web/src/browser/main.tsx"))).toBe(true);
    expect(inputs.some((file) => file.includes("node_modules/react/"))).toBe(true);
    expect(inputs.some((file) => file.includes("node_modules/react-dom/"))).toBe(true);
    expect(inputs.some((file) => file.includes("packages/client/src/"))).toBe(true);
    expect(inputs.some((file) => file.includes("valibot"))).toBe(true);

    const forbidden = [/packages\/(host|agent-core|plugin-system|model-pi-ai)\//, /apps\/web\/src\/server\//, /apps\/web\/tests\//, /^node:/, /pi-ai/];
    for (const pattern of forbidden) {
      expect(inputs.filter((file) => pattern.test(file)), `browser bundle must not include ${pattern}`).toEqual([]);
    }
  });

  it("reads as inert assets: no server entry points in the page's file", () => {
    const app = readFileSync(join(outDir, "public", "app.js"), "utf8");
    expect(app).not.toContain("startHttpBinding");
    expect(app).not.toContain("createShellHost");
    expect(app).not.toContain("pi-ai");
    // The page auto-connects only through the client's own channel.
    expect(app).toContain("connectHttpChannel");
  });

  it("ships the page beside the bundle it loads", () => {
    const html = readFileSync(join(outDir, "public", "index.html"), "utf8");
    expect(html).toContain('src="/app.js"');
    expect(html).toContain('href="/styles.css"');
    expect(existsSync(join(outDir, "public", "app.js"))).toBe(true);
    expect(existsSync(join(outDir, "public", "styles.css"))).toBe(true);
  });
});

describe("the server bundle", () => {
  it("contains the host composition and none of the page", () => {
    const inputs = inputsOf(result.serverMetafile);

    expect(inputs.some((file) => file.endsWith("apps/web/src/server/main.ts"))).toBe(true);
    expect(inputs.some((file) => file.includes("packages/host/src/"))).toBe(true);

    const forbidden = [/node_modules\/react(-dom)?\//, /apps\/web\/src\/browser\//];
    for (const pattern of forbidden) {
      expect(inputs.filter((file) => pattern.test(file)), `server bundle must not include ${pattern}`).toEqual([]);
    }
  });

  it("is a single runnable file next to the page it serves", () => {
    expect(existsSync(join(outDir, "server.mjs"))).toBe(true);
    const server = readFileSync(join(outDir, "server.mjs"), "utf8");
    expect(server).toContain("createShellHost");
    expect(server).toContain("./public/");
  });
});
