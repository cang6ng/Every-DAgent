/**
 * The composition module the command line's `--composition` mode loads.
 *
 * It is the smallest honest example of the contract: the module composes the
 * model client and the plugins, calls the host factory, and hands the host
 * back. Under the test runner it resolves the workspace package; an operator's
 * real module would import `createHost` from the built `server.mjs` beside it,
 * which is the same factory.
 */

import { createHost } from "@every-dagent/host";

export async function createShellHost() {
  // A model that answers nothing: this fixture exists for the composition path,
  // not for running a conversation. Its declared capability is still a real
  // one — a composition that could not say what its model can take is a
  // composition the host will not run.
  const modelClient = {
    limits: {
      contextWindow: 128 * 1024,
      maxOutputTokens: 8 * 1024,
      framing: {
        request: 256,
        system: 64,
        message: 64,
        toolDefinition: 128,
        toolCall: 64,
        toolResult: 64,
      },
    },
    stream: async function* () {
      yield { type: "done" };
    },
  };

  // The trusted composition, in its smallest honest form: the catalogue it
  // vouches for is one offline profile, and composing it is handing back the
  // client above. An operator's real module resolves a credential here.
  const composition = {
    validateModel: (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      value.provider === "offline" &&
      value.model === "offline"
        ? { ok: true }
        : { ok: false, reason: "unknown-provider-model" },
    compose: async () => ({ modelClient }),
  };

  return createHost({
    bootstrap: {
      host: { systemPrompt: "", loop: { maxSteps: 12, maxModelAttempts: 3 } },
      model: { provider: "offline", model: "offline" },
    },
    composition,
    plugins: [],
  });
}
