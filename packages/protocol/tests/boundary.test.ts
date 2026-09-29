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

const IMPORT_PATTERN = /(?:import|export)[^;'"]*from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

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
        "channel.ts",
        "codec.ts",
        "contracts.ts",
        "events.ts",
        "index.ts",
        "json-value.ts",
        "operations.ts",
        "schemas.ts",
        "validation.ts",
      ].sort(),
    );
  });

  it("imports only relative modules and valibot — no core, plugin, provider, React or Node", () => {
    const offenders: string[] = [];
    for (const file of srcFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        const allowed = specifier.startsWith("./") || specifier === "valibot";
        if (!allowed) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("contains no Node builtins, globals or escape hatches anywhere in src", () => {
    const forbidden = [
      /node:/,
      /\brequire\s*\(/,
      /\bprocess\s*\./,
      /\bBuffer\b/,
      /\bglobalThis\s*\./,
      /\bdocument\b/,
      /\bwindow\b/,
      /\bReact\b/,
      /\breact\b/,
      /@every-dagent\/(agent-core|model-pi-ai|plugin-system|plugin-calculator|host|client)/,
      /\bpi-ai\b/,
      /\bvitest\b/,
    ];
    for (const file of srcFiles) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("pins the package manifest: private ESM source package with only valibot", () => {
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
    expect(manifest.name).toBe("@every-dagent/protocol");
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("./src/index.ts");
    expect(manifest.types).toBe("./src/index.ts");
    expect(manifest.exports).toBeUndefined();
    expect(manifest.dependencies).toEqual({ valibot: "1.5.0" });
    expect(manifest.devDependencies).toBeUndefined();
  });

  it("pins the package tsconfig: production closure with no ambient Node or DOM types", () => {
    const tsconfig = JSON.parse(readFileSync(join(packageRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions: { types: string[]; lib?: string[] };
      include: string[];
    };
    expect(tsconfig.compilerOptions.types).toEqual([]);
    expect(tsconfig.include).toEqual(["src"]);
  });

  it("keeps the reverse business registry empty in production code", () => {
    for (const file of srcFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must not register reverse methods`).not.toMatch(/test\.ping|test\.echo/);
      expect(source, `${file} must not name product reverse methods`).not.toMatch(
        /\bapproval\b|\bfile\.picker\b|\boauth\b/i,
      );
    }
  });
});
