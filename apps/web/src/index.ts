/**
 * The public surface of `@every-dagent/web`.
 *
 * Two halves, and nothing that mixes them: the server binding (a `node:http`
 * endpoint a host attaches channels to) and the client channel (a browser-safe
 * `fetch`/SSE connector). The composition — which host, which limits, which
 * origin — belongs to whoever builds the application, not to this package.
 */

export { startHttpBinding } from "./server/http-binding.js";
export type { HttpBinding, HttpBindingOptions } from "./server/http-binding.js";
export { DEFAULT_WEB_LIMITS, FRAME_LIMIT_BYTES, RECORD_LIMIT_BYTES } from "./transport/limits.js";
export type { WebLimits } from "./transport/limits.js";

export { connectHttpChannel } from "./client/http-channel.js";
export type { HttpChannelOptions } from "./client/http-channel.js";

export {
  createSseParser,
  encodeSseComment,
  encodeSseRecord,
  unwrapRecord,
  utf8Length,
  wrapFrame,
} from "./transport/framing.js";
export type { SseParser } from "./transport/framing.js";
export { createFrameQueue } from "./transport/queue.js";
export type { FrameQueue, FrameQueueLimits } from "./transport/queue.js";
