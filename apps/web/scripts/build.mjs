/**
 * The shell's build: one browser bundle, one server bundle, and the static
 * page next to them.
 *
 * esbuild is the tool the repository already carries, and nothing here needs
 * more: the browser bundle is an ESM file the page loads directly, the server
 * bundle is an ESM file node runs directly (the workspace's TypeScript sources
 * are bundled in — they are not runnable on their own), and the public folder
 * is copied next to both. Both builds keep a metafile so the acceptance tests
 * can assert what actually ended up in each artifact instead of trusting the
 * source tree alone.
 */

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export async function buildApp(options = {}) {
  const root = options.packageRoot ?? packageRoot;
  const outDir = options.outDir ?? join(root, "dist");
  const quiet = options.quiet ?? true;

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "public"), { recursive: true });

  const browser = await build({
    entryPoints: [join(root, "src", "browser", "main.tsx")],
    outfile: join(outDir, "public", "app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    metafile: true,
    logLevel: quiet ? "silent" : "info",
  });

  const server = await build({
    entryPoints: [join(root, "src", "server", "main.ts")],
    outfile: join(outDir, "server.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node22"],
    metafile: true,
    logLevel: quiet ? "silent" : "info",
  });

  await writeFile(join(outDir, "browser-metafile.json"), JSON.stringify(browser.metafile, null, 2));
  await writeFile(join(outDir, "server-metafile.json"), JSON.stringify(server.metafile, null, 2));

  // The page last: the bundles above live in the same folder.
  await cp(join(root, "public"), join(outDir, "public"), { recursive: true });

  return { outDir, browserMetafile: browser.metafile, serverMetafile: server.metafile };
}

const entry = process.argv[1] === undefined ? "" : pathToFileURL(process.argv[1]).href;
if (import.meta.url === entry) {
  const { outDir } = await buildApp();
  console.log(`built ${dirname(join(outDir, "x"))}: server.mjs, public/app.js, public/index.html, public/styles.css`);
}
