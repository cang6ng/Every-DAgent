/**
 * The package boundary, from a consumer's point of view.
 *
 * The reverse seam is deliberately internal: a host or client is composed with
 * `createHost` / `createClient`, and the test-only profiles are not something a
 * consumer can reach. This checks that claim the way a consumer would experience
 * it — by package name — rather than by reading the manifest.
 *
 * It is a module, not a test: vitest does not collect it, and the typecheck does,
 * which is exactly the pair of gates the boundary needs.
 */

// The public roots resolve, with the values a consumer expects.
import { createHost } from "@every-dagent/host";
import { createClient, ClientError } from "@every-dagent/client";
import { connectHttpChannel, startHttpBinding } from "@every-dagent/web";

export const publicRoots = { createHost, createClient, ClientError, connectHttpChannel, startHttpBinding };

// The composition seams are not reachable by package path. `@ts-expect-error`
// here is the assertion: if TypeScript ever accepted one of these imports, this
// file would fail to compile.
// @ts-expect-error the client's composition seam is not a package subpath
import { createClientWith } from "@every-dagent/client/src/client.js";
// @ts-expect-error the client's connection internals are not a package subpath
import { ClientConnection } from "@every-dagent/client/src/connection.js";
// @ts-expect-error the client's reverse seam is not a package subpath
import { createReverseTable } from "@every-dagent/client/src/reverse.js";
// @ts-expect-error the host's composition seam is not a package subpath
import { composeHost } from "@every-dagent/host/src/host.js";
// @ts-expect-error the host's reverse mechanism is not a package subpath
import { createReverseTrigger } from "@every-dagent/host/src/reverse.js";
// @ts-expect-error the web binding has no internal entry of its own
import { createFrameQueue } from "@every-dagent/web/src/transport/queue.js";

export const refused = {
  createClientWith,
  ClientConnection,
  createReverseTable,
  composeHost,
  createReverseTrigger,
  createFrameQueue,
};
