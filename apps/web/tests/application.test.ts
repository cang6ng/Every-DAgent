/**
 * The application the shell actually serves: the page server, the shell server
 * and the command line.
 *
 * What is checked here is the composition, not the browser: pages come from the
 * static server's origin and only that origin may talk to the binding, a real
 * client can connect to the binding the shell server started, and the command
 * line refuses to invent a host while starting cleanly when one is composed for
 * it — in a real `node` process, from the built bundle, exactly the way an
 * operator would.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient } from "@every-dagent/client";
import { createHost } from "@every-dagent/host";

import { connectHttpChannel } from "../src/index.js";
import { parseCliArgs, runShellCli } from "../src/server/main.js";
import { startShellServer, type ShellServer } from "../src/server/shell-server.js";
import { startStaticServer, type StaticServer } from "../src/server/static-server.js";
import { ensureShellBuild } from "./helpers/shell-server.js";
import { offlineModel } from "./helpers/offline-model.js";

let outDir: string;
let pages: StaticServer;
let shell: ShellServer;
const closers: (() => Promise<void>)[] = [];

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

beforeAll(async () => {
  outDir = await ensureShellBuild();
  pages = await startStaticServer({ root: join(outDir, "public") });
  const host = createHost({ modelClient: offlineModel().client, plugins: [] });
  shell = await startShellServer({ host, staticRoot: join(outDir, "public") });
  closers.push(async () => {
    await shell.close();
    await pages.close();
    await host.shutdown();
  });
}, 60000);

afterAll(async () => {
  for (const closer of closers.splice(0)) await closer();
});

describe("the page server", () => {
  it("serves the page, its bundle and nothing outside its root", async () => {
    const index = await fetch(`${pages.origin}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain('id="root"');

    const bundle = await fetch(`${pages.origin}/app.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("text/javascript");

    const styles = await fetch(`${pages.origin}/styles.css`);
    expect(styles.status).toBe(200);
    expect(styles.headers.get("content-type")).toContain("text/css");

    expect((await fetch(`${pages.origin}/missing.txt`)).status).toBe(404);
    // A traversal that a naive join would honour: the encoded slashes are the
    // path, not a way out of the root.
    expect((await fetch(`${pages.origin}/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${pages.origin}/`, { method: "POST" })).status).toBe(405);
  });
});

describe("the shell server", () => {
  it("points the page at the binding it started", () => {
    expect(shell.pageUrl.startsWith(`${shell.pageOrigin}/?binding=`)).toBe(true);
    expect(decodeURIComponent(shell.pageUrl.split("binding=")[1] ?? "")).toBe(shell.bindingOrigin);
  });

  it("lets the page's own origin reach the binding, and nothing else", async () => {
    const created = await fetch(`${shell.bindingOrigin}/connections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-every-dagent-transport": "1",
        origin: shell.pageOrigin,
      },
      body: "{}",
    });
    expect(created.status).toBe(201);

    const refused = await fetch(`${shell.bindingOrigin}/connections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-every-dagent-transport": "1",
        origin: "http://127.0.0.1:1",
      },
      body: "{}",
    });
    expect(refused.status).toBe(403);
  });

  it("carries a real client through describe, sessions and the page's own address", async () => {
    // The same channel a browser page gets, driven from node: the binding the
    // shell server composed is a real binding, not a page-shaped stub.
    const client = createClient({ connect: () => connectHttpChannel({ origin: shell.bindingOrigin }) });
    await client.connect();
    expect(client.getSnapshot().status).toBe("ready");

    const { session } = await client.sessions.create();
    await waitFor(() => client.getSnapshot().presentation?.sessions.length === 1, "the session event");
    expect(client.getSnapshot().presentation?.sessions[0]?.sessionId).toBe(session.sessionId);

    client.disconnect();
  });
});

describe("the shell command line", () => {
  it("parses both modes and refuses a run without one", () => {
    expect(parseCliArgs(["--binding", "http://127.0.0.1:1"])).toMatchObject({ mode: { kind: "binding" } });
    expect(parseCliArgs(["--composition", "./host.mjs"])).toMatchObject({ mode: { kind: "composition" } });
    expect(parseCliArgs(["--port", "8080", "--binding", "http://127.0.0.1:1"])).toMatchObject({ port: 8080 });

    expect(parseCliArgs([])).toHaveProperty("error");
    expect(parseCliArgs(["--composition", "a", "--binding", "b"])).toHaveProperty("error");
    expect(parseCliArgs(["--port", "abc"])).toHaveProperty("error");
    expect(parseCliArgs(["--nonsense"])).toHaveProperty("error");
  });

  it("reports missing configuration instead of inventing a host", async () => {
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };

    expect(await runShellCli([], io)).toBe(2);
    expect(lines.join("\n")).toContain("no host configured");

    lines.length = 0;
    expect(await runShellCli(["--composition", "does-not-exist.mjs"], io)).toBe(1);
    expect(lines.join("\n")).toContain("does-not-exist.mjs");
  });

  it("serves pages for an existing binding, and stops on the signal", async () => {
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    let pageStatus = 0;

    const code = await runShellCli(
      ["--binding", shell.bindingOrigin, "--port", "0", "--static-root", join(outDir, "public")],
      io,
      async () => {
        // The stop hook is the moment the servers are up and nothing is closed
        // yet — the only place a caller can still talk to them.
        const pageLine = lines.find((line) => line.trim().startsWith("page:")) ?? "";
        const pageOrigin = pageLine.trim().split(/\s+/)[1]?.split("/?")[0] ?? "";
        expect(pageLine).toContain(`binding=${encodeURIComponent(shell.bindingOrigin)}`);
        pageStatus = (await fetch(pageOrigin)).status;
        return 0;
      },
    );

    expect(code).toBe(0);
    expect(pageStatus).toBe(200);
  });

  it("composes a host from a module, serves it, and closes on the stop signal", async () => {
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    let pageOrigin = "";
    let pageStatus = 0;

    const code = await runShellCli(
      ["--composition", "apps/web/tests/fixtures/offline-composition.mjs", "--static-root", join(outDir, "public")],
      io,
      async () => {
        const pageLine = lines.find((line) => line.trim().startsWith("page:")) ?? "";
        pageOrigin = pageLine.trim().split(/\s+/)[1]?.split("/?")[0] ?? "";
        pageStatus = (await fetch(pageOrigin)).status;
        return 0;
      },
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("host composed by");
    expect(pageStatus).toBe(200);
    // The stop hook is the signal path: after it, both servers are closed.
    await expect(fetch(pageOrigin)).rejects.toThrow();
  });

  it("starts the built server in a real node process and serves the page", async () => {
    // The production path, in its own process: the bundle composes a host from
    // an operator's module (which may only rely on the bundle itself) and
    // serves the page without any further configuration.
    const compositionPath = join(outDir, "composition-for-test.mjs");
    writeFileSync(
      compositionPath,
      [
        'import { createHost } from "./server.mjs";',
        "export function createShellHost() {",
        "  return createHost({",
        '    modelClient: { stream: async function* () { yield { type: "done" }; } },',
        "    plugins: [],",
        "  });",
        "}",
        "",
      ].join("\n"),
    );

    const child = spawn(process.execPath, [join(outDir, "server.mjs"), "--composition", compositionPath, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    try {
      await waitFor(() => output.includes("page:"), `the server to report its page (got: ${output})`, 15000);
      const pageUrl = output.split("\n").find((line) => line.includes("page:"))?.trim().split(/\s+/)[1] ?? "";
      expect(pageUrl).toContain("/?binding=");

      const page = await fetch(pageUrl);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('id="root"');

      const exit = new Promise<number | null>((resolve) => {
        child.on("close", (code) => {
          resolve(code);
        });
      });
      if (process.platform === "win32") {
        // Windows has no signal delivery to a child process: `kill` terminates
        // it, and the graceful path is the in-process stop test above. What is
        // asserted here is that the process really ends and reported no
        // unhandled failure while it lived.
        expect(output).not.toContain("Unhandled");
        child.kill();
        await exit;
      } else {
        child.kill("SIGTERM");
        expect(await exit).toBe(0);
        expect(output).toContain("shutting down");
      }
    } finally {
      if (child.exitCode === null) child.kill();
      rmSync(compositionPath, { force: true });
    }
  }, 60000);
});
