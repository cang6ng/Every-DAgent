/**
 * The error a client publishes.
 *
 * An error is state: it is reported in the snapshot, and the very same object
 * is handed to a caller as a promise rejection. A reader may keep it, pass it
 * on and inspect everything under it — but nothing reachable through it may be
 * theirs to rewrite, or the snapshot would be reporting what a caller changed.
 */

import { describe, expect, it } from "vitest";

import type { ProtocolError } from "@every-dagent/protocol";

import { ClientError } from "../src/index.js";

import { createScenario, openWith, type Scenario } from "./helpers/scenario.js";

/** A client whose open is refused by the host, and the error that refusal left behind. */
async function refusedResync(): Promise<{ readonly scenario: Scenario; readonly rejected: ClientError }> {
  const scenario = createScenario({ host: { auto: false } });
  await openWith(scenario);
  const refused = scenario.client.resync();
  scenario.host.respondError(scenario.host.requestIdOf("subscriptions.open", 1) ?? "", "INTERNAL_ERROR");
  const rejected = await refused.then(
    () => {
      throw new Error("the resync was expected to be refused");
    },
    (error: unknown) => error as ClientError,
  );
  return { scenario, rejected };
}

describe("the wire error a client publishes", () => {
  it("cannot be rewritten through the snapshot that reports it", async () => {
    const { scenario, rejected } = await refusedResync();

    const published = scenario.client.getSnapshot();
    const details = rejected.protocolError;
    expect(details).toBeDefined();
    expect(Object.isFrozen(details)).toBe(true);
    expect(() => {
      (details as { code: string }).code = "METHOD_NOT_FOUND";
    }).toThrow(TypeError);

    expect(scenario.client.getSnapshot()).toBe(published);
    expect(scenario.client.getSnapshot().error?.protocolError?.code).toBe("INTERNAL_ERROR");
  });

  it("cannot be rewritten through the rejection that carried it", async () => {
    const { scenario, rejected } = await refusedResync();
    expect(scenario.client.getSnapshot().error).toBe(rejected);

    expect(() => {
      (rejected.protocolError as { code: string }).code = "METHOD_NOT_FOUND";
    }).toThrow(TypeError);

    const published = scenario.client.getSnapshot();
    expect(published.error?.kind).toBe("remote");
    expect(published.error?.code).toBe("INTERNAL_ERROR");
    expect(published.error?.protocolError?.code).toBe("INTERNAL_ERROR");
  });

  it("keeps the source object of a sent error out of the published one", async () => {
    const scenario = createScenario({ host: { auto: false } });
    await openWith(scenario);
    const refused = scenario.client.resync();
    const source: ProtocolError = { code: "INTERNAL_ERROR", message: "the host's own words" };
    scenario.host.sendRaw(
      JSON.stringify({
        kind: "host-response",
        protocolVersion: "1",
        hostInstanceId: scenario.host.hostInstanceId,
        requestId: scenario.host.requestIdOf("subscriptions.open", 1) ?? "",
        error: source,
      }),
    );
    const rejected = (await refused.catch((error: unknown) => error)) as ClientError;

    // Whatever built the frame, it is not what the client published: editing it
    // afterwards changes nothing a reader can see.
    (source as { code: string }).code = "METHOD_NOT_FOUND";
    (source as { message: string }).message = "edited after the fact";

    expect(rejected.protocolError?.code).toBe("INTERNAL_ERROR");
    expect(rejected.protocolError?.message).toBe("the host's own words");
    expect(rejected.protocolError).not.toBe(source);
    expect(scenario.client.getSnapshot().error?.protocolError?.code).toBe("INTERNAL_ERROR");
  });

  it("reports an error without notifying, and without a fresh object per read", async () => {
    const { scenario, rejected } = await refusedResync();
    const published = scenario.client.getSnapshot();

    let notifications = 0;
    scenario.client.subscribe(() => {
      notifications += 1;
    });

    // Reading is not a change, and neither is a caller's failed attempt to edit
    // what it read — so a reader never sees a second object or an extra notice.
    expect(scenario.client.getSnapshot()).toBe(published);
    expect(scenario.client.getSnapshot().error).toBe(rejected);
    expect(() => {
      ((scenario.client.getSnapshot().error as ClientError).protocolError as { code: string }).code =
        "METHOD_NOT_FOUND";
    }).toThrow(TypeError);

    expect(notifications).toBe(0);
    expect(scenario.client.getSnapshot()).toBe(published);
  });

  it("freezes a nested wire-error subtree all the way down", () => {
    // The v1 wire shape is two strings, so no frame can carry a deeper subtree
    // today; the freeze is about whatever a published error holds, and that is
    // pinned here rather than left for a future field to discover.
    const nested = { code: "INTERNAL_ERROR", message: "nested", details: { attempt: { index: 2, names: ["a"] } } };
    const error = new ClientError({
      kind: "remote",
      code: "INTERNAL_ERROR",
      message: "nested",
      protocolError: nested as unknown as ProtocolError,
    });
    const details = (error.protocolError as unknown as { details: { attempt: { index: number; names: string[] } } }).details;

    expect(Object.isFrozen(error.protocolError)).toBe(true);
    expect(Object.isFrozen(details)).toBe(true);
    expect(Object.isFrozen(details.attempt)).toBe(true);
    expect(Object.isFrozen(details.attempt.names)).toBe(true);
    expect(() => {
      details.attempt.names.push("b");
    }).toThrow(TypeError);
    expect(() => {
      details.attempt.index = 3;
    }).toThrow(TypeError);
    expect(details.attempt).toEqual({ index: 2, names: ["a"] });
  });
});
