/**
 * A real host on a real frame boundary.
 *
 * The composition here is the one the platform claims: the host owns sessions,
 * runs, plugins and the registry; a client owns one logical connection and a
 * presentation replica; frames cross as strings through a carrier. The only
 * thing a test chooses is the carrier — so the same assertions run over memory
 * and over the web binding.
 */

import type { Host, HostOptions } from "@every-dagent/host";
// The host's composition seam: the only way to register a test-only reverse
// profile. It is deliberately outside the package's public surface, so this
// reaches the source file directly — a repository-relative path, not a package
// subpath a consumer could use.
import { composeHost, type AttachedConnection } from "../../packages/host/src/host.js";
import type { ReverseProfile } from "../../packages/host/src/reverse.js";
import type { ProtocolChannel } from "@every-dagent/protocol";

import { createClient, type Client } from "@every-dagent/client";
// The composition seam for test-only reverse profiles, reached the same way: a
// source path inside this repository, never a package subpath.
import { createClientWith, type ClientInternals } from "../../packages/client/src/client.js";

import { createCarrierPair, type CarrierOptions, type CarrierPair } from "./protocol-carrier.js";

/** How a client reaches a host: one logical connection per call. */
export type ChannelSource = () => Promise<ProtocolChannel>;

export interface HostPlatformOptions extends HostOptions {
  readonly carriers?: CarrierOptions;
  /** Test-only reverse profiles; the production catalog is empty. */
  readonly reverseProfiles?: readonly ReverseProfile[];
  /** Overrides the carrier entirely, e.g. to bind a real web transport. */
  readonly source?: ChannelSource;
}

export interface HostPlatform {
  readonly host: Host;
  /** Opens one logical connection to this host, attached and listening. */
  connect(): Promise<ProtocolChannel>;
  /** One carrier per established connection, in order (empty for a custom source). */
  readonly carriers: CarrierPair[];
  /** One entry per attached connection, with its reverse trigger. */
  readonly attached: AttachedConnection[];
  readonly connections: number;
  shutdown(): Promise<void>;
}

/** The host plus a memory-carrier channel source. */
export function createHostPlatform(options: HostPlatformOptions): HostPlatform {
  const attached: AttachedConnection[] = [];
  const composed = composeHost(options, {
    ...(options.reverseProfiles === undefined ? {} : { reverseProfiles: options.reverseProfiles }),
    onAttach: (connection) => {
      attached.push(connection);
    },
  });
  const host = composed.host;
  const carriers: CarrierPair[] = [];
  let connections = 0;

  return {
    host,
    async connect(): Promise<ProtocolChannel> {
      connections += 1;
      if (options.source !== undefined) return options.source();
      const pair = createCarrierPair(options.carriers ?? {});
      carriers.push(pair);
      // The host installs its listener before the client may send anything.
      host.attach(pair.hostSide);
      return pair.clientSide;
    },
    carriers,
    attached,
    get connections(): number {
      return connections;
    },
    shutdown: (): Promise<void> => host.shutdown(),
  };
}

export interface ClientOnPlatformOptions {
  readonly client?: { readonly name: string; readonly version: string };
  readonly internals?: ClientInternals;
}

/** A client wired to a platform: the pairing every integration test starts from. */
export function createClientOn(platform: HostPlatform, options: ClientOnPlatformOptions = {}): Client {
  const optionsWithoutInternals = {
    connect: (): Promise<ProtocolChannel> => platform.connect(),
    ...(options.client === undefined ? {} : { client: options.client }),
  };
  return options.internals === undefined
    ? createClient(optionsWithoutInternals)
    : createClientWith(optionsWithoutInternals, options.internals);
}

/**
 * The same wait the CLI fixture uses, from the helper that has no dependencies.
 *
 * Re-exported rather than reimplemented: a second copy would be a second
 * behaviour, and the acceptance fixture must not import this module at all.
 */
export { waitFor } from "./wait-for.js";
