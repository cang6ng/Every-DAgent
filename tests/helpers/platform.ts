/**
 * A real host on a real frame boundary.
 *
 * The composition here is the one the platform claims: the host owns sessions,
 * runs, plugins and the registry; a client owns one logical connection and a
 * presentation replica; frames cross as strings through a carrier. The only
 * thing a test chooses is the carrier — so the same assertions run over memory
 * and over the web binding.
 */

import { createHost } from "@every-dagent/host";
import type { Host, HostOptions } from "@every-dagent/host";
import type { ProtocolChannel } from "@every-dagent/protocol";

import { createClient, type Client } from "@every-dagent/client";
// The composition seam for test-only reverse profiles. It is deliberately not
// part of the package's public surface — the production catalog is empty — so
// the tests that need it reach the internal module directly.
import { createClientWith, type ClientInternals } from "@every-dagent/client/src/client.js";

import { createCarrierPair, type CarrierOptions, type CarrierPair } from "./protocol-carrier.js";

/** How a client reaches a host: one logical connection per call. */
export type ChannelSource = () => Promise<ProtocolChannel>;

export interface HostPlatformOptions extends HostOptions {
  readonly carriers?: CarrierOptions;
}

export interface HostPlatform {
  readonly host: Host;
  /** Opens one logical connection to this host, attached and listening. */
  connect(): Promise<ProtocolChannel>;
  /** One carrier per established connection, in order. */
  readonly carriers: CarrierPair[];
  readonly connections: number;
  shutdown(): Promise<void>;
}

/** The host plus a memory-carrier channel source. */
export function createHostPlatform(options: HostPlatformOptions): HostPlatform {
  const host = createHost(options);
  const carriers: CarrierPair[] = [];
  let connections = 0;

  return {
    host,
    async connect(): Promise<ProtocolChannel> {
      connections += 1;
      const pair = createCarrierPair(options.carriers ?? {});
      carriers.push(pair);
      // The host installs its listener before the client may send anything.
      host.attach(pair.hostSide);
      return pair.clientSide;
    },
    carriers,
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

/** Waits until `predicate` holds, polling the client's own snapshot. */
export async function waitFor(
  predicate: () => boolean,
  options: { readonly timeoutMs?: number; readonly what?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 3000);
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.what ?? "the condition"}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}
