/**
 * The package boundary at runtime.
 *
 * A whitelist in a manifest is only a boundary if a consumer really cannot get
 * past it. These assertions resolve the packages by name, the way an outside
 * caller would, and check both halves: the root works, and every internal path
 * is refused.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

const IMPORT_PATTERN = /(?:import|export)[^;'"]*from\s+['"]([^'"]+)['"]/g;

/** Every module a file reaches, by following its relative imports. */
function importGraph(entry: string): { readonly files: readonly string[]; readonly bare: readonly string[] } {
  const visited = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? "";
      if (!specifier.startsWith(".")) {
        bare.add(specifier);
        continue;
      }
      queue.push(join(file, "..", specifier).split("\\").join("/").replace(/\.js$/, ".ts"));
    }
  }

  return { files: [...visited], bare: [...bare] };
}

describe("the public roots a consumer imports", () => {
  it("gives a client factory and its error class, and nothing else", async () => {
    const client = await import("@every-dagent/client");

    expect(typeof client.createClient).toBe("function");
    expect(typeof client.ClientError).toBe("function");
    expect("createClientWith" in client).toBe(false);
    expect("ClientConnection" in client).toBe(false);
    expect("createReverseTable" in client).toBe(false);
  });

  it("gives a host factory, and nothing else", async () => {
    const host = await import("@every-dagent/host");

    expect(typeof host.createHost).toBe("function");
    expect("composeHost" in host).toBe(false);
    expect("createConnection" in host).toBe(false);
    expect("createReverseTrigger" in host).toBe(false);
  });

  it("splits the web binding into a browser entry and a server entry", async () => {
    const browser = await import("@every-dagent/web/client");
    const server = await import("@every-dagent/web/server");

    expect(typeof browser.connectHttpChannel).toBe("function");
    expect("startHttpBinding" in browser).toBe(false);
    expect(typeof server.startHttpBinding).toBe("function");
    expect("connectHttpChannel" in server).toBe(false);
  });
});

describe("the acceptance fixture is an independent consumer", () => {
  it("reaches the client package and nothing that composes a host", () => {
    // The CLI fixture is the evidence that a second client works through the
    // protocol alone, so its own graph has to show exactly that.
    const { files, bare } = importGraph("tests/fixtures/client-cli.ts");

    expect([...bare].sort()).toEqual(["@every-dagent/client", "@every-dagent/protocol"]);
    expect(files.some((file) => file.includes("helpers/platform"))).toBe(false);
    expect(files.some((file) => file.includes("packages/host"))).toBe(false);
    expect(files.some((file) => file.includes("packages/client/src"))).toBe(false);
  });
});

describe("the internal seams a consumer must not reach", () => {
  const refused = [
    "@every-dagent/client/src/client.js",
    "@every-dagent/client/src/connection.js",
    "@every-dagent/client/src/reverse.js",
    "@every-dagent/client/src/index.js",
    "@every-dagent/host/src/host.js",
    "@every-dagent/host/src/reverse.js",
    "@every-dagent/host/src/state.js",
    "@every-dagent/web/src/transport/queue.js",
    "@every-dagent/web/src/client/http-channel.js",
  ];

  for (const specifier of refused) {
    it(`refuses to resolve ${specifier}`, async () => {
      await expect(import(/* @vite-ignore */ specifier)).rejects.toThrow();
    });
  }
});
