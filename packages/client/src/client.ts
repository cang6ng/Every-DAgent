/**
 * The client's public surface: one factory, one interface, and nothing that
 * could reach past it.
 *
 * There is no raw `request(method, ...)`, no exposed channel, no way to open a
 * subscription by hand: those are the invariants this client exists to keep, and
 * a caller that could bypass them could desynchronize the presentation replica
 * it is supposed to be reading. What is public is exactly the twelve frozen
 * operations, the lifecycle, the immutable snapshot, and the reverse seam the
 * host may knock on.
 */

import type { OperationMap, ProtocolChannel } from "@every-dagent/protocol";

import { ClientConnection } from "./connection.js";
import type { ClientOptions } from "./connection.js";
import { createReverseTable } from "./reverse.js";
import type { ReverseHandlerRegistration } from "./reverse.js";
import type { ClientSnapshot } from "./store.js";

export type { ClientOptions } from "./connection.js";

/**
 * Compose-only inputs, and the reason the package index does not export them.
 *
 * The production reverse catalog is empty by design: v1 ships no business
 * method, no approval, no form, no picker. A registration is the only way to
 * make one exist, and only a test composition does that.
 */
export interface ClientInternals {
  readonly reverseHandlers?: readonly ReverseHandlerRegistration[];
}

export interface Client {
  /** Establishes the connection and completes `describe` → `open`. Merges while one is in flight. */
  connect(): Promise<void>;
  /** Ends the current connection, if any, and establishes a fresh one. */
  reconnect(): Promise<void>;
  /** Ends the connection locally. The presentation is kept, and marked stale. */
  disconnect(): void;
  /** Re-opens the subscription on the current connection. */
  resync(): Promise<void>;
  /** Closes the current subscription. The stream is invalidated before the host is told. */
  closeSubscription(): Promise<void>;

  /** The current immutable snapshot; the same object until something actually changes. */
  getSnapshot(): ClientSnapshot;
  /** An alias of `getSnapshot`, with no state of its own. */
  getState(): ClientSnapshot;
  /** Notified once per real state change; the returned function removes the listener. */
  subscribe(listener: () => void): () => void;

  readonly sessions: {
    list(): Promise<OperationMap["sessions.list"]["result"]>;
    create(): Promise<OperationMap["sessions.create"]["result"]>;
    get(params: OperationMap["sessions.get"]["params"]): Promise<OperationMap["sessions.get"]["result"]>;
  };

  readonly runs: {
    start(params: OperationMap["runs.start"]["params"]): Promise<OperationMap["runs.start"]["result"]>;
    get(params: OperationMap["runs.get"]["params"]): Promise<OperationMap["runs.get"]["result"]>;
    cancel(params: OperationMap["runs.cancel"]["params"]): Promise<OperationMap["runs.cancel"]["result"]>;
  };

  readonly plugins: {
    list(): Promise<OperationMap["plugins.list"]["result"]>;
    enable(params: OperationMap["plugins.enable"]["params"]): Promise<OperationMap["plugins.enable"]["result"]>;
    disable(params: OperationMap["plugins.disable"]["params"]): Promise<OperationMap["plugins.disable"]["result"]>;
  };
}

export function createClient(options: ClientOptions): Client {
  return createClientWith(options, {});
}

/** The real composition: `createClient` is this with no internals. */
export function createClientWith(options: ClientOptions, internals: ClientInternals): Client {
  const connection = new ClientConnection(options, createReverseTable(internals.reverseHandlers ?? []));

  return {
    connect: (): Promise<void> => connection.connect(),
    reconnect: (): Promise<void> => connection.reconnect(),
    disconnect: (): void => connection.disconnect(),
    resync: (): Promise<void> => connection.resync(),
    closeSubscription: (): Promise<void> => connection.closeSubscription(),

    getSnapshot: (): ClientSnapshot => connection.getSnapshot(),
    getState: (): ClientSnapshot => connection.getSnapshot(),
    subscribe: (listener: () => void): (() => void) => connection.subscribe(listener),

    sessions: {
      list: (): Promise<OperationMap["sessions.list"]["result"]> =>
        connection.request("sessions.list", {}),
      create: (): Promise<OperationMap["sessions.create"]["result"]> =>
        connection.request("sessions.create", {}),
      get: (params: OperationMap["sessions.get"]["params"]): Promise<OperationMap["sessions.get"]["result"]> =>
        connection.request("sessions.get", params),
    },

    runs: {
      start: (params: OperationMap["runs.start"]["params"]): Promise<OperationMap["runs.start"]["result"]> =>
        connection.request("runs.start", params),
      get: (params: OperationMap["runs.get"]["params"]): Promise<OperationMap["runs.get"]["result"]> =>
        connection.request("runs.get", params),
      cancel: (params: OperationMap["runs.cancel"]["params"]): Promise<OperationMap["runs.cancel"]["result"]> =>
        connection.request("runs.cancel", params),
    },

    plugins: {
      list: (): Promise<OperationMap["plugins.list"]["result"]> =>
        connection.request("plugins.list", {}),
      enable: (params: OperationMap["plugins.enable"]["params"]): Promise<OperationMap["plugins.enable"]["result"]> =>
        connection.request("plugins.enable", params),
      disable: (params: OperationMap["plugins.disable"]["params"]): Promise<OperationMap["plugins.disable"]["result"]> =>
        connection.request("plugins.disable", params),
    },
  };
}

export type { ProtocolChannel };
