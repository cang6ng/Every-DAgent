/**
 * The transport's boundaries, checked against the source itself.
 *
 * These are the P3.3 rules, unchanged in scope: the seven files that carry
 * frames stay exactly these seven, they import only their own modules, the
 * protocol and node builtins, the browser half stays free of node builtins and
 * of the server half, and the browser entry's own import graph is walked
 * rather than trusted. The shell that now lives beside them has its own,
 * separate boundary file — `shell-boundary.test.ts` — so that adding a page
 * could not quietly loosen anything that was already checked here.
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

/** The seven transport files, and nothing else. */
const TRANSPORT_FILES = [
  "client/http-channel.ts",
  "index.ts",
  "server/http-binding.ts",
  "transport/framing.ts",
  "transport/ledger.ts",
  "transport/limits.ts",
  "transport/queue.ts",
];

/** The browser shell, as approved for P3.4. */
const BROWSER_FILES = [
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
];

/** The application server composition, as approved for P3.4. */
const SERVER_FILES = ["server/main.ts", "server/shell-server.ts", "server/static-server.ts"];

const srcFiles = listFiles(srcRoot).filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
const srcRelative = srcFiles.map((file) => file.slice(srcRoot.length + 1).replace(/\\/g, "/"));
const browserHalf = srcRelative.filter(
  (file) => file.startsWith("client/") || file.startsWith("transport/"),
);

const IMPORT_PATTERN =
  /(?:import|export)[^;'"]*from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    specifiers.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return specifiers;
}

/** A relative specifier resolved against the file that wrote it, the way TypeScript resolves it. */
function resolveRelative(from: string, specifier: string): string {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier)).replace(/\.js$/, "");
  // A `.js` specifier may name a `.ts` or a `.tsx` file; probing for the file
  // that actually exists is what lets the walk compare *targets*. A specifier
  // that names nothing still resolves to a path — which is exactly why the
  // caller must check the result against the allowed set.
  for (const extension of [".ts", ".tsx"]) {
    if (existsSync(join(srcRoot, base + extension))) return base + extension;
  }
  return `${base}.ts`;
}

/**
 * The transport walk itself, with the source of a file injected.
 *
 * Every edge is judged by the file the specifier *resolves to*, not by the
 * spelling of the specifier: a relative import that lands inside the server
 * composition is an offender no matter how it is written — `../server/x.js`,
 * a backslash spelling, a path that only normalizes after joining. The real
 * tree is walked with `readFileSync`; the synthetic edge in the test below uses
 * a stubbed reader to prove the rule itself, not just the current tree.
 */
function walkBrowserChannel(read: (file: string) => string | undefined): {
  readonly visited: Set<string>;
  readonly offenders: string[];
} {
  const visited = new Set<string>();
  const offenders: string[] = [];
  const queue = ["client/http-channel.ts"];

  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const source = read(file);
    if (source === undefined) {
      offenders.push(`${file}: could not be read`);
      continue;
    }
    for (const specifier of importSpecifiers(source)) {
      if (specifier === "@every-dagent/protocol") continue;
      if (!specifier.startsWith(".")) {
        offenders.push(`${file}: ${specifier}`);
        continue;
      }
      const target = resolveRelative(file, specifier);
      if (!TRANSPORT_FILES.includes(target)) {
        offenders.push(`${file}: ${specifier} → ${target}`);
        continue;
      }
      queue.push(target);
    }
  }

  return { visited, offenders };
}

describe("dependency boundary", () => {
  it("keeps the source tree to the planned modules", () => {
    expect([...srcRelative].sort()).toEqual([...TRANSPORT_FILES, ...BROWSER_FILES, ...SERVER_FILES].sort());
  });

  it("keeps the transport to its seven files", () => {
    const transport = srcRelative.filter((file) => !file.startsWith("browser/") && !SERVER_FILES.includes(file));
    expect([...transport].sort()).toEqual([...TRANSPORT_FILES].sort());
  });

  it("imports only its own modules, the protocol package and node builtins", () => {
    const offenders: string[] = [];
    for (const file of TRANSPORT_FILES) {
      for (const specifier of importSpecifiers(readFileSync(join(srcRoot, file), "utf8"))) {
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
    for (const file of browserHalf) {
      const source = readFileSync(join(srcRoot, file), "utf8");
      expect(source, `${file} must not import a node builtin`).not.toMatch(/from\s+["']node:/);
      expect(source, `${file} must not import the server binding`).not.toMatch(/from\s+["'][^"']*server\//);
      expect(source, `${file} must not import a host or a provider`).not.toMatch(/@every-dagent\/(host|agent-core|plugin-system)/);
    }
  });

  it("keeps everything the browser channel can reach inside the transport files", () => {
    // The channel is a real consuming path, so the check follows its imports by
    // resolving each relative specifier to the file it names — the transport
    // may reach its own files and the protocol contract, and nothing else: no
    // node builtin, no server implementation, no host.
    const { visited, offenders } = walkBrowserChannel((file) => {
      try {
        return readFileSync(join(srcRoot, file), "utf8");
      } catch {
        return undefined;
      }
    });

    expect(offenders).toEqual([]);
    // The graph really was walked: the transport primitives are in it.
    expect([...visited].some((file) => file.startsWith("transport/"))).toBe(true);
    expect([...visited].every((file) => TRANSPORT_FILES.includes(file))).toBe(true);
  });

  it("refuses an edge into the server composition however the specifier is spelled", () => {
    // The rule is about the resolved target, so an escape is caught by where it
    // lands — including spellings a substring check would sail past.
    const escapes = [
      // The obvious one.
      '../server/static-server.js',
      // A spelling no `includes("server/")` catches.
      '..\\server\\static-server.js',
      // Resolves into the server composition only after normalization.
      './.././server/main.js',
      // A path that names nothing at all is not an allowed edge either.
      '../server/not-a-file.js',
    ];
    for (const specifier of escapes) {
      const { offenders } = walkBrowserChannel((file) =>
        file === "client/http-channel.ts" ? `import { x } from ${JSON.stringify(specifier)};` : "",
      );
      expect(offenders, `${specifier} must be an offender`).not.toEqual([]);
    }
  });

  it("carries no host, provider, UI or framework dependency in the transport", () => {
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
    for (const file of TRANSPORT_FILES) {
      const source = readFileSync(join(srcRoot, file), "utf8");
      for (const pattern of forbidden) {
        expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
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
