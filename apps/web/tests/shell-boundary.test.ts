/**
 * The shell's boundaries: what the page may reach, and what the server may
 * reach, checked against the source.
 *
 * Three layers now live in one package, and each has exactly one job:
 *
 *   - the transport (checked in `boundary.test.ts`) carries frames;
 *   - the browser shell renders a client snapshot inside a page and may reach
 *     the browser-safe channel, React, and the client's public entry — and
 *     nothing that only exists on a server;
 *   - the application server composes the page server, the binding and a host,
 *     and may reach node and the host — and nothing that renders.
 *
 * The walk from the browser entry follows imports like a bundler would, so the
 * check is about what the page can actually reach, not about what each file
 * happens to spell. The built artifact is checked separately, against esbuild's
 * own metafile, in `shell-bundle.test.ts`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
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

const srcFiles = listFiles(srcRoot).filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
const srcRelative = srcFiles.map((file) => file.slice(srcRoot.length + 1).replace(/\\/g, "/"));

const TRANSPORT_FILES = [
  "client/http-channel.ts",
  "index.ts",
  "server/http-binding.ts",
  "transport/framing.ts",
  "transport/ledger.ts",
  "transport/limits.ts",
  "transport/queue.ts",
];
const BROWSER_FILES = srcRelative.filter((file) => file.startsWith("browser/"));
const SERVER_FILES = srcRelative.filter((file) => file.startsWith("server/") && !TRANSPORT_FILES.includes(file));

interface Imported {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

/** Every import in a file, with the `type` keyword noted where it was written. */
function importsOf(source: string): Imported[] {
  const out: Imported[] = [];
  const statement = /import\s+(type\s+)?([^;]*?)from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(statement)) {
    out.push({ specifier: match[3] ?? "", typeOnly: match[1] !== undefined });
  }
  const sideEffect = /import\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(sideEffect)) {
    out.push({ specifier: match[1] ?? "", typeOnly: false });
  }
  return out;
}

/** A relative specifier resolved against the file that wrote it. */
function resolveRelative(from: string, specifier: string): string {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier)).replace(/\.js$/, "");
  // TypeScript's own resolution: a `.js` specifier may name a `.ts` or a
  // `.tsx` file, and the walk must land on the file that actually exists.
  for (const extension of [".ts", ".tsx"]) {
    if (existsSync(join(srcRoot, base + extension))) return base + extension;
  }
  return `${base}.ts`;
}

const BROWSER_BARE_ALLOWED = new Set(["react", "react-dom", "react-dom/client", "@every-dagent/client"]);

describe("the source tree is partitioned", () => {
  it("puts every file under exactly one of the three layers", () => {
    const covered = new Set([...TRANSPORT_FILES, ...BROWSER_FILES, ...SERVER_FILES]);
    expect(srcRelative.filter((file) => !covered.has(file))).toEqual([]);
  });

  it("has a browser layer and a server layer with the planned files", () => {
    expect([...BROWSER_FILES].sort()).toEqual(
      [
        "browser/App.tsx",
        "browser/Composer.tsx",
        "browser/ConnectionStatus.tsx",
        "browser/ConnectionPanel.tsx",
        "browser/Conversation.tsx",
        "browser/HostPanel.tsx",
        "browser/NoticesPanel.tsx",
        "browser/PluginsPanel.tsx",
        "browser/RunStrip.tsx",
        "browser/SessionsPanel.tsx",
        "browser/ToolCard.tsx",
        "browser/controller.ts",
        "browser/main.tsx",
        "browser/presentation.ts",
        "browser/selection.ts",
        "browser/use-shell.ts",
      ].sort(),
    );
    expect([...SERVER_FILES].sort()).toEqual(["server/main.ts", "server/shell-server.ts", "server/static-server.ts"]);
  });
});

describe("what the browser layer may reach", () => {
  it("imports only the page's own files, the browser-safe channel, React and the client entry", () => {
    const offenders: string[] = [];
    for (const file of BROWSER_FILES) {
      for (const imported of importsOf(readFileSync(join(srcRoot, file), "utf8"))) {
        const { specifier } = imported;
        if (specifier.startsWith(".")) {
          const target = resolveRelative(file, specifier);
          const allowed = target.startsWith("browser/") || target === "client/http-channel.ts";
          if (!allowed) offenders.push(`${file}: ${specifier}`);
          continue;
        }
        if (specifier === "@every-dagent/protocol") {
          // The page sees the protocol's *types*; a value import would drag the
          // validator into a place that has no business validating.
          if (!imported.typeOnly) offenders.push(`${file}: value import of @every-dagent/protocol`);
          continue;
        }
        if (!BROWSER_BARE_ALLOWED.has(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never mentions a server-only package, a node builtin or a bypass", () => {
    const forbidden = [
      /@every-dagent\/(host|agent-core|plugin-system|model-pi-ai)/,
      /from\s+["']node:/,
      /\bpi-ai\b/,
      /\bexpress\b/i,
      /\bvitest\b/,
      /\bas\s+never\b/,
      /\bas\s+any\b/,
      /@ts-(ignore|expect-error|nocheck)/,
    ];
    for (const file of BROWSER_FILES) {
      const source = readFileSync(join(srcRoot, file), "utf8");
      for (const pattern of forbidden) {
        expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps the whole graph the page entry reaches inside the browser layer and its two leaves", () => {
    const visited = new Set<string>();
    const queue = ["browser/main.tsx"];
    const offenders: string[] = [];

    while (queue.length > 0) {
      const file = queue.shift();
      if (file === undefined || visited.has(file)) continue;
      visited.add(file);
      for (const imported of importsOf(readFileSync(join(srcRoot, file), "utf8"))) {
        const { specifier } = imported;
        if (!specifier.startsWith(".")) {
          if (specifier === "@every-dagent/protocol" && imported.typeOnly) continue;
          if (BROWSER_BARE_ALLOWED.has(specifier)) continue;
          offenders.push(`${file}: ${specifier}`);
          continue;
        }
        const target = resolveRelative(file, specifier);
        const allowed =
          target.startsWith("browser/") || target.startsWith("transport/") || target === "client/http-channel.ts";
        if (!allowed) {
          offenders.push(`${file}: ${specifier}`);
          continue;
        }
        queue.push(target);
      }
    }

    expect(offenders).toEqual([]);
    // The walk is real: it saw React, the shell, the channel and the transport.
    expect([...visited].some((file) => file.startsWith("browser/"))).toBe(true);
    expect([...visited]).toContain("client/http-channel.ts");
    expect([...visited].some((file) => file.startsWith("transport/"))).toBe(true);
    expect([...visited].some((file) => file.includes("server"))).toBe(false);
    expect([...visited].some((file) => file.startsWith("packages/") || file.includes("node_modules"))).toBe(false);
  });
});

describe("what the server layer may reach", () => {
  it("imports only node, its own files, the host and the protocol's types", () => {
    const offenders: string[] = [];
    for (const file of SERVER_FILES) {
      for (const imported of importsOf(readFileSync(join(srcRoot, file), "utf8"))) {
        const { specifier } = imported;
        if (specifier.startsWith(".")) {
          const target = resolveRelative(file, specifier);
          if (!target.startsWith("server/") && !target.startsWith("transport/")) offenders.push(`${file}: ${specifier}`);
          continue;
        }
        if (specifier.startsWith("node:")) continue;
        if (specifier === "@every-dagent/host") continue;
        if (specifier === "@every-dagent/protocol") {
          if (!imported.typeOnly) offenders.push(`${file}: value import of @every-dagent/protocol`);
          continue;
        }
        offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never renders and never drags a page into the server", () => {
    const forbidden = [/\breact(-dom)?\b/i, /\bpi-ai\b/, /\bvitest\b/, /\bas\s+never\b/, /\bas\s+any\b/, /@ts-(ignore|expect-error|nocheck)/];
    for (const file of SERVER_FILES) {
      const source = readFileSync(join(srcRoot, file), "utf8");
      for (const pattern of forbidden) {
        expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

describe("the package manifest", () => {
  it("pins the approved dependency set and the separable entries", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      name: string;
      private: boolean;
      type: string;
      main: string;
      types: string;
      exports?: Record<string, { readonly default?: string }>;
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.name).toBe("@every-dagent/web");
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("./src/index.ts");
    expect(manifest.types).toBe("./src/index.ts");
    // Three entries, and the two halves are separable: a browser imports
    // `@every-dagent/web/client` and never sees the server's modules.
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual([".", "./client", "./server"]);
    expect(manifest.exports?.["./client"]?.default).toBe("./src/client/http-channel.ts");
    expect(manifest.exports?.["./server"]?.default).toBe("./src/server/http-binding.ts");
    // The approved P3.4 set: the transport's protocol dependency plus the
    // shell's own — the client entry for the page, the host for the server
    // composition, and React for rendering. Nothing else, in either direction.
    expect(manifest.dependencies).toEqual({
      "@every-dagent/client": "workspace:*",
      "@every-dagent/host": "workspace:*",
      "@every-dagent/protocol": "workspace:*",
      react: "19.3.0",
      "react-dom": "19.3.0",
    });
    expect(manifest.devDependencies).toBeUndefined();
  });
});
