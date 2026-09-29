/**
 * HostEvent v1: exactly the eight event types frozen by SPEC §9 — and
 * nothing the Core never produced. No message-start/end, no model-step, no
 * tool-argument delta, no artifact, no reasoning, no usage.
 *
 * Scope ids must agree with the payload's own ids; the cross-field checks
 * here run on the pre-strip snapshot, so a mismatched scope can never be
 * laundered into a valid event by field stripping.
 */

import * as v from "valibot";

import type {
  ActiveRunSnapshot,
  EventScope,
  Id,
  LiveToolItem,
  PluginSummary,
  SessionSnapshot,
  TerminalRunSnapshot,
} from "./contracts.js";
import {
  activeRunSchema,
  idSchema,
  liveToolItemSchema,
  plainStringSchema,
  pluginSummarySchema,
  sessionSnapshotSchema,
  terminalRunSchema,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Public event types. Each variant pins the scope kind it may appear with.
// ---------------------------------------------------------------------------

interface HostEventBase {
  readonly kind: "host-event";
  readonly protocolVersion: "1";
  readonly hostInstanceId: Id;
  readonly streamId: Id;
  readonly sequence: number;
}

export type HostEvent =
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "session"; readonly sessionId: Id };
      readonly type: "session.created";
      readonly payload: { readonly session: SessionSnapshot };
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
      readonly payload: { readonly run: TerminalRunSnapshot; readonly session: SessionSnapshot };
    })
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "plugin"; readonly pluginId: Id };
      readonly type: "plugin.updated";
      readonly payload: { readonly plugin: PluginSummary };
    })
  | (HostEventBase & {
      readonly scope: EventScope & { readonly kind: "host" };
      readonly type: "host.request.cancelled";
      readonly payload: { readonly requestId: Id; readonly reason: "cancelled" | "timeout" };
    });

/** The frozen event type literals, derived from the public union. */
export type HostEventType = HostEvent["type"];

// ---------------------------------------------------------------------------
// Runtime schemas (internal), keyed by exactly the eight event literals.
// ---------------------------------------------------------------------------

/** Events start at sequence 1; zero belongs to snapshot watermarks. */
const eventSequenceSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

const eventBaseEntries = {
  kind: v.literal("host-event"),
  protocolVersion: v.literal("1"),
  hostInstanceId: idSchema,
  streamId: idSchema,
  sequence: eventSequenceSchema,
} as const;

const runScopeSchema = v.object({
  kind: v.literal("run"),
  sessionId: idSchema,
  runId: idSchema,
});

const eventSchemas = {
  "session.created": v.pipe(
    v.object({
      ...eventBaseEntries,
      type: v.literal("session.created"),
      scope: v.object({ kind: v.literal("session"), sessionId: idSchema }),
      payload: v.object({ session: sessionSnapshotSchema }),
    }),
    v.check((event) => {
      const session = event.payload.session;
      return (
        event.scope.sessionId === session.sessionId &&
        session.status === "ready" &&
        session.activeRunId === null &&
        session.canonical.length === 0
      );
    }),
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
      payload: v.object({ run: terminalRunSchema, session: sessionSnapshotSchema }),
    }),
    v.check((event) => {
      const run = event.payload.run;
      const session = event.payload.session;
      return (
        event.scope.runId === run.runId &&
        event.scope.sessionId === run.sessionId &&
        event.scope.sessionId === session.sessionId &&
        // The terminal correction always clears the session's active run.
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
