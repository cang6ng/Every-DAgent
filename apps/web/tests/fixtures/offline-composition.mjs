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
    // path, not for running a conversation.
    modelClient: {
      stream: async function* () {
        yield { type: "done" };
      },
    },
    plugins: [],
  });
}
