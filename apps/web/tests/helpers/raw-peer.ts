/**
 * A raw peer for the binding: `fetch` and text, no client core.
 *
 * These tests are about the transport itself, so the peer speaks to it the way a
 * browser would — one create, one streamed response, one POST per frame — and
 * reads the stream as text, so what is asserted is what is really on the wire.
 */

import type { ProtocolChannel } from "@every-dagent/protocol";

import {
  createSseParser,
  encodeSseComment,
  startHttpBinding,
  unwrapRecord,
  wrapFrame,
  type HttpBinding,
  type HttpBindingOptions,
} from "../../src/index.js";

export interface RawPeer {
  readonly connectionId: string;
  readonly token: string;
  /** Every downstream frame, decoded from its record. */
  readonly frames: readonly string[];
  /** The raw text of the downstream, exactly as it arrived. */
  readonly raw: string;
  /** Sends one frame upstream and resolves with the HTTP status. */
  post(frame: string): Promise<number>;
  /** Sends a body that is not a wrapped frame. */
  postRaw(body: string): Promise<number>;
  /** Resolves once `count` frames have arrived (or rejects after a timeout). */
  waitForFrames(count: number): Promise<void>;
  /** True when the downstream ended. */
  readonly ended: boolean;
  close(): void;
}

export interface RawPeerOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly token?: string;
  readonly connectionId?: string;
  /** Skips the create call and uses the given credentials. */
  readonly reuse?: { readonly connectionId: string; readonly token: string };
}

const TRANSPORT_HEADER = "x-every-dagent-transport";

export async function startBinding(
  options: Omit<HttpBindingOptions, "onConnection"> & {
    readonly onConnection?: (channel: ProtocolChannel) => void;
  } = {},
): Promise<{ readonly binding: HttpBinding; readonly channels: ProtocolChannel[] }> {
  const channels: ProtocolChannel[] = [];
  const binding = await startHttpBinding({
    ...options,
    onConnection: (channel) => {
      channels.push(channel);
      options.onConnection?.(channel);
    },
  });
  return { binding, channels };
}

export async function createCredentials(
  origin: string,
  options: RawPeerOptions = {},
): Promise<{ connectionId: string; token: string }> {
  const response = await fetch(`${origin}/connections`, {
    method: "POST",
    headers: { "content-type": "application/json", [TRANSPORT_HEADER]: "1", ...options.headers },
    body: "{}",
  });
  if (response.status !== 201) throw new Error(`create failed with ${response.status}`);
  const body = (await response.json()) as { connectionId: string; token: string };
  return { connectionId: body.connectionId, token: body.token };
}

export async function openRawPeer(origin: string, options: RawPeerOptions = {}): Promise<RawPeer> {
  const credentials = options.reuse ?? (await createCredentials(origin, options));
  const token = options.token ?? credentials.token;
  const connectionId = options.connectionId ?? credentials.connectionId;

  const abort = new AbortController();
  const frames: string[] = [];
  const parser = createSseParser(8 * 1024 * 1024);
  let raw = "";
  let ended = false;
  const waiters: (() => void)[] = [];

  const response = await fetch(`${origin}/connections/${connectionId}/events`, {
    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", ...options.headers },
    signal: abort.signal,
  });
  if (response.status !== 200 || response.body === null) {
    throw new Error(`the stream failed with ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  void (async (): Promise<void> => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        raw += text;
        for (const record of parser.feed(text)) {
          const frame = unwrapRecord(record);
          if (frame === undefined) continue;
          frames.push(frame);
          for (const waiter of [...waiters]) waiter();
        }
      }
    } catch {
      // The stream ended, however it ended.
    }
    ended = true;
    for (const waiter of [...waiters]) waiter();
  })();

  return {
    connectionId,
    token,
    get frames(): readonly string[] {
      return frames;
    },
    get raw(): string {
      return raw;
    },
    get ended(): boolean {
      return ended;
    },
    async post(frame: string): Promise<number> {
      const answer = await fetch(`${origin}/connections/${connectionId}/frames`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          [TRANSPORT_HEADER]: "1",
          ...options.headers,
        },
        body: wrapFrame(frame),
      });
      return answer.status;
    },
    async postRaw(body: string): Promise<number> {
      const answer = await fetch(`${origin}/connections/${connectionId}/frames`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          [TRANSPORT_HEADER]: "1",
          ...options.headers,
        },
        body,
      });
      return answer.status;
    },
    async waitForFrames(count: number): Promise<void> {
      const deadline = Date.now() + 3000;
      while (frames.length < count) {
        if (ended || Date.now() > deadline) return;
        await new Promise((resolve) => {
          waiters.push(() => {
            resolve(undefined);
          });
          setTimeout(() => {
            resolve(undefined);
          }, 5);
        });
      }
    },
    close(): void {
      abort.abort();
    },
  };
}

/** Waits until a condition holds, polling. */
export async function waitUntil(predicate: () => boolean, what = "the condition"): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
  }
}

export { encodeSseComment };
