/**
 * The frozen acceptance scenarios, as tracked regression.
 *
 * Four behaviours the platform promises end to end, each run over both carriers
 * — the in-memory pair and the real web binding, with a real host, a real
 * client and real frames. They were written as independent probes first; they
 * live here now so a later change cannot quietly retract them.
 *
 * 1. One client, two hosts: a write that was sent and never answered stays
 *    `unknown`, the presentation is carried as unconfirmed and then as another
 *    host's state, and nothing is replayed into the second host.
 * 2. A live prefix that grew while the client was offline comes back exactly
 *    from the host's snapshot, and the terminal correction clears it.
 * 3. The strict reverse dispatcher: a spoof cannot settle another connection's
 *    request, and only the genuine answer, once, settles its own.
 * 4. A handler that has actually started ends with the scope that ended — and a
 *    late completion travels nowhere.
 */

import type { CanonicalItem, JsonValue, ProtocolChannel } from "@every-dagent/protocol";
import { connectHttpChannel, startHttpBinding, type HttpBinding } from "@every-dagent/web";
import { createClient, type Client } from "@every-dagent/client";
import type { Plugin } from "@every-dagent/plugin-system";
import { afterEach, describe, expect, it } from "vitest";

import type { ReverseHandlerContext, ReverseHandlerOutcome } from "../../packages/client/src/reverse.js";
import { createClientWith } from "../../packages/client/src/client.js";
import type { ReverseProfile } from "../../packages/host/src/reverse.js";

import { createHostPlatform, runSettled, waitFor, type HostPlatform } from "../helpers/platform.js";
import {
  demoPlugin,
  partialThenGatedReply,
  scriptedModel,
  textReply,
  type ModelReply,
} from "../helpers/demo-fixtures.js";

const ECHO = "test.echo";

/** Exactly `{ value: string }` in, `{ echoed: string }` out — the strict test profile. */
const exact = (value: JsonValue, key: string): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  typeof (value as Record<string, JsonValue>)[key] === "string";

const PROFILES: readonly ReverseProfile[] = [
  { method: ECHO, acceptsParams: (value: JsonValue) => exact(value, "value"), acceptsResult: (value: JsonValue) => exact(value, "echoed") },
];

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

/** A host platform on one carrier: memory, or the real web binding. */
async function platformFor(
  carrier: "memory" | "web",
  replies: readonly ModelReply[] = [textReply("unused")],
  plugins: readonly Plugin[] = [],
): Promise<{ readonly platform: HostPlatform; readonly model: ReturnType<typeof scriptedModel> }> {
  const model = scriptedModel(replies);
  let binding: HttpBinding | undefined;
  const platform = await createHostPlatform({
    modelClient: model.client,
    plugins,
    reverseProfiles: PROFILES,
    ...(carrier === "web" ? { source: (): Promise<ProtocolChannel> => connectHttpChannel({ origin: binding?.origin ?? "" }) } : {}),
  });
  if (carrier === "web") {
    binding = await startHttpBinding({ onConnection: (channel) => platform.host.attach(channel) });
    open.push({ close: () => binding?.close() ?? Promise.resolve() });
  }
  open.push({ close: () => platform.shutdown() });
  return { platform, model };
}

/**
 * Everything the client currently shows as a live draft, joined as text.
 *
 * A timeline belongs to the run being executed and lives in the client's live
 * map: this is the client's own view of what it has been shown so far.
 */
function liveText(which: Client): string {
  return Object.values(which.getSnapshot().live)
    .flatMap((run) => run.live)
    .map((item) => (item.kind === "text" ? item.text : ""))
    .join("");
}

/**
 * Walks a session's committed history from its fence back to its start.
 *
 * v2 history is read in bounded pages, so "the whole session" is a traversal
 * and not one array: the walk ends where the page says it does.
 */
async function readCanonical(which: Client, sessionId: string): Promise<readonly CanonicalItem[]> {
  const pages: (readonly CanonicalItem[])[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await which.sessions.history(cursor === undefined ? { sessionId } : { sessionId, cursor });
    pages.unshift(result.page.items);
    const next = result.page.nextCursor;
    if (next === null) break;
    cursor = next;
  }
  return pages.flat();
}

/**
 * A wire that can be told to lose one frame on its way in.
 *
 * What is under test is the client's behaviour when an answer never arrives,
 * which is not something a healthy carrier produces on request.
 */
function tap(
  inner: ProtocolChannel,
  sent: string[],
  received: string[],
  drop: (frame: string) => boolean = () => false,
): ProtocolChannel {
  return {
    send(frame: string): void {
      sent.push(frame);
      inner.send(frame);
    },
    close(): void {
      inner.close();
    },
    listen(listener): () => void {
      return inner.listen({
        onClose: () => {
          listener.onClose();
        },
        onFrame(frame: string): void {
          received.push(frame);
          if (!drop(frame)) listener.onFrame(frame);
        },
      });
    },
  };
}

for (const carrier of ["memory", "web"] as const) {
  describe(`acceptance over ${carrier}`, () => {
    it("carries a write that was never answered into the next host as unknown, and replays nothing", async () => {
      const first = await platformFor(carrier, [textReply("the first host finished")]);
      const second = await platformFor(carrier, [textReply("must not run")]);
      let target = first;
      const sentToFirst: string[] = [];
      const sentToSecond: string[] = [];
      const received: string[] = [];
      let lost = false;

      const client: Client = createClient({
        connect: async (): Promise<ProtocolChannel> => {
          const selected = target;
          return tap(
            await selected.platform.connect(),
            selected === first ? sentToFirst : sentToSecond,
            received,
            (frame) => {
              const decoded = JSON.parse(frame) as { kind?: string; result?: { run?: { submissionId?: string } } };
              if (selected === first && decoded.kind === "host-response" && decoded.result?.run?.submissionId === "pending-move") {
                lost = true;
                return true;
              }
              return false;
            },
          );
        },
      });

      const states: { readonly host: string; readonly stale: boolean; readonly sessions: number }[] = [];
      const unsubscribe = client.subscribe(() => {
        const snapshot = client.getSnapshot();
        states.push({
          host: snapshot.presentationHost,
          stale: snapshot.stale,
          sessions: snapshot.presentation?.sessions.items.length ?? 0,
        });
      });

      try {
        await client.connect();
        const session = (await client.sessions.create()).session;
        const unanswered = client
          .runs.start({ sessionId: session.sessionId, submissionId: "pending-move", text: "once" })
          .catch((error: unknown) => error);
        await waitFor(() => lost && client.getSnapshot().presentation?.runs.items.length === 1);

        target = second;
        await client.reconnect();

        // The write was sent and never answered: the outcome is unknown, and
        // the client says so rather than guessing either way.
        expect(await unanswered).toMatchObject({ code: "CONNECTION_LOST", outcome: "unknown" });

        // The presentation was carried across the move: unconfirmed on the new
        // connection, then another host's state — never relabelled as current.
        expect(states.some((state) => state.host === "unconfirmed" && state.sessions === 1 && state.stale)).toBe(true);
        expect(states.some((state) => state.host === "previous" && state.sessions === 1 && state.stale)).toBe(true);
        expect(client.getSnapshot().presentationHost).toBe("current");
        expect(client.getSnapshot().presentation?.sessions.items).toEqual([]);

        // Nothing was replayed: one start in total, and the second host never
        // saw the submission at all.
        expect(sentToFirst.filter((frame) => (JSON.parse(frame) as { method?: string }).method === "runs.start")).toHaveLength(1);
        expect(
          sentToSecond.filter((frame) => ["runs.start", "sessions.create"].includes((JSON.parse(frame) as { method?: string }).method ?? "")),
        ).toEqual([]);
        expect(second.model.requests).toHaveLength(0);
        // And the identity is not invented on the new host: it never had it.
        await expect(client.runs.get({ submissionId: "pending-move" })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
      } finally {
        unsubscribe();
        client.disconnect();
      }
    });

    it("recovers a start whose answer was lost on the same host, without replaying it", async () => {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const fixture = await platformFor(carrier, [partialThenGatedReply("accepted-prefix", gate, "-finished-offline")]);
      const sent: string[] = [];
      const received: string[] = [];
      let dropped = 0;

      const client = createClient({
        connect: async (): Promise<ProtocolChannel> =>
          tap(await fixture.platform.connect(), sent, received, (frame) => {
            const decoded = JSON.parse(frame) as { kind?: string; result?: { run?: { submissionId?: string } } };
            if (dropped === 0 && decoded.kind === "host-response" && decoded.result?.run?.submissionId === "lost-same") {
              dropped += 1;
              return true;
            }
            return false;
          }),
      });
      const observer = createClient({ connect: (): Promise<ProtocolChannel> => fixture.platform.connect() });

      try {
        await client.connect();
        await observer.connect();
        const session = (await client.sessions.create()).session;
        const params = { sessionId: session.sessionId, submissionId: "lost-same", text: "one run" };
        const unanswered = client.runs.start(params).catch((error: unknown) => error);
        await waitFor(() => dropped === 1 && liveText(client) === "accepted-prefix");

        // The observer saw the run the client could not be told about.
        const original = await observer.runs.get({ submissionId: "lost-same" });
        expect(original.run.status).toBe("running");

        client.disconnect();
        finish();
        await waitFor(() => observer.getSnapshot().presentation?.runs.items[0]?.status === "completed");
        await client.reconnect();

        expect(await unanswered).toMatchObject({ code: "CONNECTION_LOST", outcome: "unknown" });
        // The run is found again by its submission, not started again.
        const recovered = await client.runs.get({ submissionId: "lost-same" });
        expect(recovered.run.runId).toBe(original.run.runId);
        expect(recovered.run.status).toBe("completed");
        expect(sent.filter((frame) => (JSON.parse(frame) as { method?: string }).method === "runs.start")).toHaveLength(1);
        expect(sent.filter((frame) => (JSON.parse(frame) as { method?: string }).method === "runs.cancel")).toEqual([]);
        // Re-submitting the same text is the same run; a different text is a
        // conflict, not a second run.
        expect((await client.runs.start(params)).run.runId).toBe(original.run.runId);
        await expect(client.runs.start({ ...params, text: "conflict" })).rejects.toMatchObject({ code: "SUBMISSION_CONFLICT" });
        expect(fixture.model.requests).toHaveLength(1);
      } finally {
        finish();
        client.disconnect();
        observer.disconnect();
      }
    });

    it("restores a live prefix that grew while offline, then clears it at the terminal correction", async () => {
      let offline!: () => void;
      let finish!: () => void;
      const offlineGate = new Promise<void>((resolve) => {
        offline = resolve;
      });
      const finishGate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const fixture = await platformFor(carrier, [
        async function* () {
          yield { type: "text-delta", text: "before-中" } as const;
          await offlineGate;
          yield { type: "text-delta", text: "-offline-😀" } as const;
          await finishGate;
          yield { type: "text-delta", text: "-end" } as const;
          yield { type: "done" } as const;
        },
      ]);
      const client = createClient({ connect: (): Promise<ProtocolChannel> => fixture.platform.connect() });
      const observer = createClient({ connect: (): Promise<ProtocolChannel> => fixture.platform.connect() });

      try {
        await client.connect();
        await observer.connect();
        const session = (await client.sessions.create()).session;
        const started = await client.runs.start({ sessionId: session.sessionId, submissionId: "prefix", text: "go" });
        await waitFor(() => liveText(client) === "before-中");

        // The client goes away while the run keeps producing: the host's own
        // state grows, and the client's replica cannot.
        client.disconnect();
        offline();
        await waitFor(() => liveText(observer) === "before-中-offline-😀");

        // The snapshot, not a replay of events, is what puts the client back in
        // step — and it carries exactly what the host holds: the cut names the
        // active run, and the client re-reads the timeline of that run.
        await client.reconnect();
        await waitFor(() => liveText(client) === "before-中-offline-😀", { what: "the grown prefix to come back" });
        expect(liveText(client)).toBe("before-中-offline-😀");

        finish();
        await waitFor(() => client.getSnapshot().presentation?.runs.items[0]?.status === "completed");
        // The terminal correction: no live draft beside the committed history.
        expect(client.getSnapshot().live[started.run.runId]).toBeUndefined();
        const committed = await client.sessions.history({ sessionId: session.sessionId });
        expect(JSON.stringify(committed.page.items)).toContain("before-中-offline-😀-end");
        expect(JSON.stringify(client.getSnapshot().history[session.sessionId]?.items)).toContain(
          "before-中-offline-😀-end",
        );
        expect(fixture.model.requests).toHaveLength(1);
      } finally {
        offline();
        finish();
        client.disconnect();
        observer.disconnect();
      }
    });

    it("adopts the canonical state a run reached while the client was offline", async () => {
      const tool = demoPlugin("demo", "demo.tool");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fixture = await platformFor(
        carrier,
        [
          async function* () {
            yield { type: "text-delta", text: "seen-live" } as const;
            await gate;
            yield { type: "tool-call", call: { callId: "call-1", name: "demo.tool", input: { value: 1 } } } as const;
            yield { type: "done" } as const;
          },
          textReply("the answer after the tool"),
          textReply("after the resync"),
        ],
        [tool.plugin],
      );
      const client = createClient({ connect: (): Promise<ProtocolChannel> => fixture.platform.connect() });
      const observer = createClient({ connect: (): Promise<ProtocolChannel> => fixture.platform.connect() });
      const run = (which: Client) => which.getSnapshot().presentation?.runs.items[0];
      const session = (which: Client) => which.getSnapshot().presentation?.sessions.items[0];

      try {
        await client.connect();
        await observer.connect();
        // The tool the run will call: registered on the host, enabled by a client.
        await client.plugins.enable({ pluginId: "demo" });
        const created = (await client.sessions.create()).session;
        const started = await client.runs.start({
          sessionId: created.sessionId,
          submissionId: "offline-terminal",
          text: "go",
        });
        await waitFor(() => liveText(client) === "seen-live");

        // The client goes away with a live prefix on screen. The run then reaches
        // its terminal state — the tool call, its result and the answer — while
        // the client is not there to see any of it.
        const streamBefore = client.getSnapshot().presentation?.watermark.streamId;
        client.disconnect();
        release();
        await waitFor(() => run(observer)?.status === "completed");
        const observerCanonical = await readCanonical(observer, created.sessionId);
        expect(observerCanonical.map((item) => item.kind)).toEqual([
          "user",
          "assistant",
          "tool-call",
          "tool-result",
          "assistant",
        ]);
        expect(tool.executions).toHaveLength(1);
        // None of it reached the client: it is still holding the prefix it had.
        expect(liveText(client)).toBe("seen-live");
        expect(run(client)?.status).toBe("running");

        // The snapshot, not a replay, is what puts it back in step — including
        // the state that only ever existed while it was away.
        await client.reconnect();
        expect(run(client)?.status).toBe("completed");
        // No live draft beside the committed history, and no stale prefix kept.
        expect(client.getSnapshot().live[started.run.runId]).toBeUndefined();
        const clientCanonical = await readCanonical(client, created.sessionId);
        expect(clientCanonical).toEqual(observerCanonical);
        expect(clientCanonical).toContainEqual(
          expect.objectContaining({ kind: "tool-result", name: "demo.tool", content: "tool answered" }),
        );
        // The session is free, and the snapshot named a new stream — from which
        // the events of the next run arrive as they happen.
        expect(session(client)?.activeRunId).toBeNull();
        expect(client.getSnapshot().presentation?.watermark.streamId).not.toBe(streamBefore);
        expect(client.getSnapshot().presentation?.watermark.sequence).toBe(0);
        const again = await client.runs.start({ sessionId: created.sessionId, submissionId: "after", text: "again" });
        await waitFor(() => runSettled(client.getSnapshot(), again.run.runId), { what: "the second run to settle" });
        const afterCanonical = await readCanonical(client, created.sessionId);
        expect(afterCanonical.some((item) => item.kind === "assistant" && item.text === "after the resync")).toBe(
          true,
        );
        // Two runs: the first took two steps (the tool call and the answer that
        // followed it), the second one. Nothing ran twice.
        expect(fixture.model.requests).toHaveLength(3);
      } finally {
        release();
        client.disconnect();
        observer.disconnect();
      }
    });

    it("settles a reverse request only with its own answer, once", async () => {
      const fixture = await platformFor(carrier);
      const pending: { resolve: (outcome: ReverseHandlerOutcome) => void; context: ReverseHandlerContext }[] = [];
      let ownerWire!: ProtocolChannel;
      let otherWire!: ProtocolChannel;
      const sent: string[] = [];
      const received: string[] = [];

      const client = createClientWith(
        {
          connect: async (): Promise<ProtocolChannel> => {
            ownerWire = await fixture.platform.connect();
            return tap(ownerWire, sent, received);
          },
        },
        {
          reverseHandlers: [
            {
              method: ECHO,
              accepts: (params: JsonValue) => exact(params, "value"),
              resultIsValid: (result: JsonValue) => exact(result, "echoed"),
              handle: (_params, context) =>
                new Promise<ReverseHandlerOutcome>((resolve) => {
                  pending.push({ resolve, context });
                }),
            },
          ],
        },
      );
      const other = createClient({
        connect: async (): Promise<ProtocolChannel> => {
          otherWire = await fixture.platform.connect();
          return otherWire;
        },
      });

      try {
        await client.connect();
        await other.connect();
        const hostSide = fixture.platform.attached[0];
        if (hostSide === undefined) throw new Error("the host has no attached connection");

        // A payload the profile refuses never reaches the handler.
        expect(await hostSide.reverse.request(ECHO, { value: 4 }, 2000).outcome).toEqual({ ok: false, reason: "unavailable" });
        expect(pending).toHaveLength(0);

        const answer = hostSide.reverse.request(ECHO, { value: "owner" }, 2000);
        let settled = 0;
        void answer.outcome.then(() => {
          settled += 1;
        });
        await waitFor(() => pending.length === 1);
        const request = JSON.parse(
          received.find((frame) => (JSON.parse(frame) as { kind?: string }).kind === "host-request") ?? "{}",
        ) as { hostInstanceId: string; streamId: string; requestId: string };

        // A frame from another connection, naming this request: it is dropped by
        // the host's own correlation, and the request stays unsettled. The frame
        // is otherwise a well-formed v2 answer — the one thing wrong with it is
        // the connection it arrived on.
        otherWire.send(
          JSON.stringify({
            kind: "client-response",
            protocolVersion: "2",
            hostInstanceId: request.hostInstanceId,
            streamId: request.streamId,
            requestId: request.requestId,
            result: { echoed: "spoof" },
          }),
        );
        await other.sessions.list();
        expect(settled).toBe(0);

        // The genuine answer, on the connection that owns the request.
        pending[0]?.resolve({ result: { echoed: "owner" } });
        expect(await answer.outcome).toEqual({ ok: true, result: { echoed: "owner" } });

        // The same answer again: a duplicate is not a second settlement.
        const response = sent.find((frame) => (JSON.parse(frame) as { kind?: string }).kind === "client-response");
        if (response === undefined) throw new Error("the client sent no response");
        ownerWire.send(response);
        await client.sessions.list();
        expect(settled).toBe(1);

        // A late completion after the request was cancelled travels nowhere.
        const cancelled = hostSide.reverse.request(ECHO, { value: "cancelled" }, 2000);
        await waitFor(() => pending.length === 2);
        cancelled.cancel();
        expect(await cancelled.outcome).toEqual({ ok: false, reason: "cancelled" });
        await waitFor(() => pending[1]?.context.signal.aborted === true);
        const answersBefore = sent.filter((frame) => (JSON.parse(frame) as { kind?: string }).kind === "client-response").length;
        pending[1]?.resolve({ result: { echoed: "late" } });
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        expect(sent.filter((frame) => (JSON.parse(frame) as { kind?: string }).kind === "client-response")).toHaveLength(answersBefore);
        expect(client.getSnapshot().status).toBe("ready");
      } finally {
        client.disconnect();
        other.disconnect();
      }
    });

    it("keeps an old handler's completion away from the request that replaced it", async () => {
      const fixture = await platformFor(carrier);
      const started: { resolve: (outcome: ReverseHandlerOutcome) => void; context: ReverseHandlerContext }[] = [];
      const sent: string[] = [];
      const received: string[] = [];
      let wire: ProtocolChannel | undefined;

      const client = createClientWith(
        {
          connect: async (): Promise<ProtocolChannel> => {
            wire = await fixture.platform.connect();
            return tap(wire, sent, received);
          },
        },
        {
          reverseHandlers: [
            {
              method: ECHO,
              accepts: (params: JsonValue) => exact(params, "value"),
              resultIsValid: (result: JsonValue) => exact(result, "echoed"),
              handle: (_params, context) =>
                new Promise<ReverseHandlerOutcome>((resolve) => {
                  started.push({ resolve, context });
                }),
            },
          ],
        },
      );

      const kindOf = (frame: string): string | undefined => (JSON.parse(frame) as { kind?: string }).kind;
      const answers = (): number => sent.filter((frame) => kindOf(frame) === "client-response").length;
      const requestStreams = (): string[] =>
        received
          .filter((frame) => kindOf(frame) === "host-request")
          .map((frame) => (JSON.parse(frame) as { streamId: string }).streamId);
      const settle = async (): Promise<void> => {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      };

      /**
       * One switch: a request already running, the connection or the stream under
       * it replaced, a new request that is genuinely open on what replaced it,
       * and then the old handler's completion.
       */
      const round = async (switchIt: () => Promise<void>, reason: string, label: string): Promise<void> => {
        const host = fixture.platform.attached.at(-1);
        if (host === undefined) throw new Error("the host has no attached connection");
        const before = started.length;

        const previous = host.reverse.request(ECHO, { value: `${label}-old` }, 5000);
        await waitFor(() => started.length === before + 1);

        // The switch happens while that request is genuinely still open.
        await switchIt();
        expect(await previous.outcome).toEqual({ ok: false, reason });

        // A new request on what is current now, with a handler that really starts.
        const current = fixture.platform.attached.at(-1);
        if (current === undefined) throw new Error("the host has no current connection");
        const next = current.reverse.request(ECHO, { value: `${label}-new` }, 5000);
        let nextSettled = 0;
        void next.outcome.then(() => {
          nextSettled += 1;
        });
        await waitFor(() => started.length === before + 2);
        expect(nextSettled).toBe(0);
        const streams = requestStreams();
        expect(streams.at(-1)).not.toBe(streams.at(-2));
        expect(started[before]?.context.signal.aborted).toBe(true);
        expect(started[before + 1]?.context.signal.aborted).toBe(false);

        // The handler that was already running finishes now. Its request is over,
        // and the one open now is not its to answer.
        const answersBefore = answers();
        started[before]?.resolve({ result: { echoed: `${label}-old` } });
        await settle();
        expect(answers()).toBe(answersBefore);
        expect(nextSettled).toBe(0);
        expect(started[before + 1]?.context.signal.aborted).toBe(false);

        // Only its own completion answers it — once.
        started[before + 1]?.resolve({ result: { echoed: `${label}-new` } });
        expect(await next.outcome).toEqual({ ok: true, result: { echoed: `${label}-new` } });
        await waitFor(() => answers() === answersBefore + 1);
        expect(nextSettled).toBe(1);

        // The same answer again is not a second settlement.
        const response = sent.filter((frame) => kindOf(frame) === "client-response").at(-1);
        if (response === undefined || wire === undefined) throw new Error("the client sent no response");
        wire.send(response);
        await client.sessions.list();
        expect(nextSettled).toBe(1);
        expect(answers()).toBe(answersBefore + 1);
      };

      try {
        await client.connect();
        // The stream under the connection, and then the connection itself.
        await round(async () => {
          await client.resync();
        }, "stream-gone", "stream");
        await round(async () => {
          await client.reconnect();
        }, "closed", "connection");
      } finally {
        client.disconnect();
      }
    });

    for (const action of ["resync", "closeSubscription", "disconnect", "shutdown"] as const) {
      it(`ends a handler that has started when the ${action} ends its scope`, async () => {
        const fixture = await platformFor(carrier);
        let handler: { resolve: (outcome: ReverseHandlerOutcome) => void; context: ReverseHandlerContext } | undefined;
        const sent: string[] = [];
        const received: string[] = [];

        const client = createClientWith(
          {
            connect: async (): Promise<ProtocolChannel> => tap(await fixture.platform.connect(), sent, received),
          },
          {
            reverseHandlers: [
              {
                method: ECHO,
                accepts: (params: JsonValue) => exact(params, "value"),
                resultIsValid: (result: JsonValue) => exact(result, "echoed"),
                handle: (_params, context) =>
                  new Promise<ReverseHandlerOutcome>((resolve) => {
                    handler = { resolve, context };
                  }),
              },
            ],
          },
        );

        try {
          await client.connect();
          const hostSide = fixture.platform.attached[0];
          if (hostSide === undefined) throw new Error("the host has no attached connection");
          const request = hostSide.reverse.request(ECHO, { value: action }, 5000);

          // The handler really has started: the scope ends after it is running,
          // never in a race it might lose by not having begun.
          await waitFor(() => handler !== undefined);
          if (action === "resync") await client.resync();
          if (action === "closeSubscription") await client.closeSubscription();
          if (action === "disconnect") client.disconnect();
          if (action === "shutdown") await fixture.platform.shutdown();

          expect(await request.outcome).toEqual({
            ok: false,
            reason: action === "resync" || action === "closeSubscription" ? "stream-gone" : "closed",
          });
          await waitFor(() => handler?.context.signal.aborted === true);

          // The result that arrives afterwards is not an answer to anything.
          handler?.resolve({ result: { echoed: "late" } });
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
          expect(sent.filter((frame) => (JSON.parse(frame) as { kind?: string }).kind === "client-response")).toEqual([]);
          request.cancel();
        } finally {
          client.disconnect();
        }
      });
    }
  });
}
