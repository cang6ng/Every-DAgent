/**
 * The shell's runnable entry: serve the page, point it at a host, and stop
 * when told to.
 *
 * There are exactly two ways to run it, and both are honest about who owns the
 * host. `--composition <module>` loads a module the operator wrote, calls its
 * `createShellHost()`, and serves pages plus binding for that host.
 * `--binding <origin>` serves only pages and trusts an existing binding to be
 * there — which is what an operator who already runs their own host wants.
 * There is no third mode: this CLI never picks a model, never reads a
 * credential, and never invents a host, because which model runs an agent is
 * the composition root's decision and not a shell's.
 */

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Host } from "@every-dagent/host";

import { startShellServer, type ShellServer } from "./shell-server.js";
import { startStaticServer, type StaticServer } from "./static-server.js";

export interface CliOptions {
  readonly mode: { readonly kind: "composition"; readonly module: string } | { readonly kind: "binding"; readonly origin: string };
  readonly port: number | undefined;
  readonly address: string | undefined;
  readonly staticRoot: string | undefined;
}

/**
 * What this bundle hands an operator's composition module.
 *
 * A composition module runs under plain node, where the workspace's TypeScript
 * sources are not importable; the one thing it cannot build itself is a host.
 * Re-exporting the host factory here — from the same bundle the operator
 * already runs — is what makes `--composition` usable: the module imports
 * `createHost` from this file and supplies the model client, the plugins and
 * the grants itself.
 */
export { createHost } from "@every-dagent/host";

export interface CliIo {
  out(message: string): void;
  err(message: string): void;
}

const USAGE = `Every-DAgent web shell

Usage:
  node dist/server.mjs --composition <module>   serve pages and a binding for a composed host
  node dist/server.mjs --binding <origin>       serve pages for an existing binding

Options:
  --composition <module>  an ES module (e.g. ./my-host.mjs) that exports
                          createShellHost(): Host | Promise<Host>. The module
                          composes the model client, the plugins and the host;
                          the shell never chooses a model or reads credentials.
  --binding <origin>      the origin of an already running protocol binding,
                          e.g. http://127.0.0.1:41234.
  --port <n>              the page server port (default: pick one).
  --address <host>        the loopback address to listen on (default: 127.0.0.1).
  --static-root <dir>     the directory served as the page (default: ./public
                          next to this server bundle).
  --help                  print this text.

The host keeps sessions and history in memory for this process's lifetime only;
stopping the process discards them.`;

export function parseCliArgs(argv: readonly string[]): CliOptions | { readonly error: string } {
  let composition: string | undefined;
  let binding: string | undefined;
  let port: number | undefined;
  let address: string | undefined;
  let staticRoot: string | undefined;

  const valueOf = (index: number): string | undefined => argv[index + 1];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--composition": {
        const value = valueOf(index);
        if (value === undefined) return { error: "--composition needs a module path" };
        composition = value;
        index += 1;
        break;
      }
      case "--binding": {
        const value = valueOf(index);
        if (value === undefined) return { error: "--binding needs an origin" };
        binding = value;
        index += 1;
        break;
      }
      case "--port": {
        const value = valueOf(index);
        const parsed = value === undefined ? Number.NaN : Number(value);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          return { error: "--port needs an integer between 0 and 65535" };
        }
        port = parsed;
        index += 1;
        break;
      }
      case "--address": {
        const value = valueOf(index);
        if (value === undefined) return { error: "--address needs a loopback address" };
        address = value;
        index += 1;
        break;
      }
      case "--static-root": {
        const value = valueOf(index);
        if (value === undefined) return { error: "--static-root needs a directory" };
        staticRoot = value;
        index += 1;
        break;
      }
      default:
        return { error: `unknown argument: ${arg ?? ""}` };
    }
  }

  if (composition !== undefined && binding !== undefined) {
    return { error: "--composition and --binding are alternatives; pass exactly one" };
  }
  if (composition === undefined && binding === undefined) {
    return { error: "no host configured: pass --composition <module> or --binding <origin>" };
  }

  return {
    mode:
      composition !== undefined
        ? { kind: "composition", module: composition }
        : { kind: "binding", origin: binding ?? "" },
    port,
    address,
    staticRoot,
  };
}

/** The composition module the operator pointed at, loaded and validated. */
async function loadCompositionHost(modulePath: string): Promise<Host> {
  const url = pathToFileURL(resolve(process.cwd(), modulePath)).href;
  const module = (await import(url)) as { readonly createShellHost?: unknown };
  const create = module.createShellHost;
  if (typeof create !== "function") {
    throw new Error(`the composition module must export createShellHost(): ${modulePath}`);
  }
  const host = (await (create as () => Host | Promise<Host>)()) as Host;
  if (host === null || typeof host !== "object" || typeof host.attach !== "function" || typeof host.shutdown !== "function") {
    throw new Error(`createShellHost() did not return a host: ${modulePath}`);
  }
  return host;
}

/** Waits for the first signal to stop, and forces the second. */
function waitForStop(io: CliIo): Promise<number> {
  return new Promise<number>((resolveStop) => {
    let first = true;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (!first) {
        // The second signal is the operator saying "enough": cleanup that has
        // not settled is reported as not settled, not as done.
        io.err("forced exit: shutdown did not settle");
        process.exit(130);
      }
      first = false;
      io.out(`received ${signal}; shutting down`);
      resolveStop(0);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

export async function runShellCli(
  argv: readonly string[],
  io: CliIo,
  stop: (io: CliIo) => Promise<number> = waitForStop,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.out(USAGE);
    return 0;
  }

  const parsed = parseCliArgs(argv);
  if ("error" in parsed) {
    io.err(parsed.error);
    io.err("run with --help for usage");
    return 2;
  }

  const staticRoot = parsed.staticRoot ?? fileURLToPath(new URL("./public/", import.meta.url));

  if (parsed.mode.kind === "binding") {
    let origin: string;
    try {
      origin = new URL(parsed.mode.origin).origin;
    } catch {
      io.err(`--binding is not an origin: ${parsed.mode.origin}`);
      return 2;
    }
    let pages: StaticServer;
    try {
      pages = await startStaticServer({
        root: staticRoot,
        ...(parsed.address === undefined ? {} : { address: parsed.address }),
        ...(parsed.port === undefined ? {} : { port: parsed.port }),
      });
    } catch (error) {
      io.err(error instanceof Error ? error.message : "the page server could not start");
      return 1;
    }
    io.out("Every-DAgent web shell (pages only; the host is the one you configured)");
    io.out(`  page:    ${pages.origin}/?binding=${encodeURIComponent(origin)}`);
    io.out(`  binding: ${origin}`);
    const code = await stop(io);
    await pages.close();
    return code;
  }

  let shell: ShellServer;
  let host: Host;
  try {
    host = await loadCompositionHost(parsed.mode.module);
    shell = await startShellServer({
      host,
      staticRoot,
      ...(parsed.address === undefined ? {} : { address: parsed.address }),
      ...(parsed.port === undefined ? {} : { port: parsed.port }),
    });
  } catch (error) {
    io.err(error instanceof Error ? error.message : "the shell could not start");
    return 1;
  }

  io.out(`Every-DAgent web shell (host composed by ${parsed.mode.module})`);
  io.out(`  page:    ${shell.pageUrl}`);
  io.out(`  binding: ${shell.bindingOrigin}`);
  io.out("  history is kept in this process's memory only; stopping the host discards it.");

  const code = await stop(io);
  await shell.close();
  await host.shutdown();
  return code;
}

const entry = process.argv[1] === undefined ? "" : pathToFileURL(resolve(process.argv[1])).href;
if (import.meta.url === entry) {
  // Not top-level awaited on purpose. A composition module imports this bundle
  // back (it is where `createHost` comes from), and a dynamic import of a
  // module that has not finished evaluating waits for it forever: the entry
  // has to finish evaluating before the composition can be loaded at all.
  void runShellCli(process.argv.slice(2), {
    out: (message: string): void => {
      console.log(message);
    },
    err: (message: string): void => {
      console.error(message);
    },
  }).then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
