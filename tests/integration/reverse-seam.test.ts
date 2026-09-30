/**
 * Acceptance K: the reverse seam, over both carriers.
 *
 * A real host sends the request, a real client dispatcher answers it, and the
 * only business method in play is a strict test profile that exists nowhere
 * else. The host's catalog and the client's registrations are deliberately
 * different: a method the host can send and the client does not know is exactly
 * how METHOD_NOT_FOUND travels a real wire.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { JsonValue } from "@every-dagent/protocol";
import { connectHttpChannel, startHttpBinding, type HttpBinding } from "@every-dagent/web";
import type { ReverseProfile, ReverseRequestHandle } from "@every-dagent/host/src/reverse.js";
import type { ReverseHandlerContext, ReverseHandlerOutcome, ReverseHandlerRegistration } from "@every-dagent/client";

import { createClientOn, createHostPlatform, waitFor } from "../helpers/platform.js";
import { scriptedModel, textReply } from "../helpers/demo-fixtures.js";

const ECHO = "test.echo";
const UNHANDLED = "test.unhandled";

/** A strict field read: JSON object, own field, exact type. */
function fieldOf(value: JsonValue, key: string): JsonValue | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields: Record<string, JsonValue> = {};
  for (const [name, field] of Object.entries(value)) fields[name] = field;
  return Array.isArray(value) ? undefined : fields[key];
}

/** The host side: it may send `test.echo` (loosely) and `test.unhandled`; it validates results strictly. */
function hostProfiles(): readonly ReverseProfile[] {
  return [
    { method: ECHO, acceptsParams: (): boolean => true, acceptsResult: (result) => typeof fieldOf(result, "echoed") === "string" },
    { method: UNHANDLED, acceptsParams: (): boolean => true, acceptsResult: (): boolean => true },
  ];
}

/** The client side: a strict echo handler, and nothing for `test.unhandled`. */
function clientHandlers(observed: { readonly aborted: number[]; readonly started: number[] }): readonly ReverseHandlerRegistration[] {
  return [
    {
      method: ECHO,
      accepts: (params: JsonValue): boolean => typeof fieldOf(params, "value") === "string",
      resultIsValid: (result: JsonValue): boolean => typeof fieldOf(result, "echoed") === "string",
      handle: (params: JsonValue, context: ReverseHandlerContext): ReverseHandlerOutcome | Promise<ReverseHandlerOutcome> => {
        observed.started.push(1);
        const value = fieldOf(params, "value");
        if (value === "slow") {
          return new Promise<ReverseHandlerOutcome>((resolve) => {
            context.signal.addEventListener("abort", () => {
              observed.aborted.push(1);
              resolve({ result: { echoed: "too late" } });
            });
          });
        }
        return { result: { echoed: typeof value === "string" ? value : "" } };
      },
    },
  ];
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

interface Seam {
  readonly request: (method: string, params: JsonValue, timeoutMs: number) => ReverseRequestHandle;
  readonly aborted: number[];
  readonly started: number[];
}

/** One real host and one real client, connected over the carrier under test. */
async function seam(carrier: "memory" | "web"): Promise<{
  readonly platform: ReturnType<typeof createHostPlatform>;
  readonly client: ReturnType<typeof createClientOn>;
  readonly binding: HttpBinding | undefined;
  readonly seam: Seam;
}> {
  const model = scriptedModel([textReply("unused")]);
  const aborted: number[] = [];
  const started: number[] = [];

  let binding: HttpBinding | undefined;
  if (carrier === "web") {
    const platformSetup = createHostPlatform({
      modelClient: model.client,
      plugins: [],
      reverseProfiles: hostProfiles(),
      source: async () => {
        if (binding === undefined) throw new Error("the binding is not up yet");
        return connectHttpChannel({ origin: binding.origin });
      },
    });
    binding = await startHttpBinding({ onConnection: (channel) => platformSetup.host.attach(channel) });
    open.push(binding);

    const client = createClientOn(platformSetup, {
      internals: { reverseHandlers: clientHandlers({ aborted, started }) },
    });
    await client.connect();
    const attached = platformSetup.attached[0];
    if (attached === undefined) throw new Error("no connection was attached");
    return {
      platform: platformSetup,
      client,
      binding,
      seam: {
        request: (method, params, timeoutMs) => attached.reverse.request(method, params, timeoutMs),
        aborted,
        started,
      },
    };
  }

  const platformSetup = createHostPlatform({
    modelClient: model.client,
    plugins: [],
    reverseProfiles: hostProfiles(),
  });
  const client = createClientOn(platformSetup, {
    internals: { reverseHandlers: clientHandlers({ aborted, started }) },
  });
  await client.connect();
  const attached = platformSetup.attached[0];
  if (attached === undefined) throw new Error("no connection was attached");
  return {
    platform: platformSetup,
    client,
    binding: undefined,
    seam: {
      request: (method, params, timeoutMs) => attached.reverse.request(method, params, timeoutMs),
      aborted,
      started,
    },
  };
}

for (const carrier of ["memory", "web"] as const) {
  describe(`the reverse seam over ${carrier}`, () => {
    it("carries an answer from the client's handler back to the host", async () => {
      const { platform, seam: pending } = await seam(carrier);

      const outcome = await pending.request(ECHO, { value: "hello" }, 2000).outcome;

      expect(outcome).toEqual({ ok: true, result: { echoed: "hello" } });
      await platform.shutdown();
    });

    it("refuses a method the client does not implement", async () => {
      const { platform, seam: pending } = await seam(carrier);

      const outcome = await pending.request(UNHANDLED, { anything: true }, 2000).outcome;

      expect(outcome).toMatchObject({ ok: false, error: { code: "METHOD_NOT_FOUND" } });
      await platform.shutdown();
    });

    it("refuses params that do not satisfy the client's profile", async () => {
      const { platform, seam: pending } = await seam(carrier);

      const outcome = await pending.request(ECHO, { value: 42 }, 2000).outcome;

      expect(outcome).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      await platform.shutdown();
    });

    it("times out and aborts the handler, and the late answer travels nowhere", async () => {
      const { platform, client, seam: pending } = await seam(carrier);

      const outcome = await pending.request(ECHO, { value: "slow" }, 40).outcome;

      expect(outcome).toEqual({ ok: false, reason: "timeout" });
      await waitFor(() => pending.aborted.length === 1, { what: "the handler to be aborted" });
      // The handler resolved after the timeout; nothing was sent for it.
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(client.getSnapshot().status).toBe("ready");
      await platform.shutdown();
    });

    it("ends the wait when the stream it lived on is replaced", async () => {
      const { platform, client, seam: pending } = await seam(carrier);

      const handle = pending.request(ECHO, { value: "slow" }, 5000);
      // The handler must really be running before the stream is replaced,
      // or this would test a request that never arrived.
      await waitFor(() => pending.started.length === 1, { what: "the handler to start" });
      await client.resync();

      expect(await handle.outcome).toEqual({ ok: false, reason: "stream-gone" });
      await waitFor(() => pending.aborted.length === 1, { what: "the handler to be aborted" });
      expect(client.getSnapshot().status).toBe("ready");
      await platform.shutdown();
    });

    it("ends the wait when the client goes away", async () => {
      const { platform, client, seam: pending } = await seam(carrier);

      const handle = pending.request(ECHO, { value: "slow" }, 5000);
      client.disconnect();

      expect(await handle.outcome).toEqual({ ok: false, reason: "closed" });
      await platform.shutdown();
    });

    it("ends the wait when the host shuts down", async () => {
      const { platform, seam: pending } = await seam(carrier);

      const handle = pending.request(ECHO, { value: "slow" }, 5000);
      const shutdown = platform.shutdown();

      expect(await handle.outcome).toEqual({ ok: false, reason: "closed" });
      await expect(shutdown).resolves.toBeUndefined();
    });
  });
}

describe("the seam's own boundary", () => {
  it("ships no business method: the production catalog is empty", async () => {
    const model = scriptedModel([textReply("unused")]);
    const platform = createHostPlatform({ modelClient: model.client, plugins: [] });
    const client = createClientOn(platform);
    await client.connect();

    const attachable = platform.attached[0];
    expect(attachable).toBeDefined();

    // Without a profile on the host side, the mechanism has nothing to send:
    // `test.echo` is not a method this platform ships.
    const refused = await attachable?.reverse.request(ECHO, { value: "hello" }, 1000).outcome;
    expect(refused).toEqual({ ok: false, reason: "unavailable" });

    await platform.shutdown();
  });
});
