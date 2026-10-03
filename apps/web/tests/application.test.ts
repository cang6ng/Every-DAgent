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
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient } from "@every-dagent/client";
import { createHost } from "@every-dagent/host";
import { TEST_BOOTSTRAP, testComposition } from "../../../tests/helpers/test-composition.js";

import { connectHttpChannel } from "../src/index.js";
import { parseCliArgs, runShellCli } from "../src/server/main.js";
import { startShellServer, type ShellServer } from "../src/server/shell-server.js";
import { startStaticServer, type StaticServer } from "../src/server/static-server.js";
import { ensureShellBuild } from "./helpers/shell-server.js";
import { offlineModel } from "./helpers/offline-model.js";

/** The capability a composed fixture model declares: finite, and easy to read. */
const FIXTURE_LIMITS = {
  contextWindow: 128 * 1024,
  maxOutputTokens: 8 * 1024,
  framing: {
    request: 256,
    system: 64,
    message: 64,
    toolDefinition: 128,
    toolCall: 64,
    toolResult: 64,
  },
};
const FIXTURE_LIMITS_JSON = JSON.stringify(FIXTURE_LIMITS);

let outDir: string;
let pages: StaticServer;
let shell: ShellServer;
const closers: (() => Promise<void>)[] = [];

/** One raw HTTP exchange, byte for byte, so a malformed target can be sent. */
function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("close", () => {
      resolve(received);
    });
    socket.on("error", reject);
  });
}

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
  const host = await createHost({
    bootstrap: TEST_BOOTSTRAP,
    composition: testComposition({ modelClient: offlineModel().client }),
    plugins: [],
  });
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

  it("serves pages over an IPv6 loopback base", async () => {
    // `::1` used to be accepted as an address but crashed the process on the
    // first request: the URL base was built from the raw address, and
    // `http://::1:PORT` is not a URL anything can parse.
    const ipv6 = await startStaticServer({ root: join(outDir, "public"), address: "::1" });
    try {
      expect(ipv6.origin.startsWith("http://[::1]:")).toBe(true);
      const response = await fetch(`${ipv6.origin}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('id="root"');
    } finally {
      await ipv6.close();
    }
  });

  it("follows a link that stays inside the root and refuses one that leaves it", async () => {
    // A symlink or junction inside the root is a path that is lexically inside
    // and physically outside; only resolving the physical target tells them
    // apart, and only the alias that stays in may be served.
    const rootDir = join(outDir, "link-root");
    const escapeDir = join(outDir, "link-outside");
    mkdirSync(join(rootDir, "inner"), { recursive: true });
    mkdirSync(escapeDir, { recursive: true });
    writeFileSync(join(rootDir, "index.html"), "<!doctype html><p>inside</p>");
    writeFileSync(join(rootDir, "inner", "page.html"), "<!doctype html><p>inner</p>");
    writeFileSync(join(escapeDir, "secret.txt"), "should-never-be-served");
    writeFileSync(join(escapeDir, "index.html"), "should-never-be-served either");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(join(rootDir, "inner"), join(rootDir, "alias"), linkType);
    symlinkSync(escapeDir, join(rootDir, "escape"), linkType);

    const server = await startStaticServer({ root: rootDir });
    try {
      expect((await fetch(`${server.origin}/alias/page.html`)).status).toBe(200);
      expect((await fetch(`${server.origin}/escape/secret.txt`)).status).toBe(404);
      expect((await fetch(`${server.origin}/escape/`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("answers a malformed request target instead of dying with it", async () => {
    // A request target the URL parser refuses must be a 400 on that one
    // connection — not an exception thrown inside the request listener, which
    // would end the process and every other page request with it.
    const port = Number(new URL(pages.origin).port);
    const malformed = await rawRequest(
      port,
      `GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    expect(malformed).toContain("400");

    const still = await fetch(`${pages.origin}/`);
    expect(still.status).toBe(200);
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
    await waitFor(() => client.getSnapshot().presentation?.sessions.items.length === 1, "the session event");
    expect(client.getSnapshot().presentation?.sessions.items[0]?.sessionId).toBe(session.sessionId);

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

  it("shuts the composed host down when the page server cannot start", async () => {
    // The host exists before the page server is even attempted, so a shell that
    // refuses to start must release it: otherwise the composition's runtime and
    // plugins stay alive with no page that could ever attach.
    const marker = join(outDir, "host-shutdown.marker");
    const compositionPath = join(outDir, "composition-failing-start.mjs");
    writeFileSync(
      compositionPath,
      [
        'import { writeFileSync } from "node:fs";',
        'import { createHost } from "./server.mjs";',
        "export async function createShellHost() {",
        `  const modelClient = { limits: ${FIXTURE_LIMITS_JSON}, stream: async function* () { yield { type: "done" }; } };`,
        `  const host = await createHost({`,
        `    bootstrap: { host: { systemPrompt: "", loop: { maxSteps: 12, maxModelAttempts: 3 } }, model: { provider: "fixture", model: "fixture" } },`,
        `    composition: {`,
        `      validateModel: (value) =>`,
        `        typeof value === "object" && value !== null && !Array.isArray(value) && value.provider === "fixture" && value.model === "fixture"`,
        `          ? { ok: true }`,
        `          : { ok: false, reason: "unknown-provider-model" },`,
        `      compose: async () => ({ modelClient }),`,
        `    },`,
        `    plugins: [],`,
        `  });`,
        "  return {",
        "    attach: (channel) => host.attach(channel),",
        `    shutdown: async () => { await host.shutdown(); writeFileSync(${JSON.stringify(marker)}, "released"); },`,
        "  };",
        "}",
        "",
      ].join("\n"),
    );

    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    try {
      // `0.0.0.0` is not loopback: the page server refuses it, deterministically.
      const code = await runShellCli(["--composition", compositionPath, "--address", "0.0.0.0"], io);
      expect(code).toBe(1);
      expect(lines.join("\n")).toContain("loopback only");
      expect(existsSync(marker), "the composed host must have been shut down").toBe(true);
    } finally {
      rmSync(compositionPath, { force: true });
      rmSync(marker, { force: true });
    }
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
        "export async function createShellHost() {",
        `  const modelClient = { limits: ${FIXTURE_LIMITS_JSON}, stream: async function* () { yield { type: "done" }; } };`,
        "  return createHost({",
        '    bootstrap: { host: { systemPrompt: "", loop: { maxSteps: 12, maxModelAttempts: 3 } }, model: { provider: "fixture", model: "fixture" } },',
        "    composition: {",
        "      validateModel: (value) =>",
        '        typeof value === "object" && value !== null && !Array.isArray(value) && value.provider === "fixture" && value.model === "fixture"',
        "          ? { ok: true }",
        '          : { ok: false, reason: "unknown-provider-model" },',
        "      compose: async () => ({ modelClient }),",
        "    },",
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
