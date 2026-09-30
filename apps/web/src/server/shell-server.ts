/**
 * The shell's own server composition: a page server, a binding, and a host
 * attached to it.
 *
 * This is the one place the application decides how the two servers relate:
 * the pages are served from their own origin and the binding is told to allow
 * exactly that origin, so the browser's own rules — same-origin fetch, the
 * transport header, the exact CORS answer — are what stand between a page and
 * a host. Nothing here about a host is read or decided: it is attached, it
 * speaks the protocol, and it is shut down by whoever composed it.
 *
 * `wrapChannel` exists because how a channel reaches a host is composition,
 * not protocol: an acceptance run drops one response or closes one connection
 * to see what the shell does, and it does that at the same seam a deployment
 * would put a tracing or rate-limiting wrapper. The default is identity.
 */

import type { Host } from "@every-dagent/host";
import type { ProtocolChannel } from "@every-dagent/protocol";

import { startHttpBinding, type HttpBinding } from "./http-binding.js";
import { startStaticServer, type StaticServer } from "./static-server.js";

export interface ShellServerOptions {
  /** The host every page connection is attached to. Its lifetime belongs to the caller. */
  readonly host: Host;
  /** The directory the pages are served from. */
  readonly staticRoot: string;
  /** The loopback address both servers listen on. */
  readonly address?: string;
  /** The page server's port. `0` picks one. */
  readonly port?: number;
  /** The binding's port. `0` picks one. */
  readonly bindingPort?: number;
  /** How a binding channel reaches the host. The default is the channel itself. */
  readonly wrapChannel?: (channel: ProtocolChannel) => ProtocolChannel;
}

export interface ShellServer {
  /** The origin the pages are served from. */
  readonly pageOrigin: string;
  /** The origin the protocol binding listens on. */
  readonly bindingOrigin: string;
  /** The page URL with its binding pre-set, the address a browser should open. */
  readonly pageUrl: string;
  /** Open logical connections to the binding, for acceptance assertions. */
  readonly connections: number;
  /** Ends both servers. The host is not shut down here; it belongs to the caller. */
  close(): Promise<void>;
}

export async function startShellServer(options: ShellServerOptions): Promise<ShellServer> {
  const pages: StaticServer = await startStaticServer({
    root: options.staticRoot,
    ...(options.address === undefined ? {} : { address: options.address }),
    ...(options.port === undefined ? {} : { port: options.port }),
  });

  // The page server answers under two loopback spellings, and a browser treats
  // them as two origins — a person who retypes the printed URL with the other
  // spelling still gets a page from this shell, so the binding must know both.
  const pageOrigins = [pages.origin];
  if (pages.origin.includes("://127.0.0.1:")) {
    pageOrigins.push(pages.origin.replace("://127.0.0.1:", "://localhost:"));
  } else if (pages.origin.includes("://localhost:")) {
    pageOrigins.push(pages.origin.replace("://localhost:", "://127.0.0.1:"));
  }

  let binding: HttpBinding;
  try {
    binding = await startHttpBinding({
      ...(options.address === undefined ? {} : { address: options.address }),
      ...(options.bindingPort === undefined ? {} : { port: options.bindingPort }),
      originAllowlist: pageOrigins,
      onConnection: (channel: ProtocolChannel): void => {
        const wrapped = options.wrapChannel === undefined ? channel : options.wrapChannel(channel);
        options.host.attach(wrapped);
      },
    });
  } catch (error) {
    await pages.close();
    throw error;
  }

  return {
    pageOrigin: pages.origin,
    bindingOrigin: binding.origin,
    pageUrl: `${pages.origin}/?binding=${encodeURIComponent(binding.origin)}`,
    get connections(): number {
      return binding.connections;
    },
    async close(): Promise<void> {
      await binding.close();
      await pages.close();
    },
  };
}
