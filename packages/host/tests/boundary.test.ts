/**
 * The package's boundaries, checked against the source itself.
 *
 * A host is only as trustworthy as what it can reach: the composition decides
 * what goes in, and nothing else may come out. These assertions are about
 * imports, exports and the manifest — the things a reviewer would otherwise
 * have to verify by eye on every change.
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

const WORKSPACE_IMPORTS = [
  "@every-dagent/agent-core",
  "@every-dagent/plugin-system",
  "@every-dagent/protocol",
];

describe("dependency boundary", () => {
  it("keeps the source tree to the planned modules", () => {
    expect([...srcRelative].sort()).toEqual(
      [
        "connection.ts",
        "dispatch.ts",
        "errors.ts",
        "host.ts",
        "index.ts",
        "projection.ts",
        "registry-gate.ts",
        "run.ts",
        "state.ts",
      ].sort(),
    );
  });

  it("imports only its own modules and the three workspace packages it declares", () => {
    const offenders: string[] = [];
    for (const file of srcFiles) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const allowed = specifier.startsWith("./") || WORKSPACE_IMPORTS.includes(specifier);
        if (!allowed) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("carries no provider, UI, network or process-level dependency anywhere in src", () => {
    // The import check above already rules out every package that is not one of
    // the three declared ones; what remains are the globals and shorthands that
    // would let the host reach a browser, a socket or a process anyway.
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
      /\bas\s+never\b/,
      /@ts-(ignore|expect-error|nocheck)/,
      /@every-dagent\/(client|model-pi-ai|plugin-calculator)/,
      /\bvitest\b/,
    ];
    for (const file of srcFiles) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("pins the package manifest: private ESM source package with three workspace dependencies", () => {
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
    expect(manifest.name).toBe("@every-dagent/host");
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("./src/index.ts");
    expect(manifest.types).toBe("./src/index.ts");
    expect(manifest.exports).toBeUndefined();
    expect(manifest.dependencies).toEqual({
      "@every-dagent/agent-core": "workspace:*",
      "@every-dagent/plugin-system": "workspace:*",
      "@every-dagent/protocol": "workspace:*",
    });
    expect(manifest.devDependencies).toBeUndefined();
  });
});

describe("public surface", () => {
  it("exports exactly one runtime value and its types", async () => {
    const host = await import("../src/index.js");

    expect(Object.keys(host).sort()).toEqual(["createHost"]);
  });

  it("hands out no registry, session, manager or dispatcher", async () => {
    const host = await import("../src/index.js");
    const exported = Object.values(host);

    expect(exported).toHaveLength(1);
    expect(typeof exported[0]).toBe("function");
  });
});
