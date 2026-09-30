/**
 * The browser entry, consumed the way a page would.
 *
 * This file is not a page and not a test: it is the proof that the published
 * browser subpath is enough to build a web client — no server module, no Node
 * builtin, no host — and the DOM-only typecheck compiles it as one.
 */

import { connectHttpChannel } from "@every-dagent/web/client";
import { createSseParser, unwrapRecord, utf8Length, wrapFrame } from "@every-dagent/web/client";

export const browserEntry = {
  connectHttpChannel,
  createSseParser,
  unwrapRecord,
  utf8Length,
  wrapFrame,
};
