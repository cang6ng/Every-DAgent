/**
 * The package's boundaries, checked against the source itself.
 *
 * The client is the one place that must not be able to reach a host, a
 * provider, a browser or a React tree: everything it may touch is a JSON frame
 * and its own state. These assertions are the mechanical half of that claim.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const srcRoot = join(packageRoot, "src");

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

const srcFiles = listFiles(srcRoot).filter((file) => file.endsWith(".ts"));
const srcRelative = srcFiles.map((file) => file.slice(srcRoot.length + 1));

const IMPORT_PATTERN =
  /(?:import|export)[^;'"]*from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    specifiers.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return specifiers;
}

describe("dependency boundary", () => {
  it("keeps the source tree to the planned modules", () => {
    expect([...srcRelative].sort()).toEqual(
      [
        "client.ts",
        "connection.ts",
        "errors.ts",
        "fold.ts",
        "index.ts",
        "reverse.ts",
        "store.ts",
      ].sort(),
    );
  });

  it("imports only its own modules and the one workspace package it declares", () => {
    const offenders: string[] = [];
    for (const file of srcFiles) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const allowed = specifier.startsWith("./") || specifier === "@every-dagent/protocol";
        if (!allowed) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("carries no host, provider, UI, network or process-level dependency in src", () => {
    const forbidden = [
      /\bpi-ai\b/,
      /\bReact\b/,
      /\breact-dom\b/,
      /\bWebSocket\b/,
      /\bEventSource\b/,
      /\bXMLHttpRequest\b/,
      /\bdocument\s*\./,
      /\bwindow\s*\./,
      /\bfetch\s*\(/,
      /\bprocess\s*\./,
      /\bBuffer\b/,
      /\brequire\s*\(/,
      /\bvalibot\b/,
      /\bas\s+never\b/,
      /\bas\s+any\b/,
      /@ts-(ignore|expect-error|nocheck)/,
      /@every-dagent\/(host|agent-core|plugin-system|model-pi-ai|plugin-calculator)/,
      /\bvitest\b/,
    ];
    for (const file of srcFiles) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("pins the package manifest: private ESM source package with one workspace dependency", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      name: string;
      private: boolean;
      type: string;
      main: string;
      types: string;
      exports?: Record<string, unknown>;
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.name).toBe("@every-dagent/client");
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("./src/index.ts");
    expect(manifest.types).toBe("./src/index.ts");
    // One entry point, and no other: a consumer cannot reach the composition
    // seam or any internal module by package subpath.
    expect(Object.keys(manifest.exports ?? {})).toEqual(["."]);
    expect(manifest.dependencies).toEqual({ "@every-dagent/protocol": "workspace:*" });
    expect(manifest.devDependencies).toBeUndefined();
  });
});

describe("public surface", () => {
  it("exports exactly the factory and the error class", async () => {
    const client = await import("../src/index.js");

    expect(Object.keys(client).sort()).toEqual(["ClientError", "createClient"]);
  });

  it("does not hand out the connection, the store or the composition seam", async () => {
    const client = await import("../src/index.js");
    const exported = Object.keys(client);

    expect(exported).not.toContain("createClientWith");
    expect(exported).not.toContain("ClientConnection");
    expect(exported).not.toContain("createStore");
    expect(exported).not.toContain("createReverseTable");
  });

  it("hands out nothing that could send an arbitrary request", async () => {
    const client = await import("../src/index.js");
    const factory = client.createClient({
      connect: () => {
        throw new Error("never connected");
      },
    });

    // The facade is the twelve frozen operations, and nothing shaped like a
    // generic request entry point.
    expect(Object.keys(factory).sort()).toEqual([
      "closeSubscription",
      "connect",
      "disconnect",
      "getSnapshot",
      "getState",
      "plugins",
      "reconnect",
      "resync",
      "runs",
      "sessions",
      "subscribe",
    ]);
    expect(Object.keys(factory.sessions).sort()).toEqual(["create", "get", "list"]);
    expect(Object.keys(factory.runs).sort()).toEqual(["cancel", "get", "start"]);
    expect(Object.keys(factory.plugins).sort()).toEqual(["disable", "enable", "list"]);
  });
});
