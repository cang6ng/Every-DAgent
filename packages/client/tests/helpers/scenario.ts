/**
 * A client wired to scriptable hosts, with its status history recorded.
 *
 * The connector hands out a fresh fake host per attempt, so a reconnect test is
 * the same shape as a first connection — the client cannot tell the difference,
 * which is exactly the property being tested.
 */

import type { HostSnapshot } from "@every-dagent/protocol";

import type { Client } from "../../src/client.js";
import { createClientWith } from "../../src/client.js";
import type { ClientInternals } from "../../src/client.js";
import type { ClientSnapshot, ConnectionStatus } from "../../src/store.js";

import { createFakeHost, type FakeHost, type FakeHostOptions } from "./fake-host.js";

/** Lets every pending microtask and timer callback of this tick run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export interface StatusChange {
  readonly status: ConnectionStatus;
  readonly presentation: ClientSnapshot["presentation"];
  readonly description: ClientSnapshot["description"];
  readonly stale: boolean;
}

export interface Scenario {
  readonly client: Client;
  /** One entry per connection attempt, in order. */
  readonly hosts: FakeHost[];
  /** The host of the current attempt. */
  readonly host: FakeHost;
  /** Every status the client published, in order. */
  readonly statuses: StatusChange[];
  /** Connects and waits for `ready`. */
  ready(): Promise<void>;
  /** The connection attempts so far. */
  readonly attempts: number;
}

export interface ScenarioOptions {
  readonly host?: FakeHostOptions;
  /** Overrides the per-attempt host factory. */
  readonly makeHost?: (index: number) => FakeHost;
  readonly internals?: ClientInternals;
  readonly client?: { readonly name: string; readonly version: string };
}

export function createScenario(options: ScenarioOptions = {}): Scenario {
  const hosts: FakeHost[] = [];
  let attempts = 0;

  const client = createClientWith(
    {
      connect: (): Promise<FakeHost["channel"]> => {
        attempts += 1;
        const host = options.makeHost?.(attempts - 1) ?? createFakeHost(options.host ?? {});
        hosts.push(host);
        return Promise.resolve(host.channel);
      },
      ...(options.client === undefined ? {} : { client: options.client }),
    },
    options.internals ?? {},
  );

  const statuses: StatusChange[] = [];
  client.subscribe(() => {
    const snapshot = client.getSnapshot();
    statuses.push({
      status: snapshot.status,
      presentation: snapshot.presentation,
      description: snapshot.description,
      stale: snapshot.stale,
    });
  });

  const scenario: Scenario = {
    client,
    hosts,
    get host(): FakeHost {
      const host = hosts[hosts.length - 1];
      if (host === undefined) throw new Error("no host has been connected yet");
      return host;
    },
    statuses,
    get attempts(): number {
      return attempts;
    },
    async ready(): Promise<void> {
      await client.connect();
    },
  };

  return scenario;
}

/** The statuses a scenario went through, in order. */
export function statusHistory(scenario: Scenario): readonly ConnectionStatus[] {
  return scenario.statuses.map((change) => change.status);
}

/** The status *transitions*: consecutive repeats collapsed, since one status can be republished with more detail. */
export function statusTransitions(scenario: Scenario): readonly ConnectionStatus[] {
  const transitions: ConnectionStatus[] = [];
  for (const change of scenario.statuses) {
    if (transitions[transitions.length - 1] !== change.status) transitions.push(change.status);
  }
  return transitions;
}

/**
 * Connects a scenario whose host answers by hand, with a chosen snapshot.
 *
 * Used by the tests that need the initial presentation to hold something: the
 * auto-answering host always opens empty, and a session invented after the fact
 * would be a different test.
 */
export async function openWith(scenario: Scenario, fields: Partial<HostSnapshot> = {}): Promise<void> {
  const connecting = scenario.client.connect();
  await flush();
  scenario.host.serveDescribe();
  await flush();
  scenario.host.serveOpen(fields);
  await connecting;
}
