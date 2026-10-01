/**
 * The page server: a loopback `node:http` endpoint that hands out the shell's
 * static files and nothing else.
 *
 * It is deliberately separate from the binding. The binding carries protocol
 * frames and knows nothing about pages; this server carries pages and knows
 * nothing about frames. A deployment that already has its own host and binding
 * can be pointed at by the shell without either half having to learn about the
 * other.
 *
 * Two rules keep it small: it only ever reads files under its root — a request
 * that resolves outside is answered as a miss, never as a file — and it only
 * ever answers a loopback peer, because v1 is a local shell and a page server
 * reachable from another machine would be a different security proposition.
 */

import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";

export interface StaticServerOptions {
  /** The directory served at `/`; everything outside it is unreachable. */
  readonly root: string;
  /** The loopback address to listen on. Anything else is refused. */
  readonly address?: string;
  readonly port?: number;
}

export interface StaticServer {
  /** The origin the pages are served from, e.g. `http://127.0.0.1:41800`. */
  readonly origin: string;
  close(): Promise<void>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
});

/** Whether an address is loopback; anything else would be reachable off the machine. */
function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "localhost" || address === "::1";
}

/** Whether a peer address is loopback, in the spellings Node reports. */
function isLoopbackPeer(remote: string | undefined): boolean {
  if (remote === undefined) return false;
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1" ||
    remote.startsWith("127.")
  );
}

/**
 * The path a request target names, or `undefined` when it cannot be parsed.
 *
 * The base is the origin this server answers on with brackets included, so an
 * IPv6 address yields a URL the parser accepts. A target the parser rejects
 * (`http://[`, an unbalanced bracket in an absolute-form request) is answered
 * as a bad request by the caller rather than thrown here: a throw inside a
 * request listener would take the whole page server down with it.
 */
function requestPath(target: string, host: string, port: number): string | undefined {
  try {
    return new URL(target, `http://${host}:${port}`).pathname;
  } catch {
    return undefined;
  }
}

/** Whether one resolved path is the other or lives under it. */
function contains(root: string, candidate: string): boolean {
  if (process.platform === "win32") {
    // Windows paths are case-insensitive, and realpath keeps the on-disk
    // spelling of each component, so both sides are compared case-folded.
    const foldedRoot = root.toLowerCase();
    const folded = candidate.toLowerCase();
    return folded === foldedRoot || folded.startsWith(foldedRoot + sep);
  }
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * The file a request path names, or `undefined` when it names nothing inside
 * the root.
 *
 * The check is on the resolved path, not on the spelling: `..` segments, an
 * encoded slash, a NUL or an absolute path all end up either inside the root
 * or refused — there is no filter that a second decoding step could slip past.
 *
 * The second resolution is the physical one. A path can sit inside the root
 * lexically and still point out of it — a symlink or a Windows junction works
 * exactly that way — so the file that will actually be opened is resolved with
 * `realpath` and checked against the root's real path too. An alias that stays
 * inside the root keeps working; one that leaves is a miss.
 */
function fileFor(realRoot: string, root: string, requestPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;

  const candidate = resolve(join(root, decoded));
  if (!contains(root, candidate)) return undefined;

  try {
    const stats = statSync(candidate);
    const file = stats.isDirectory() ? join(candidate, "index.html") : candidate;
    const real = realpathSync(file);
    if (!contains(realRoot, real)) return undefined;
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

export async function startStaticServer(options: StaticServerOptions): Promise<StaticServer> {
  const root = resolve(options.root);
  // The root's physical location, resolved once: every served file is checked
  // against it, so a link placed inside the root cannot become a way out of it.
  // A root that does not exist keeps its lexical form — every request is a miss
  // either way, and a page server is not the place to diagnose the layout.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  const address = options.address ?? "127.0.0.1";
  if (!isLoopbackAddress(address)) {
    throw new Error("the page server listens on loopback only");
  }

  const server: Server = createServer();
  server.on("request", (request, response) => {
    request.on("error", () => undefined);
    response.on("error", () => undefined);
    handle(request, response);
  });
  server.on("connection", (socket) => {
    socket.on("error", () => undefined);
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  const port = (): number => (server.address() as AddressInfo | null)?.port ?? 0;

  // How a browser spells this address: an IPv6 literal keeps its brackets, and
  // the origin below has to be URL-parseable — an unbracketed `::1` is not.
  const host = address.includes(":") ? `[${address}]` : address;

  function respond(request: IncomingMessage, response: ServerResponse, status: number, body?: string): void {
    const payload = body ?? "";
    response.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end(payload);
  }

  function handle(request: IncomingMessage, response: ServerResponse): void {
    const hostHeader = request.headers.host;
    const mine =
      typeof hostHeader === "string" &&
      (hostHeader === `${host}:${port()}` || hostHeader === `127.0.0.1:${port()}` || hostHeader === `localhost:${port()}`);
    if (!mine) {
      respond(request, response, 421, "unexpected host");
      return;
    }
    if (!isLoopbackPeer(request.socket.remoteAddress)) {
      respond(request, response, 403, "loopback only");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      respond(request, response, 405, "method not allowed");
      return;
    }

    const path = requestPath(request.url ?? "/", host, port());
    if (path === undefined) {
      respond(request, response, 400, "bad request target");
      return;
    }
    const file = fileFor(realRoot, root, path === "/" ? "/index.html" : path);
    if (file === undefined) {
      respond(request, response, 404, "not found");
      return;
    }

    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    response.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on("error", () => {
      response.destroy();
    });
    stream.pipe(response);
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, address, () => {
      resolveListen();
    });
  });

  const boundPort = (server.address() as AddressInfo).port;
  return {
    origin: `http://${host}:${boundPort}`,
    async close(): Promise<void> {
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
        server.closeAllConnections();
      });
    },
  };
}
