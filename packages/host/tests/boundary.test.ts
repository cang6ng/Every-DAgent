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

/**
 * The Node builtins this host is composed of.
 *
 * The host is the Node side of the boundary: `node:sqlite` is its durable store
 * and `node:crypto` derives stable ids for the records it commits. Everything
 * else still has to be one of its own modules or a declared workspace package —
 * this is an allow-list of exactly what it uses, not a general permission.
 */
const NODE_IMPORTS = ["node:crypto", "node:sqlite"];

describe("dependency boundary", () => {
  it("keeps the source tree to the planned modules", () => {
    expect([...srcRelative].sort()).toEqual(
      [
        "connection.ts",
        "dispatch.ts",
        "errors.ts",
        "guard.ts",
        "history.ts",
        "host.ts",
        "index.ts",
        "limits.ts",
        "projection.ts",
        "registry-gate.ts",
        "repository.ts",
        "reverse.ts",
        "run.ts",
        "settings-profile.ts",
        "state.ts",
      ].sort(),
    );
  });

  it("imports only its own modules, the three workspace packages and the Node builtins it declares", () => {
    const offenders: string[] = [];
    for (const file of srcFiles) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const allowed =
          specifier.startsWith("./") ||
          WORKSPACE_IMPORTS.includes(specifier) ||
          NODE_IMPORTS.includes(specifier);
        if (!allowed) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("carries no provider, UI, network or process-level dependency anywhere in src", () => {
    // The import check above already rules out every package that is not one of
    // the three declared ones plus this host's own Node builtins; what remains
    // are the globals and shorthands that would let the host reach a browser, a
    // socket or a process anyway.
    //
    // Two v2 facts shape this list. `Buffer` is not on it: the host measures
    // UTF-8 bytes and encodes opaque cursors, which is what Buffer is for on
    // the Node side, and `node:crypto`/`node:sqlite` above are the same kind of
    // admission. And `window` is not a bare pattern: the run loader names its
    // own bounded read of turns `window` (run.ts), so what stays forbidden is a
    // reach into the *DOM* under that name.
    const forbidden = [
      /\bpi-ai\b/,
      /\bReact\b/,
      /\breact-dom\b/,
      /\bWebSocket\b/,
      /\bEventSource\b/,
      /\bXMLHttpRequest\b/,
      /\bdocument\s*\./,
      /\bwindow\s*\.\s*(?:document|navigator|location|localStorage|sessionStorage)\b/,
      /\bfetch\s*\(/,
      /\bprocess\s*\./,
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
      exports?: Record<string, unknown>;
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.name).toBe("@every-dagent/host");
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("./src/index.ts");
    expect(manifest.types).toBe("./src/index.ts");
    // One entry point, and no other: the composition seam is not a subpath.
    expect(Object.keys(manifest.exports ?? {})).toEqual(["."]);
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
