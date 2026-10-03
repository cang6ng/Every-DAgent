/**
 * The execution profile a composition runs, and where an unsupported one is
 * refused.
 *
 * A host may only execute under a model profile whose output cap the adapter can
 * enforce. That decision belongs at the composition root, in the order every real
 * composition uses: the model client is built first, and the host second. A
 * profile that is known to be unsupported therefore never becomes a
 * `ModelClient` — and with no client there is no host, no session to open and no
 * run that could be admitted before anyone noticed.
 *
 * The failure is a construction failure, not a first-request one: what these
 * tests check is the *absence* of a ready composition, because that is the state
 * this repair exists to make unreachable.
 */

import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { createClient } from "@every-dagent/client";
import { createPiAiModelClient, UnsupportedPiAiProfileError } from "@every-dagent/model-pi-ai";
import type { PiAiStreamSource } from "@every-dagent/model-pi-ai";

import { createHostPlatform, type HostPlatform } from "../helpers/platform.js";

const open: HostPlatform[] = [];

afterEach(async () => {
  for (const platform of open.splice(0)) await platform.shutdown();
});

/** The capability every profile below declares; the metadata is not what is refused. */
const BASE_MODEL = {
  id: "profile-model",
  name: "Profile Model",
  provider: "test",
  baseUrl: "https://provider.test/v1",
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32 * 1024,
  maxTokens: 4096,
};

/**
 * A transport that is never asked for anything.
 *
 * The composition tests never run a turn: the question is whether a composition
 * can be *created* for a profile at all. A source that throws if it is reached
 * makes that explicit.
 */
const unreachable: PiAiStreamSource = {
  stream: () => {
    throw new Error("the transport was asked to stream, which no test here should reach");
  },
};

/**
 * The composition root, in the order a real one is written.
 *
 * The model client is built before the host, so a client that cannot exist stops
 * the composition: `hostBuilt` is the evidence that the host factory was never
 * reached, and therefore that no ready host and no admitted run were possible.
 */
async function composeExecution(
  model: Model<never>,
): Promise<
  | { readonly hostBuilt: false; readonly error: unknown }
  | { readonly hostBuilt: true; readonly platform: HostPlatform }
> {
  let modelClient;
  try {
    modelClient = createPiAiModelClient({ models: unreachable, model, apiKey: "unused" });
  } catch (error) {
    return { hostBuilt: false, error };
  }

  const platform = await createHostPlatform({ modelClient, plugins: [] });
  open.push(platform);
  return { hostBuilt: true, platform };
}

describe("the execution profile a composition runs", () => {
  it("cannot be composed at all when its API has no enforceable output cap", async () => {
    const unsupported: Model<"openai-responses"> = {
      ...(BASE_MODEL as unknown as Model<"openai-responses">),
      api: "openai-responses",
    };

    const refused = await composeExecution(unsupported as unknown as Model<never>);
    expect(refused.hostBuilt).toBe(false);
    if (refused.hostBuilt) throw new Error("unreachable");
    expect(refused.error).toBeInstanceOf(UnsupportedPiAiProfileError);

    // No host was built, so there is no `host.describe` to succeed and no
    // `runs.start` to accept anything: the refusal happened before the part of
    // the composition that a run could have gone through.
  });

  it("cannot be composed for an interface pi-ai does not even claim", async () => {
    const undeclared: Model<"faux"> = {
      ...(BASE_MODEL as unknown as Model<"faux">),
      api: "faux",
    };

    const refused = await composeExecution(undeclared as unknown as Model<never>);
    expect(refused.hostBuilt).toBe(false);
    if (refused.hostBuilt) throw new Error("unreachable");
    expect(String(refused.error)).toContain("not one whose output cap this adapter can enforce");
  });

  it("still composes a ready host for an audited profile", async () => {
    const audited: Model<"openai-completions"> = {
      ...(BASE_MODEL as unknown as Model<"openai-completions">),
      api: "openai-completions",
    };

    const composed = await composeExecution(audited as unknown as Model<never>);

    // The same helper, the same order: with a profile the adapter can enforce,
    // the composition exists and a client can reach it.
    expect(composed.hostBuilt).toBe(true);
    if (!composed.hostBuilt) throw new Error("unreachable");
    const platform = composed.platform;
    const client = createClient({ connect: () => platform.connect() });

    await client.connect();

    expect(client.getSnapshot().status).toBe("ready");
    client.disconnect();
  });
});
