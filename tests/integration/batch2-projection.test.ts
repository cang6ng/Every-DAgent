/**
 * Batch 2 — the public-path acceptance matrix, over both carriers.
 *
 * Every behaviour this batch changed is checked here the way a product has to
 * see it: a real host, a real client, real frames, the memory pair and the web
 * binding. The client-level rules are pinned deterministically in the package
 * suites; what lives here is the end-to-end path each of them serves.
 */

import type { CanonicalItem, ProtocolChannel, ProtocolChannelListener } from "@every-dagent/protocol";
import { connectHttpChannel, startHttpBinding, type HttpBinding } from "@every-dagent/web";
import { createClient, type Client } from "@every-dagent/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHostPlatform, createClientOn, runSettled, waitFor, type HostPlatform } from "../helpers/platform.js";
import { createCarrierPair } from "../helpers/protocol-carrier.js";
import {
  demoPlugin,
  gatedReply,
  partialThenGatedReply,
  scriptedModel,
  textReply,
  toolReply,
} from "../helpers/demo-fixtures.js";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

async function platformFor(
  carrier: "memory" | "web",
  replies: Parameters<typeof scriptedModel>[0],
  plugins: readonly ReturnType<typeof demoPlugin>["plugin"][] = [],
): Promise<{ readonly platform: HostPlatform; readonly model: ReturnType<typeof scriptedModel> }> {
  const model = scriptedModel(replies);
  let binding: HttpBinding | undefined;
  const platform = createHostPlatform({
    modelClient: model.client,
    plugins,
    ...(carrier === "web"
      ? { source: (): Promise<ProtocolChannel> => connectHttpChannel({ origin: binding?.origin ?? "" }) }
      : {}),
  });
  if (carrier === "web") {
    binding = await startHttpBinding({ onConnection: (channel) => platform.host.attach(channel) });
    open.push({ close: () => binding?.close() ?? Promise.resolve() });
  }
  open.push({ close: () => platform.shutdown() });
  return { platform, model };
}

function liveText(client: Client): string {
  return Object.values(client.getSnapshot().live)
    .flatMap((run) => run.live)
    .map((item) => (item.kind === "text" ? item.text : ""))
    .join("");
}

async function readCanonical(client: Client, sessionId: string): Promise<readonly CanonicalItem[]> {
  const pages: (readonly CanonicalItem[])[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await client.sessions.history(cursor === undefined ? { sessionId } : { sessionId, cursor });
    pages.unshift(result.page.items);
    const next = result.page.nextCursor;
    if (next === null) break;
    cursor = next;
  }
  return pages.flat();
}

/** Rewrites an opaque history cursor's own JSON, the way a hostile client would. */
function forge(cursor: string, changes: Record<string, number>): string {
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  return Buffer.from(JSON.stringify({ ...decoded, ...changes }), "utf8").toString("base64url");
}

for (const carrier of ["memory", "web"] as const) {
  describe(`batch 2 public paths over ${carrier}`, () => {
    it("R07: a rolled-back clock cannot move a session's updatedAt backwards", async () => {
      const { platform } = await platformFor(carrier, [textReply("unused")]);
      const client = createClientOn(platform);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        await client.connect();
        const session = (await client.sessions.create()).session;
        const created = session.updatedAt;

        clock.mockImplementation(() => now - 5_000);
        const renamed = await client.sessions.rename({
          sessionId: session.sessionId,
          expectedRevision: session.metadataRevision,
          title: "back in time",
        });
        expect(renamed.session.title).toBe("back in time");
        expect(renamed.session.updatedAt).toBeGreaterThanOrEqual(created);
        expect(renamed.session.createdAt).toBeLessThanOrEqual(renamed.session.updatedAt);

        const read = await client.sessions.get({ sessionId: session.sessionId });
        expect(read.session.updatedAt).toBe(renamed.session.updatedAt);
      } finally {
        clock.mockRestore();
        client.disconnect();
      }
    });

    it("R11: refuses a forged cursor and serves a legal one with its derived identity", async () => {
      const { platform } = await platformFor(carrier, [textReply("one"), textReply("two")]);
      const client = createClientOn(platform);
      try {
        await client.connect();
        const session = (await client.sessions.create()).session;
        for (const [index, text] of ["one", "two"].entries()) {
          await client.runs.start({ sessionId: session.sessionId, submissionId: `sub-${index}`, text });
          await waitFor(() => runSettled(client.getSnapshot(), client.getSnapshot().presentation?.runs.items[0]?.runId ?? ""));
        }

        const first = await client.sessions.history({ sessionId: session.sessionId, limit: 1 });
        const cursor = first.page.nextCursor as string;
        expect(cursor).not.toBeNull();
        expect(first.page.historyRevision).toBe(2);
        expect(first.page.fenceSeq).toBe(8);

        await expect(
          client.sessions.history({ sessionId: session.sessionId, limit: 1, cursor: forge(cursor, { historyRevision: 99 }) }),
        ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        await expect(
          client.sessions.history({
            sessionId: session.sessionId,
            limit: 1,
            cursor: forge(cursor, { fenceSeq: 2, historyRevision: 1, beforeSeq: 2 }),
          }),
        ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

        // The legal continuation is still served, and reports what the host
        // derived rather than what the cursor carried.
        const next = await client.sessions.history({ sessionId: session.sessionId, limit: 1, cursor });
        expect(next.page.fenceSeq).toBe(8);
        expect(next.page.historyRevision).toBe(2);
      } finally {
        client.disconnect();
      }
    });

    it("R12: a limit=1 traversal of a real tool turn is legal, and treats fragments as fragments", async () => {
      const tool = demoPlugin("tools", "demo.tool");
      const { platform } = await platformFor(
        carrier,
        [toolReply("c-1", "demo.tool", { n: 1 }), textReply("after the tool")],
        [tool.plugin],
      );
      const client = createClientOn(platform);
      try {
        await client.connect();
        await client.plugins.enable({ pluginId: "tools" });
        const session = (await client.sessions.create()).session;
        await client.runs.start({ sessionId: session.sessionId, submissionId: "sub-1", text: "use the tool" });
        await waitFor(() => runSettled(client.getSnapshot(), client.getSnapshot().presentation?.runs.items[0]?.runId ?? ""));

        const kinds: string[] = [];
        let cursor: string | undefined;
        let fence: number | undefined;
        for (let index = 0; index < 20; index += 1) {
          const page = await client.sessions.history(
            cursor === undefined ? { sessionId: session.sessionId, limit: 1 } : { sessionId: session.sessionId, limit: 1, cursor },
          );
          expect(page.page.items.length).toBeLessThanOrEqual(1);
          fence = fence ?? page.page.fenceSeq;
          expect(page.page.fenceSeq).toBe(fence);
          kinds.push(page.page.items.map((item) => item.kind).join("+") || "turn-boundary");
          if (page.page.nextCursor === null) break;
          cursor = page.page.nextCursor;
        }

        // The occurrence was cut in half at least once, which is the fragment
        // this path exists for; every item arrived exactly once, in order.
        expect(kinds).toContain("tool-call");
        expect(kinds).toContain("tool-result");
        const canonical = await readCanonical(client, session.sessionId);
        expect(canonical.map((item) => item.kind)).toEqual(["user", "assistant", "tool-call", "tool-result", "assistant"]);
        expect(new Set(canonical.map((item) => item.id)).size).toBe(canonical.length);
      } finally {
        client.disconnect();
      }
    });

    it("R19: a reconnect during a streaming run keeps the connection and converges the draft", async () => {
      let afterReconnect!: () => void;
      let finish!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        afterReconnect = resolve;
      });
      const secondGate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const { platform } = await platformFor(carrier, [
        async function* () {
          yield { type: "text-delta" as const, text: "before" };
          await firstGate;
          yield { type: "text-delta" as const, text: "-after" };
          await secondGate;
          yield { type: "done" as const };
        },
      ]);
      const client = createClientOn(platform);
      try {
        await client.connect();
        const session = (await client.sessions.create()).session;
        const started = await client.runs.start({ sessionId: session.sessionId, submissionId: "sub-1", text: "go" });
        await waitFor(() => liveText(client) === "before");

        // Away and back while the run is still executing: the cut names the
        // active run, and the client's own re-read places its timeline.
        client.disconnect();
        await client.reconnect();
        await waitFor(() => liveText(client) === "before", { what: "the cut to place the run again" });
        expect(client.getSnapshot().status).toBe("ready");

        // Content follows the placement, and the run still settles normally.
        afterReconnect();
        await waitFor(() => liveText(client) === "before-after");
        finish();
        await waitFor(() => runSettled(client.getSnapshot(), started.run.runId));
        expect(client.getSnapshot().status).toBe("ready");
        expect(liveText(client)).toBe("");
        expect(await readCanonical(client, session.sessionId)).not.toHaveLength(0);
      } finally {
        afterReconnect();
        finish();
        client.disconnect();
      }
    });

    if (carrier === "memory") {
      it("R19: a publication that raced the cut is dropped, repaired, and not fatal", async () => {
        let release!: () => void;
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const finishGate = new Promise<void>((resolve) => {
          finish = resolve;
        });

        // The memory carrier is the one that can hold a single frame: the cut's
        // own timeline read is delayed until after the run's next chunk.
        let releaseHeld: (() => void) | undefined;
        const delivered: string[] = [];
        const source = (): Promise<ProtocolChannel> =>
          Promise.resolve(
            ((): ProtocolChannel => {
              const pair = createCarrierPair();
              platform.host.attach(pair.hostSide);
              const runsGetIds = new Set<string>();
              let listener: ProtocolChannelListener | undefined;
              let holding = true;
              let held: string | undefined;
              return {
                send(frame: string): void {
                  const decoded = JSON.parse(frame) as { readonly method?: string; readonly requestId?: string };
                  if (decoded.method === "runs.get" && typeof decoded.requestId === "string") {
                    runsGetIds.add(decoded.requestId);
                  }
                  pair.clientSide.send(frame);
                },
                close(): void {
                  pair.clientSide.close();
                },
                listen(installed: ProtocolChannelListener): () => void {
                  listener = installed;
                  return pair.clientSide.listen({
                    onClose: () => {
                      installed.onClose();
                    },
                    onFrame(frame: string): void {
                      delivered.push(frame);
                      const decoded = JSON.parse(frame) as { readonly kind?: string; readonly requestId?: string };
                      if (
                        holding &&
                        decoded.kind === "host-response" &&
                        typeof decoded.requestId === "string" &&
                        runsGetIds.has(decoded.requestId)
                      ) {
                        held = frame;
                        holding = false;
                        releaseHeld = (): void => {
                          const pending = held;
                          held = undefined;
                          if (pending !== undefined) listener?.onFrame(pending);
                        };
                        return;
                      }
                      installed.onFrame(frame);
                    },
                  });
                },
              };
            })(),
          );

        const model = scriptedModel([
          async function* () {
            yield { type: "text-delta" as const, text: "first" };
            await gate;
            yield { type: "text-delta" as const, text: "-second" };
            await finishGate;
            yield { type: "done" as const };
          },
        ]);
        const platform = createHostPlatform({ modelClient: model.client, plugins: [], source });
        open.push({ close: () => platform.shutdown() });
        const client = createClientOn(platform);
        try {
          await client.connect();
          const session = (await client.sessions.create()).session;
          const started = await client.runs.start({ sessionId: session.sessionId, submissionId: "sub-1", text: "go" });
          await waitFor(() => liveText(client) === "first");
          const runId = started.run.runId;

          // Away and back: the cut is taken while the run is executing, and its
          // placement read is held.
          client.disconnect();
          await client.reconnect();
          await waitFor(() => releaseHeld !== undefined, { what: "the held placement read" });
          expect(client.getSnapshot().live[runId]).toBeUndefined();

          // The next chunk is published — the tap watched it cross — and it
          // cannot be put anywhere: it is dropped rather than applied or
          // faulted, and the connection is untouched.
          release();
          await waitFor(() => delivered.some((frame) => frame.includes('"run.output.delta"')), {
            what: "the racing chunk to cross the wire",
          });
          expect(liveText(client)).toBe("");
          expect(client.getSnapshot().status).toBe("ready");

          // The held read lands with what the host held before the chunk, and
          // the re-read queued behind it carries the chunk: the draft converges
          // on the host's own state.
          releaseHeld?.();
          await waitFor(() => liveText(client) === "first-second", { what: "the draft to converge" });
          expect(client.getSnapshot().status).toBe("ready");
          finish();
          await waitFor(() => runSettled(client.getSnapshot(), runId));
          expect(liveText(client)).toBe("");
        } finally {
          release();
          finish();
          client.disconnect();
        }
      });
    }

    it("R20: a rename reaches the renaming replica and a fresh client alike", async () => {
      const { platform } = await platformFor(carrier, [textReply("unused")]);
      const client = createClientOn(platform);
      const reader = createClientOn(platform);
      try {
        await client.connect();
        const session = (await client.sessions.create()).session;
        await waitFor(() =>
          client.getSnapshot().presentation?.sessions.items.some((item) => item.sessionId === session.sessionId) === true,
        );

        const renamed = await client.sessions.rename({
          sessionId: session.sessionId,
          expectedRevision: session.metadataRevision,
          title: "renamed",
        });
        await waitFor(() =>
          client.getSnapshot().presentation?.sessions.items.find((item) => item.sessionId === session.sessionId)?.title ===
          "renamed",
        );

        const held = client.getSnapshot().presentation?.sessions.items.find((item) => item.sessionId === session.sessionId);
        expect(held?.metadataRevision).toBe(renamed.session.metadataRevision);

        await reader.connect();
        const fresh = await reader.sessions.get({ sessionId: session.sessionId });
        expect(fresh.session.title).toBe("renamed");
        expect(fresh.session.metadataRevision).toBe(renamed.session.metadataRevision);
      } finally {
        client.disconnect();
        reader.disconnect();
      }
    });

    it("R26: a failed run is listable and readable, and the two agree", async () => {
      const model = scriptedModel([
        async function* () {
          throw new Error("the provider died");
        },
      ]);
      let binding: HttpBinding | undefined;
      const platform = createHostPlatform({
        modelClient: model.client,
        plugins: [],
        ...(carrier === "web"
          ? { source: (): Promise<ProtocolChannel> => connectHttpChannel({ origin: binding?.origin ?? "" }) }
          : {}),
      });
      if (carrier === "web") {
        binding = await startHttpBinding({ onConnection: (channel) => platform.host.attach(channel) });
        open.push({ close: () => binding?.close() ?? Promise.resolve() });
      }
      open.push({ close: () => platform.shutdown() });
      const client = createClientOn(platform);
      try {
        await client.connect();
        const session = (await client.sessions.create()).session;
        const started = await client.runs.start({ sessionId: session.sessionId, submissionId: "sub-1", text: "go" });
        await waitFor(() => runSettled(client.getSnapshot(), started.run.runId));

        const fetched = await client.runs.get({ runId: started.run.runId });
        expect(fetched.run.status).toBe("failed");
        expect(fetched.run.endReason).toBe("error");
        expect(fetched.run.error).not.toBeNull();

        const listed = await client.runs.list({ sessionId: session.sessionId });
        const entry = listed.runs.items.find((run) => run.runId === started.run.runId);
        expect(entry?.status).toBe("failed");
        expect(entry?.endReason).toBe("error");
        expect(entry?.error).not.toBeNull();
      } finally {
        client.disconnect();
      }
    });

    it("R27: an active run keeps its session in the cut, however old that session is", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { platform } = await platformFor(carrier, [gatedReply(gate, textReply("done"))]);
      const client = createClientOn(platform);
      try {
        await client.connect();
        const sessions = [];
        for (let index = 0; index < 21; index += 1) sessions.push((await client.sessions.create()).session);
        const active = sessions[0]!;
        const started = await client.runs.start({ sessionId: active.sessionId, submissionId: "sub-1", text: "go" });
        await waitFor(() =>
          client.getSnapshot().presentation?.sessions.items.some((item) => item.activeRunId === started.run.runId) === true,
        );

        // Twenty newer directory writes push the running session out of the
        // newest-page window: the run stays active, so the session must too.
        for (let index = 1; index < 21; index += 1) {
          const session = sessions[index]!;
          await client.sessions.rename({
            sessionId: session.sessionId,
            expectedRevision: session.metadataRevision,
            title: `renamed-${index}`,
          });
        }

        const reader = createClientOn(platform);
        try {
          await reader.connect();
          const snapshot = reader.getSnapshot().presentation;
          const activeSession = snapshot?.sessions.items.find((item) => item.sessionId === active.sessionId);
          expect(activeSession).toBeDefined();
          expect(activeSession?.activeRunId).toBe(started.run.runId);
          const run = snapshot?.runs.items.find((item) => item.runId === started.run.runId);
          expect(run?.status === "accepted" || run?.status === "running").toBe(true);
          expect(run?.sessionId).toBe(active.sessionId);
        } finally {
          reader.disconnect();
        }
      } finally {
        release();
        client.disconnect();
      }
    });
  });
}
