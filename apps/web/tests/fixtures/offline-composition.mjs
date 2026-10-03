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

export function createShellHost() {
  return createHost({
    // A model that answers nothing: this fixture exists for the composition
    // path, not for running a conversation. Its declared capability is still a
    // real one — a composition that could not say what its model can take is a
    // composition the host will not run.
    modelClient: {
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
    },
    plugins: [],
  });
}
