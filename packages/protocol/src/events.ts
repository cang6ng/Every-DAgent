/**
 * HostEvent v2: the events frozen by SPEC §14.4, and nothing the Core never
 * produced. No message-start/end, no model-step, no tool-argument delta, no
 * artifact, no reasoning, no usage.
 *
 * Scope ids must agree with the payload's own ids; the cross-field checks
 * here run on the pre-strip snapshot, so a mismatched scope can never be
 * laundered into a valid event by field stripping.
 *
 * Two properties are contract, not decoration. A collection revision travelling
 * with an event is the version the event's own change produced, so a client can
 * tell that a page it holds belongs to an older catalogue. And no event carries
 * a whole session's history: `run.ended` announces a terminal run and the new
 * summary, never the turns it settled — those are read through a history page.
 */

import * as v from "valibot";

import type {
  ActiveRunSnapshot,
  CollectionRevisions,
  EventScope,
  Id,
  LiveToolItem,
  PluginSummary,
  SessionSummary,
  TerminalRunSnapshot,
} from "./contracts.js";
import {
  activeRunSchema,
  collectionRevisionsSchema,
  idSchema,
  liveToolItemSchema,
  plainStringSchema,
  pluginSummarySchema,
  sessionSummarySchema,
  terminalRunSchema,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Public event types. Each variant pins the scope kind it may appear with.
// ---------------------------------------------------------------------------

interface HostEventBase {
  readonly kind: "host-event";
  readonly protocolVersion: "2";
  readonly hostInstanceId: Id;
  readonly streamId: Id;
  readonly sequence: number;
}

export type HostEvent =
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "session"; readonly sessionId: Id };
      readonly type: "session.created";
      readonly payload: { readonly session: SessionSummary; readonly collections: CollectionRevisions };
    })
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "session"; readonly sessionId: Id };
      readonly type: "session.updated";
      readonly payload: { readonly session: SessionSummary; readonly collections: CollectionRevisions };
    })
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "session"; readonly sessionId: Id };
      readonly type: "session.deleted";
      readonly payload: {
        readonly sessionId: Id;
        readonly generation: number;
        readonly collections: CollectionRevisions;
      };
    })
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "run"; readonly sessionId: Id; readonly runId: Id };
      readonly type: "run.updated";
      readonly payload: { readonly run: ActiveRunSnapshot };
    })
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "run"; readonly sessionId: Id; readonly runId: Id };
      readonly type: "run.output.delta";
      readonly payload: { readonly itemId: Id; readonly text: string };
    })
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "run"; readonly sessionId: Id; readonly runId: Id };
      readonly type: "run.tool.call";
      readonly payload: { readonly item: LiveToolItem };
    })
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "run"; readonly sessionId: Id; readonly runId: Id };
      readonly type: "run.tool.result";
      readonly payload: { readonly invocationId: Id; readonly ok: boolean; readonly content: string };
    })
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "run"; readonly sessionId: Id; readonly runId: Id };
      readonly type: "run.ended";
      readonly payload: {
        readonly run: TerminalRunSnapshot;
        readonly session: SessionSummary;
        readonly collections: CollectionRevisions;
      };
    })
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "plugin"; readonly pluginId: Id };
      readonly type: "plugin.updated";
      readonly payload: { readonly plugin: PluginSummary };
    })
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "host" };
      readonly type: "collection.invalidated";
      readonly payload: { readonly collections: CollectionRevisions };
    })
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "host" };
      readonly type: "host.request.cancelled";
      readonly payload: { readonly requestId: Id; readonly reason: "cancelled" | "timeout" };
    });

/** The frozen event type literals, derived from the public union. */
export type HostEventType = HostEvent["type"];

// ---------------------------------------------------------------------------
// Runtime schemas (internal), keyed by exactly the event literals.
// ---------------------------------------------------------------------------

/** Events start at sequence 1; zero belongs to snapshot watermarks. */
const eventSequenceSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

const eventBaseEntries = {
  kind: v.literal("host-event"),
  protocolVersion: v.literal("2"),
  hostInstanceId: idSchema,
  streamId: idSchema,
  sequence: eventSequenceSchema,
} as const;

const runScopeSchema = v.object({
  kind: v.literal("run"),
  sessionId: idSchema,
  runId: idSchema,
});

const sessionScopeSchema = v.object({
  kind: v.literal("session"),
  sessionId: idSchema,
});

/** An announcement about a session's summary, checked against the scope that carries it. */
const sessionSummaryEventSchema = (type: "session.created" | "session.updated") =>
  v.pipe(
    v.object({
      ...eventBaseEntries,
      type: v.literal(type),
      scope: sessionScopeSchema,
      payload: v.object({
        session: sessionSummarySchema,
        collections: collectionRevisionsSchema,
      }),
    }),
    v.check((event) => {
      const session = event.payload.session;
      if (event.scope.sessionId !== session.sessionId) return false;
      // A create announces a session that has no history and no run yet. An
      // update announces a change to one that exists; the schema cannot see
      // which came first, so it only pins what "created" claims.
      if (type !== "session.created") return true;
      return (
        session.status === "ready" &&
        session.activeRunId === null &&
        session.committedSeq === 0 &&
        session.historyRevision === 0 &&
        session.generation === 1
      );
    }),
  );

const eventSchemas = {
  "session.created": sessionSummaryEventSchema("session.created"),
  "session.updated": sessionSummaryEventSchema("session.updated"),
  "session.deleted": v.pipe(
    v.object({
      ...eventBaseEntries,
      type: v.literal("session.deleted"),
      scope: sessionScopeSchema,
      payload: v.object({
        sessionId: idSchema,
        generation: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        collections: collectionRevisionsSchema,
      }),
    }),
    // The scope names the session the payload retires, so a client cannot be
    // told about a deletion of something other than what it holds.
    v.check((event) => event.scope.sessionId === event.payload.sessionId),
  ),
  "run.updated": v.pipe(
    v.object({
      ...eventBaseEntries,
      type: v.literal("run.updated"),
      scope: runScopeSchema,
      payload: v.object({ run: activeRunSchema }),
    }),
    v.check(
      (event) =>
        event.scope.runId === event.payload.run.runId &&
        event.scope.sessionId === event.payload.run.sessionId,
    ),
  ),
  "run.output.delta": v.object({
    ...eventBaseEntries,
    type: v.literal("run.output.delta"),
    scope: runScopeSchema,
    payload: v.object({ itemId: idSchema, text: plainStringSchema }),
  }),
  "run.tool.call": v.pipe(
    v.object({
      ...eventBaseEntries,
      type: v.literal("run.tool.call"),
      scope: runScopeSchema,
      payload: v.object({ item: liveToolItemSchema }),
    }),
    // A call event reports a call, never an outcome: the result slot must
    // still be empty, and `run.tool.result` is the only thing that fills it.
    v.check((event) => event.payload.item.result === null),
  ),
  "run.tool.result": v.object({
    ...eventBaseEntries,
    type: v.literal("run.tool.result"),
    scope: runScopeSchema,
    payload: v.object({
      invocationId: idSchema,
      ok: v.boolean(),
      content: plainStringSchema,
    }),
  }),
  "run.ended": v.pipe(
    v.object({
      ...eventBaseEntries,
      type: v.literal("run.ended"),
      scope: runScopeSchema,
      payload: v.object({
        run: terminalRunSchema,
        session: sessionSummarySchema,
        collections: collectionRevisionsSchema,
      }),
    }),
    v.check((event) => {
      const run = event.payload.run;
      const session = event.payload.session;
      return (
        event.scope.runId === run.runId &&
        event.scope.sessionId === run.sessionId &&
        event.scope.sessionId === session.sessionId &&
        // The terminal correction always clears the session's active run and
        // lands exactly at the run's own session boundary.
        session.activeRunId === null
      );
    }),
  ),
  "plugin.updated": v.pipe(
    v.object({
      ...eventBaseEntries,
      type: v.literal("plugin.updated"),
      scope: v.object({ kind: v.literal("plugin"), pluginId: idSchema }),
      payload: v.object({ plugin: pluginSummarySchema }),
    }),
    v.check((event) => event.scope.pluginId === event.payload.plugin.id),
  ),
  // A catalogue's revision moved without a summary to carry. The revisions are
  // the whole message: a client holding an older page learns its page is no
  // longer the current catalogue and re-reads, rather than stitching versions.
  "collection.invalidated": v.object({
    ...eventBaseEntries,
    type: v.literal("collection.invalidated"),
    scope: v.object({ kind: v.literal("host") }),
    payload: v.object({ collections: collectionRevisionsSchema }),
  }),
  "host.request.cancelled": v.object({
    ...eventBaseEntries,
    type: v.literal("host.request.cancelled"),
    scope: v.object({ kind: v.literal("host") }),
    payload: v.object({
      requestId: idSchema,
      reason: v.union([v.literal("cancelled"), v.literal("timeout")]),
    }),
  }),
} as const;

const hostEventSchema = v.variant("type", Object.values(eventSchemas));

type EventSchemas = typeof eventSchemas;
// Compile-time exactness: schema keys and the public union's literals must be
// the same set in both directions.
type _ExactEventKeys<A extends PropertyKey, B extends PropertyKey> =
  [Exclude<A, B>] extends [never] ? ([Exclude<B, A>] extends [never] ? true : never) : never;
const _eventsExact: _ExactEventKeys<keyof EventSchemas, HostEventType> = true;
void _eventsExact;

export { eventSchemas, hostEventSchema };
