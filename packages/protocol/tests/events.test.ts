import { describe, expect, it } from "vitest";

import { validateMessage, type HostEvent } from "@every-dagent/protocol";

import {
  hostEvent,
  liveToolItem,
  pluginSummary,
  collectionRevisions,
  sessionSummary,
  terminalRun,
  activeRun,
} from "./helpers/fixtures.js";

const EVENT_TYPES = [
  "session.created",
  "session.updated",
  "session.deleted",
  "run.updated",
  "run.output.delta",
  "run.tool.call",
  "run.tool.result",
  "run.ended",
  "plugin.updated",
  "collection.invalidated",
  "host.request.cancelled",
] as const;

type EventType = (typeof EVENT_TYPES)[number];

const RUN_SCOPE = { kind: "run", sessionId: "s-1", runId: "r-1" };
const SESSION_SCOPE = { kind: "session", sessionId: "s-1" };

function validEvent(type: EventType, sequence = 1): Record<string, unknown> {
  switch (type) {
    case "session.created":
      return hostEvent(
        type,
        SESSION_SCOPE,
        { session: sessionSummary(), collections: collectionRevisions() },
        sequence,
      );
    case "session.updated":
      return hostEvent(
        type,
        SESSION_SCOPE,
        { session: sessionSummary(), collections: collectionRevisions() },
        sequence,
      );
    case "session.deleted":
      return hostEvent(
        type,
        SESSION_SCOPE,
        { sessionId: "s-1", generation: 1, collections: collectionRevisions() },
        sequence,
      );
    case "run.updated":
      return hostEvent(type, RUN_SCOPE, { run: activeRun("running") }, sequence);
    case "run.output.delta":
      return hostEvent(type, RUN_SCOPE, { itemId: "live-1", text: "chunk" }, sequence);
    case "run.tool.call":
      return hostEvent(type, RUN_SCOPE, { item: liveToolItem() }, sequence);
    case "run.tool.result":
      return hostEvent(type, RUN_SCOPE, { invocationId: "inv-1", ok: true, content: "42" }, sequence);
    case "run.ended":
      return hostEvent(
        type,
        RUN_SCOPE,
        { run: terminalRun("completed"), session: sessionSummary(), collections: collectionRevisions() },
        sequence,
      );
    case "plugin.updated":
      return hostEvent(type, { kind: "plugin", pluginId: "calculator" }, { plugin: pluginSummary("enabled") }, sequence);
    case "collection.invalidated":
      return hostEvent(type, { kind: "host" }, { collections: collectionRevisions() }, sequence);
    case "host.request.cancelled":
      return hostEvent(type, { kind: "host" }, { requestId: "h-1", reason: "timeout" }, sequence);
  }
}

describe("host events", () => {
  it.each(EVENT_TYPES)("validates a well-formed %s event", (type) => {
    const result = validateMessage({ kind: "host-event" }, validEvent(type));
    expect(result.success).toBe(true);
  });

  it("rejects sequence 0 on real events (zero belongs to snapshot watermarks)", () => {
    const result = validateMessage({ kind: "host-event" }, validEvent("run.output.delta", 0));
    expect(result).toMatchObject({ success: false });
  });

  it("rejects non-integer and negative sequences", () => {
    for (const sequence of [1.5, -2, Number.MAX_SAFE_INTEGER + 1]) {
      const result = validateMessage({ kind: "host-event" }, validEvent("run.output.delta", sequence));
      expect(result).toMatchObject({ success: false });
    }
  });

  it("rejects unknown event types instead of stripping them into a known one", () => {
    const result = validateMessage(
      { kind: "host-event" },
      hostEvent("message.start", RUN_SCOPE, { text: "x" }),
    );
    expect(result).toMatchObject({ success: false });
    if (!result.success) expect(result.failure.reason).toBe("UNKNOWN_EVENT");
  });

  it("answers inherited Object.prototype names with UNKNOWN_EVENT, never a crash", () => {
    for (const type of ["constructor", "toString", "__proto__", "prototype"]) {
      const result = validateMessage(
        { kind: "host-event" },
        hostEvent(type, RUN_SCOPE, { text: "x" }),
      );
      expect(result).toMatchObject({ success: false });
      if (!result.success) expect(result.failure.reason).toBe("UNKNOWN_EVENT");
    }
  });

  it("rejects scope/payload id mismatches per event", () => {
    const wrongSession = validateMessage(
      { kind: "host-event" },
      hostEvent("session.created", { kind: "session", sessionId: "s-other" }, { session: sessionSummary() }),
    );
    expect(wrongSession).toMatchObject({ success: false });

    const wrongRun = validateMessage(
      { kind: "host-event" },
      hostEvent("run.updated", { ...RUN_SCOPE, runId: "r-other" }, { run: activeRun("running") }),
    );
    expect(wrongRun).toMatchObject({ success: false });

    const wrongPlugin = validateMessage(
      { kind: "host-event" },
      hostEvent("plugin.updated", { kind: "plugin", pluginId: "other" }, { plugin: pluginSummary("enabled") }),
    );
    expect(wrongPlugin).toMatchObject({ success: false });
  });

  it("rejects a run.updated carrying a terminal run", () => {
    const result = validateMessage(
      { kind: "host-event" },
      hostEvent("run.updated", RUN_SCOPE, { run: terminalRun("completed") }),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("rejects a run.tool.call whose result slot is already filled", () => {
    const filled = liveToolItem();
    (filled as { result: unknown }).result = { ok: true, content: "42" };
    const result = validateMessage(
      { kind: "host-event" },
      hostEvent("run.tool.call", RUN_SCOPE, { item: filled }),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("rejects a run.ended whose session still names the run as active", () => {
    const session = sessionSummary();
    (session as { activeRunId: string | null }).activeRunId = "r-1";
    const result = validateMessage(
      { kind: "host-event" },
      hostEvent("run.ended", RUN_SCOPE, { run: terminalRun("completed"), session }),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("rejects a session.created that is not a fresh empty session", () => {
    // A create announces a session with no history; one that already has a
    // committed position is something else wearing the event's name.
    const dirty = { ...sessionSummary(), committedSeq: 3 };
    const result = validateMessage(
      { kind: "host-event" },
      hostEvent(
        "session.created",
        { kind: "session", sessionId: "s-1" },
        { session: dirty, collections: collectionRevisions() },
      ),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("rejects a wrong scope kind per event type", () => {
    const result = validateMessage(
      { kind: "host-event" },
      hostEvent("host.request.cancelled", RUN_SCOPE, { requestId: "h-1", reason: "timeout" }),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("keeps live tool items with empty and duplicated callIds valid", () => {
    for (const callId of ["", "call-1"]) {
      const result = validateMessage(
        { kind: "host-event" },
        hostEvent("run.tool.call", RUN_SCOPE, { item: liveToolItem("inv-1", callId) }),
      );
      expect(result.success).toBe(true);
    }

    // Two separate invocations sharing one provider callId are two items.
    const first = validateMessage(
      { kind: "host-event" },
      hostEvent("run.tool.call", RUN_SCOPE, { item: liveToolItem("inv-1", "call-1") }),
    );
    const second = validateMessage(
      { kind: "host-event" },
      hostEvent("run.tool.call", RUN_SCOPE, { item: liveToolItem("inv-2", "call-1") }),
    );
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
  });

  it("keeps an empty-string tool name valid in live items", () => {
    const nameless = { ...liveToolItem(), name: "" };
    const result = validateMessage(
      { kind: "host-event" },
      hostEvent("run.tool.call", RUN_SCOPE, { item: nameless }),
    );
    expect(result.success).toBe(true);
  });

  it("strips unknown fields from event payloads but not from scope discrimination", () => {
    const event = validEvent("run.output.delta");
    (event["payload"] as Record<string, unknown>)["bonus"] = "x";
    const result = validateMessage({ kind: "host-event" }, event);
    expect(result.success).toBe(true);
    if (result.success) {
      const output = result.output as Extract<HostEvent, { type: "run.output.delta" }>;
      expect(Object.keys(output.payload)).toEqual(["itemId", "text"]);
    }
  });

  it("never exports semantics the Core does not produce", () => {
    // Sanity pin on the frozen v2 literal set itself.
    expect(EVENT_TYPES).toHaveLength(11);
    expect(EVENT_TYPES).not.toContain("message.start");
    expect(EVENT_TYPES).not.toContain("tool.args.delta");
    expect(EVENT_TYPES).not.toContain("state.delta");
  });
});
