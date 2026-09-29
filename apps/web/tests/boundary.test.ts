/**
 * The package's boundaries, checked against the source itself.
 *
 * Two claims matter here. The browser half must be importable into a page: it
 * may reach `fetch`, streams and timers, and nothing that only a server has. And
 * the server half must not leak into it — a page that pulled in `node:http` or
 * the host's composition would be a page that cannot run.
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
const srcRelative = srcFiles.map((file) => file.slice(srcRoot.length + 1).replace(/\\/g, "/"));
const browserFiles = srcRelative.filter((file) => file.startsWith("client/") || file.startsWith("transport/"));

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
        "client/http-channel.ts",
        "index.ts",
        "server/http-binding.ts",
        "transport/framing.ts",
        "transport/limits.ts",
        "transport/queue.ts",
      ].sort(),
    );
  });

  it("imports only its own modules, the protocol package and node builtins", () => {
    const offenders: string[] = [];
    for (const file of srcFiles) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const allowed =
          specifier.startsWith("./") ||
          specifier.startsWith("../") ||
          specifier === "@every-dagent/protocol" ||
          specifier.startsWith("node:");
        if (!allowed) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the browser half free of node builtins and of the server half", () => {
    for (const file of browserFiles) {
      const source = readFileSync(join(srcRoot, file), "utf8");
      expect(source, `${file} must not import a node builtin`).not.toMatch(/from\s+["']node:/);
      expect(source, `${file} must not import the server binding`).not.toMatch(/from\s+["'][^"']*server\//);
      expect(source, `${file} must not import a host or a provider`).not.toMatch(/@every-dagent\/(host|agent-core|plugin-system)/);
    }
  });

  it("carries no host, provider, UI or framework dependency in src", () => {
    const forbidden = [
      /\bpi-ai\b/,
      /\bReact\b/,
      /\breact-dom\b/,
      /\bexpress\b/i,
      /\bfastify\b/i,
      /\bsocket\.io\b/i,
      /\bws\b/,
      /\bvalibot\b/,
      /\bas\s+never\b/,
      /\bas\s+any\b/,
      /@ts-(ignore|expect-error|nocheck)/,
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
      exports?: unknown;
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.name).toBe("@every-dagent/web");
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("./src/index.ts");
    expect(manifest.types).toBe("./src/index.ts");
    expect(manifest.exports).toBeUndefined();
    expect(manifest.dependencies).toEqual({ "@every-dagent/protocol": "workspace:*" });
    expect(manifest.devDependencies).toBeUndefined();
  });
});

describe("public surface", () => {
  it("exports the binding, the channel and the transport primitives", async () => {
    const web = await import("../src/index.js");

    expect(Object.keys(web).sort()).toEqual([
      "DEFAULT_WEB_LIMITS",
      "FRAME_LIMIT_BYTES",
      "RECORD_LIMIT_BYTES",
      "connectHttpChannel",
      "createFrameQueue",
      "createSseParser",
      "encodeSseComment",
      "encodeSseRecord",
      "startHttpBinding",
      "unwrapRecord",
      "utf8Length",
      "wrapFrame",
    ]);
  });

  it("knows nothing about the application it carries", async () => {
    const web = await import("../src/index.js");
    const source = Object.values(web).map((value) => String(value)).join("\n");

    expect(source).not.toMatch(/\b(session|run|plugin|agent|tool)\b/i);
  });
});
