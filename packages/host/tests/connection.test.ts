/**
 * Connection ownership: who owns the frame listener, and when it comes off.
 *
 * A connection ends in several ways — the peer closes it, the host detaches it,
 * the host shuts down, or a channel ends inside `listen` itself — and in every
 * one of them the listener this host installed has to be removed exactly once.
 * `closed` says the connection is over; it is not a record of the cleanup.
 */

import { describe, expect, it } from "vitest";

import type { ProtocolChannel, ProtocolChannelListener } from "@every-dagent/protocol";

import { closeConnection, createConnection } from "../src/connection.js";
import type { ConnectionState, HostState } from "../src/state.js";

import { connect, flush, scriptedModel, testHost, textReply } from "./helpers/harness.js";

/** The pieces of host state `closeConnection` actually touches. */
function bareState(): HostState {
  return {
    hostInstanceId: "host-listener",
    name: "test",
    version: "0.1.0",
    connections: new Set<ConnectionState>(),
  } as unknown as HostState;
}

interface TrackedChannel {
  readonly channel: ProtocolChannel;
  readonly disposals: number[];
  readonly listener: { current: ProtocolChannelListener | undefined };
  closeFromRemote(): void;
}

function trackedChannel(): TrackedChannel {
  const disposals: number[] = [];
  const listener: { current: ProtocolChannelListener | undefined } = { current: undefined };
  const channel: ProtocolChannel = {
    send: (): void => undefined,
    listen: (installed: ProtocolChannelListener): (() => void) => {
      listener.current = installed;
      return (): void => {
        disposals.push(1);
        listener.current = undefined;
      };
    },
    close: (): void => undefined,
  };
  return {
    channel,
    disposals,
    listener,
    closeFromRemote: (): void => {
      listener.current?.onClose();
    },
  };
}

function attached(tracked: TrackedChannel): { readonly state: HostState; readonly connection: ConnectionState } {
  const state = bareState();
  const connection = createConnection(tracked.channel, []);
  connection.detachListener = tracked.channel.listen({
    onFrame: (): void => undefined,
    onClose: (): void => {
      closeConnection(state, connection);
    },
  });
  state.connections.add(connection);
  return { state, connection };
}

describe("listener ownership", () => {
  it("disposes exactly once when the peer closes the connection", () => {
    const tracked = trackedChannel();
    const { state, connection } = attached(tracked);

    tracked.closeFromRemote();
    tracked.closeFromRemote();

    expect(connection.closed).toBe(true);
    expect(tracked.disposals).toHaveLength(1);
    void state;
  });

  it("still disposes when the owner detaches after a remote close", () => {
    const tracked = trackedChannel();
    const { state, connection } = attached(tracked);

    tracked.closeFromRemote();
    closeConnection(state, connection);

    expect(tracked.disposals).toHaveLength(1);
  });

  it("disposes when the host shuts a live connection down", () => {
    const tracked = trackedChannel();
    const { state, connection } = attached(tracked);

    closeConnection(state, connection);

    expect(tracked.disposals).toHaveLength(1);
    expect(state.connections.has(connection)).toBe(false);
  });

  it("disposes a listener installed into a channel that closed during listen", async () => {
    const host = await testHost({ modelClient: scriptedModel([textReply("unused")]).client });
    const disposals: number[] = [];
    const listener: { current: ProtocolChannelListener | undefined } = { current: undefined };
    const eager: ProtocolChannel = {
      send: (): void => undefined,
      listen: (installed: ProtocolChannelListener): (() => void) => {
        listener.current = installed;
        // A channel that ends inside the very call that listens to it.
        installed.onClose();
        return (): void => {
          disposals.push(1);
        };
      },
      close: (): void => undefined,
    };

    const detach = host.attach(eager);
    await flush();
    detach();

    expect(disposals).toHaveLength(1);
  });

  it("does not treat a detached connection as a cancelled run", async () => {
    const host = await testHost({ modelClient: scriptedModel([textReply("still here")]).client });
    const client = connect(host);
    await client.describe();
    const session = await client.call("sessions.create", {});
    const started = await client.call("runs.start", {
      sessionId: session.result?.session.sessionId ?? "",
      submissionId: "sub-detach",
      text: "carry on",
    });
    const runId = started.result?.run.runId ?? "";

    client.detach();

    // Another connection asks the host what happened to that run: detaching a
    // reader is not a cancel.
    const observer = connect(host);
    await observer.describe();
    const run = await observer.call("runs.get", { runId });
    expect(run.result?.run.status).toBeDefined();
    expect(run.result?.run.cancelRequested).toBe(false);
    observer.detach();
  });
});
