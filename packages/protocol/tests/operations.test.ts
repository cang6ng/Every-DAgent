import { describe, expect, it } from "vitest";

import { validateMessage, type CanonicalItem, type OperationName } from "@every-dagent/protocol";

import {
  collectionRevisions,
  describeParams,
  describeRequest,
  historyPage,
  hostDescription,
  hostResponseError,
  hostResponseSuccess,
  INSTANCE,
  pluginSummary,
  protocolError,
  runPage,
  sessionPage,
  sessionSummary,
  storageIdentity,
  terminalRun,
  activeRun,
  businessRequest,
} from "./helpers/fixtures.js";

const OPERATIONS: readonly OperationName[] = [
  "host.describe",
  "sessions.list",
  "sessions.create",
  "sessions.get",
  "runs.start",
  "runs.get",
  "runs.cancel",
  "plugins.list",
  "plugins.enable",
  "plugins.disable",
  "subscriptions.open",
  "subscriptions.close",
];

function validParamsFor(method: OperationName): unknown {
  switch (method) {
    case "host.describe":
      return describeParams();
    case "sessions.list":
    case "sessions.create":
    case "plugins.list":
    case "subscriptions.open":
      return {};
    case "sessions.get":
      return { sessionId: "s-1" };
    case "runs.start":
      return { sessionId: "s-1", submissionId: "sub-1", text: "hello" };
    case "runs.get":
      return { runId: "r-1" };
    case "runs.cancel":
      return { runId: "r-1" };
    case "plugins.enable":
    case "plugins.disable":
      return { pluginId: "calculator" };
    case "subscriptions.close":
      return { streamId: "stream-1" };
  }
}

function validResultFor(method: OperationName): unknown {
  switch (method) {
    case "host.describe":
      return hostDescription();
    case "sessions.list":
      return { sessions: sessionPage([sessionSummary()]) };
    case "sessions.create":
      return { session: sessionSummary() };
    case "sessions.get":
      return { session: sessionSummary() };
    case "runs.start":
    case "runs.get":
    case "runs.cancel":
      return { run: activeRun() };
    case "plugins.list":
      return { plugins: [pluginSummary()] };
    case "plugins.enable":
    case "plugins.disable":
      return { plugin: pluginSummary("enabled") };
    case "subscriptions.open":
      return { snapshot: hostSnapshotForOpen() };
    case "subscriptions.close":
      return { closed: true };
  }
}

function hostSnapshotForOpen(): Record<string, unknown> {
  return {
    hostInstanceId: INSTANCE,
    watermark: { streamId: "stream-1", sequence: 0 },
    storage: storageIdentity(),
    collections: collectionRevisions(),
    sessions: sessionPage([sessionSummary()]),
    runs: runPage(),
    plugins: [pluginSummary()],
  };
}

describe("operation requests", () => {
  it.each(OPERATIONS)("validates a well-formed %s request", (method) => {
    const input =
      method === "host.describe" ? describeRequest() : businessRequest(method, validParamsFor(method));
    const result = validateMessage({ kind: "client-request" }, input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.method).toBe(method);
  });

  it("keeps runs.start text verbatim and requires non-whitespace content", () => {
    const raw = "  spaced  ";
    const result = validateMessage(
      { kind: "client-request" },
      businessRequest("runs.start", { sessionId: "s-1", submissionId: "sub-1", text: raw }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.output as { params: { text: string } }).params.text).toBe(raw);
    }

    const blank = validateMessage(
      { kind: "client-request" },
      businessRequest("runs.start", { sessionId: "s-1", submissionId: "sub-1", text: "   " }),
    );
    expect(blank.success).toBe(false);
  });

  it("requires exactly one runs.get selector, checked before stripping", () => {
    const both = validateMessage(
      { kind: "client-request" },
      businessRequest("runs.get", { runId: "r-1", submissionId: "sub-1" }),
    );
    const neither = validateMessage(
      { kind: "client-request" },
      businessRequest("runs.get", {}),
    );
    expect(both.success).toBe(false);
    expect(neither.success).toBe(false);
  });

  it("rejects hostInstanceId on host.describe and requires it on business methods", () => {
    const withInstance = validateMessage({ kind: "client-request" }, {
      ...describeRequest(),
      hostInstanceId: INSTANCE,
    });
    expect(withInstance.success).toBe(false);

    const withoutInstance = validateMessage({ kind: "client-request" }, {
      kind: "client-request",
      protocolVersion: "2",
      requestId: "c-9",
      method: "sessions.list",
      params: {},
    });
    expect(withoutInstance.success).toBe(false);
    if (!withoutInstance.success) {
      expect(withoutInstance.failure.correlation).toEqual({
        kind: "client-request",
        requestId: "c-9",
      });
    }
  });

  it("rejects empty host-generated ids without trimming", () => {
    const result = validateMessage(
      { kind: "client-request" },
      businessRequest("sessions.get", { sessionId: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("keeps an id with surrounding whitespace verbatim (no trim, no normalize)", () => {
    const result = validateMessage(
      { kind: "client-request" },
      businessRequest("sessions.get", { sessionId: " s-1 " }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.output as { params: { sessionId: string } }).params.sessionId).toBe(" s-1 ");
    }
  });

  it("rejects a params array where an empty params object is required", () => {
    const result = validateMessage(
      { kind: "client-request" },
      businessRequest("sessions.list", []),
    );
    expect(result.success).toBe(false);
  });

  it("strips unknown params fields on fixed DTOs", () => {
    const result = validateMessage(
      { kind: "client-request" },
      businessRequest("sessions.get", { sessionId: "s-1", injected: "x" }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys((result.output as { params: object }).params)).toEqual(["sessionId"]);
    }
  });

  it("answers an unknown method with UNKNOWN_METHOD plus a safe correlation", () => {
    const result = validateMessage(
      { kind: "client-request" },
      businessRequest("credentials.read", {}),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failure.reason).toBe("UNKNOWN_METHOD");
      expect(result.failure.correlation).toEqual({ kind: "client-request", requestId: "c-2" });
    }
  });

  it("gates generations: unknown legal generation is UNSUPPORTED_PROTOCOL, garbage is INVALID_MESSAGE", () => {
    // "1" is a legal generation this host does not serve, and "3" is one that
    // does not exist yet: both are refused at the gate, not as malformed JSON.
    for (const protocolVersion of ["1", "3"]) {
      const unsupported = validateMessage({ kind: "client-request" }, {
        ...describeRequest(),
        protocolVersion,
      });
      expect(unsupported).toMatchObject({ success: false });
      if (!unsupported.success) expect(unsupported.failure.reason).toBe("UNSUPPORTED_PROTOCOL");
    }

    const malformed = validateMessage({ kind: "client-request" }, {
      ...describeRequest(),
      protocolVersion: "01",
    });
    if (!malformed.success) expect(malformed.failure.reason).toBe("INVALID_MESSAGE");
  });

  it("rejects non-JSON values before any schema runs", () => {
    const hostile = businessRequest("sessions.list", {});
    (hostile as Record<string, unknown>)["extra"] = () => 1;
    const result = validateMessage({ kind: "client-request" }, hostile);
    expect(result).toMatchObject({ success: false });
    if (!result.success) expect(result.failure.reason).toBe("NON_JSON_VALUE");
  });
});

describe("operation responses", () => {
  it.each(OPERATIONS)("validates a success response for %s", (method) => {
    const result = validateMessage(
      { kind: "host-response", method },
      hostResponseSuccess(validResultFor(method)),
    );
    expect(result.success).toBe(true);
  });

  it.each(OPERATIONS)("validates an error response for %s", (method) => {
    const result = validateMessage(
      { kind: "host-response", method },
      hostResponseError(),
    );
    expect(result.success).toBe(true);
  });

  it("enforces result XOR error at runtime, including both-present and neither-present", () => {
    const both = validateMessage(
      { kind: "host-response", method: "sessions.list" },
      { ...hostResponseSuccess({ sessions: [] }), error: protocolError() },
    );
    expect(both).toMatchObject({ success: false });

    const neither = validateMessage(
      { kind: "host-response", method: "sessions.list" },
      { kind: "host-response", protocolVersion: "2", hostInstanceId: INSTANCE, requestId: "c-1" },
    );
    expect(neither).toMatchObject({ success: false });
  });

  it("treats result: null as a present field, not an absence", () => {
    // `runs.get` cannot return null, so the schema rejects it — proving the
    // field was seen rather than ignored.
    const result = validateMessage(
      { kind: "host-response", method: "runs.get" },
      hostResponseSuccess(null),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("validates a sessions.create result as a fresh empty session", () => {
    // The rejection case: a session that already has committed history cannot
    // be the result of creating one.
    const reused = validateMessage(
      { kind: "host-response", method: "sessions.create" },
      hostResponseSuccess({ session: { ...sessionSummary(), committedSeq: 4, historyRevision: 1 } }),
    );
    expect(reused).toMatchObject({ success: false });

    const fresh = validateMessage(
      { kind: "host-response", method: "sessions.create" },
      hostResponseSuccess({ session: sessionSummary() }),
    );
    expect(fresh.success).toBe(true);
  });

  it("validates a subscriptions.open result with an initial zero watermark", () => {
    const badWatermark = validateMessage(
      { kind: "host-response", method: "subscriptions.open" },
      hostResponseSuccess({
        snapshot: { ...hostSnapshotForOpen(), watermark: { streamId: "stream-1", sequence: 3 } },
      }),
    );
    expect(badWatermark).toMatchObject({ success: false });
  });

  it("rejects a response whose result does not match the pending method", () => {
    const result = validateMessage(
      { kind: "host-response", method: "runs.get" },
      hostResponseSuccess({ sessions: [] }),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("rejects an unknown error code", () => {
    const result = validateMessage(
      { kind: "host-response", method: "runs.get" },
      { ...hostResponseError(), error: { code: "SOMETHING_ELSE", message: "x" } },
    );
    expect(result).toMatchObject({ success: false });
  });

  it("validates every terminal run shape, with limited distinct from completed", () => {
    for (const status of ["completed", "limited", "cancelled", "failed"] as const) {
      const result = validateMessage(
        { kind: "host-response", method: "runs.get" },
        hostResponseSuccess({ run: terminalRun(status) }),
      );
      expect(result.success).toBe(true);
    }

    // A "completed" run carrying max_steps is a lie the schema refuses.
    const mismatched = validateMessage(
      { kind: "host-response", method: "runs.get" },
      hostResponseSuccess({
        run: { ...terminalRun("completed"), endReason: "max_steps" },
      }),
    );
    expect(mismatched).toMatchObject({ success: false });
  });

  it("validates the methodless error-only target and refuses success there at runtime", () => {
    const error = validateMessage({ kind: "host-response" }, hostResponseError());
    expect(error.success).toBe(true);

    const success = validateMessage(
      { kind: "host-response" },
      hostResponseSuccess({ closed: true }),
    );
    expect(success).toMatchObject({ success: false });
  });

  it("reports INVALID_TARGET for a host-response selector naming an unknown method", () => {
    const result = validateMessage(
      // Cast: this misuse is exactly what the runtime must catch.
      { kind: "host-response", method: "no.such.method" } as unknown as { kind: "host-response"; method?: never },
      hostResponseError(),
    );
    expect(result).toMatchObject({ success: false });
    if (!result.success) expect(result.failure.reason).toBe("INVALID_TARGET");
  });
});

describe("prototype-chain selectors must not resolve (own-key checks)", () => {
  it("answers inherited Object.prototype names with UNKNOWN_METHOD, never a crash", () => {
    for (const method of ["constructor", "toString", "__proto__", "prototype", "valueOf"]) {
      const result = validateMessage(
        { kind: "client-request" },
        businessRequest(method, {}),
      );
      expect(result).toMatchObject({ success: false });
      if (!result.success) {
        expect(result.failure.reason).toBe("UNKNOWN_METHOD");
        expect(result.failure.correlation).toEqual({ kind: "client-request", requestId: "c-2" });
      }
    }
  });

  it("reports INVALID_TARGET for a host-response selector that only exists on prototypes", () => {
    const result = validateMessage(
      { kind: "host-response", method: "toString" } as unknown as { kind: "host-response"; method?: never },
      hostResponseError(),
    );
    expect(result).toMatchObject({ success: false });
    if (!result.success) expect(result.failure.reason).toBe("INVALID_TARGET");
  });

  it("keeps plugin id params on the frozen plugin-id shape", () => {
    for (const pluginId of ["Calculator", "", "has space", "ünicode"]) {
      const result = validateMessage(
        { kind: "client-request" },
        businessRequest("plugins.enable", { pluginId }),
      );
      expect(result).toMatchObject({ success: false });
    }
  });
});

describe("canonical occurrence validation (array-level)", () => {
  /**
   * One history page carrying exactly the given items.
   *
   * v2 has no `session.canonical`: committed items are read through
   * `sessions.history`, and the page's schema checks the log order and coverage
   * it claims. `seq` is assigned here in array order, exactly as a host numbers
   * its committed log.
   */
  function historyPageOf(items: readonly Record<string, unknown>[]): Record<string, unknown> {
    return {
      page: historyPage(
        items.map((item, index) => ({ ...item, seq: index + 1 })) as unknown as CanonicalItem[],
      ),
    };
  }

  const call = (invocationId: string, callId: string) => ({
    kind: "tool-call", id: `i-${invocationId}`, turnId: "turn-1",
    invocationId, callId, name: "calculator", input: { kind: "json", value: { a: 1 } },
  });
  const result = (invocationId: string, callId: string) => ({
    kind: "tool-result", id: `r-${invocationId}`, turnId: "turn-1",
    invocationId, callId, name: "calculator", ok: true, content: "42",
  });

  it("keeps two distinct invocations that share one empty or repeated callId", () => {
    for (const callId of ["", "call-1"]) {
      const page = historyPageOf([
        { kind: "user", id: "u-1", turnId: "turn-1", text: "go" },
        call("inv-1", callId),
        result("inv-1", callId),
        call("inv-2", callId),
        result("inv-2", callId),
      ]);
      const response = validateMessage(
        { kind: "host-response", method: "sessions.history" },
        hostResponseSuccess(page),
      );
      expect(response.success).toBe(true);
      if (response.success) {
        // Mutation guard: a callId-deduplicating implementation would drop
        // the second occurrence; both invocations must survive as their own
        // call + result pair.
        const items = (response.output as unknown as {
          result: { page: { items: { kind: string; invocationId?: string }[] } };
        }).result.page.items;
        expect(
          items.filter((item) => item.kind.startsWith("tool")).map((item) => item.invocationId),
        ).toEqual(["inv-1", "inv-1", "inv-2", "inv-2"]);
      }
    }
  });

  it("rejects a tool-result with no preceding matching tool-call", () => {
    const orphan = validateMessage(
      { kind: "host-response", method: "sessions.history" },
      hostResponseSuccess(historyPageOf([result("inv-1", "call-1")])),
    );
    expect(orphan).toMatchObject({ success: false });
  });

  it("rejects a pair whose turnId, callId or name disagrees", () => {
    const mismatchedCallId = historyPageOf([call("inv-1", "call-1"), result("inv-1", "other")]);
    const mismatchedName = historyPageOf([
      call("inv-1", "call-1"),
      { ...result("inv-1", "call-1"), name: "other-tool" },
    ]);
    const mismatchedTurn = historyPageOf([
      call("inv-1", "call-1"),
      { ...result("inv-1", "call-1"), turnId: "turn-2" },
    ]);
    for (const page of [mismatchedCallId, mismatchedName, mismatchedTurn]) {
      const response = validateMessage(
        { kind: "host-response", method: "sessions.history" },
        hostResponseSuccess(page),
      );
      expect(response).toMatchObject({ success: false });
    }
  });

  it("rejects duplicate item ids and reused invocation identities", () => {
    const duplicateItemId = historyPageOf([
      { kind: "user", id: "u-1", turnId: "turn-1", text: "a" },
      { kind: "user", id: "u-1", turnId: "turn-1", text: "b" },
    ]);
    const doubleConsume = historyPageOf([call("inv-1", "call-1"), result("inv-1", "call-1"), result("inv-1", "call-1")]);
    const reusedInvocation = historyPageOf([call("inv-1", "call-1"), result("inv-1", "call-1"), call("inv-1", "call-2")]);
    for (const page of [duplicateItemId, doubleConsume, reusedInvocation]) {
      const response = validateMessage(
        { kind: "host-response", method: "sessions.history" },
        hostResponseSuccess(page),
      );
      expect(response).toMatchObject({ success: false });
    }
  });

  it("accepts an empty-string tool name and an empty-string description", () => {
    const named = historyPageOf([
      { kind: "tool-call", id: "i-1", turnId: "t-1", invocationId: "inv-1", callId: "", name: "", input: { kind: "unavailable", reason: "not-json-safe" } },
      { kind: "tool-result", id: "i-2", turnId: "t-1", invocationId: "inv-1", callId: "", name: "", ok: false, content: "" },
    ]);
    const response = validateMessage(
      { kind: "host-response", method: "sessions.history" },
      hostResponseSuccess(named),
    );
    expect(response.success).toBe(true);

    const describedPlugin = { ...pluginSummary(), description: "" };
    const plugin = validateMessage(
      { kind: "host-response", method: "plugins.list" },
      hostResponseSuccess({ plugins: [describedPlugin] }),
    );
    expect(plugin.success).toBe(true);
  });
});

describe("host snapshot consistency (single-snapshot cross-field)", () => {
  function snapshotWith(
    runs: readonly unknown[],
    sessions: readonly unknown[],
  ): Record<string, unknown> {
    return {
      hostInstanceId: INSTANCE,
      watermark: { streamId: "stream-1", sequence: 0 },
      storage: storageIdentity(),
      collections: collectionRevisions(),
      sessions: sessionPage(sessions as never),
      runs: runPage(runs as never),
      plugins: [],
    };
  }

  const readySession = (activeRunId: string | null, sessionId = "s-1") => ({
    ...sessionSummary(), sessionId, activeRunId,
  });
  const activeRunOf = (runId: string, sessionId: string, submissionId = "sub-1") => ({
    ...activeRun("running"), runId, sessionId, submissionId,
  });

  it("accepts each session pointing at its own active run", () => {
    const response = validateMessage(
      { kind: "host-response", method: "subscriptions.open" },
      hostResponseSuccess({ snapshot: snapshotWith(
        [activeRunOf("r-1", "s-1", "sub-1"), activeRunOf("r-2", "s-2", "sub-2")],
        [readySession("r-1"), readySession("r-2", "s-2")],
      ) }),
    );
    expect(response.success).toBe(true);
  });

  it("rejects an active run that no session in the window points at", () => {
    const unpointed = validateMessage(
      { kind: "host-response", method: "subscriptions.open" },
      hostResponseSuccess({ snapshot: snapshotWith([activeRunOf("r-1", "s-1")], [readySession(null)]) }),
    );
    expect(unpointed).toMatchObject({ success: false });
  });

  it("rejects two sessions pointing at the same run, and a pointer across sessions", () => {
    const sharedPointer = validateMessage(
      { kind: "host-response", method: "subscriptions.open" },
      hostResponseSuccess({ snapshot: snapshotWith([activeRunOf("r-1", "s-1")], [readySession("r-1"), readySession("r-1", "s-2")]) }),
    );
    expect(sharedPointer).toMatchObject({ success: false });

    const crossSession = validateMessage(
      { kind: "host-response", method: "subscriptions.open" },
      hostResponseSuccess({ snapshot: snapshotWith([activeRunOf("r-1", "s-2")], [readySession("r-1")]) }),
    );
    expect(crossSession).toMatchObject({ success: false });
  });

  it("rejects duplicate submissionIds and duplicate run ids inside one snapshot", () => {
    const duplicateSubmission = validateMessage(
      { kind: "host-response", method: "subscriptions.open" },
      hostResponseSuccess({ snapshot: snapshotWith(
        [activeRunOf("r-1", "s-1", "sub-1"), activeRunOf("r-2", "s-2", "sub-1")],
        [readySession("r-1"), readySession("r-2", "s-2")],
      ) }),
    );
    expect(duplicateSubmission).toMatchObject({ success: false });

    const duplicateRunId = validateMessage(
      { kind: "host-response", method: "subscriptions.open" },
      hostResponseSuccess({ snapshot: snapshotWith(
        [activeRunOf("r-1", "s-1"), { ...activeRunOf("r-1", "s-2"), submissionId: "sub-2" }],
        [readySession("r-1"), readySession("r-1", "s-2")],
      ) }),
    );
    expect(duplicateRunId).toMatchObject({ success: false });
  });

  it("keeps a settled run whose session is outside the window, but never an unfinished one", () => {
    // v2: the session directory and the runs window are separate bounded pages,
    // so a settled run may legitimately outlive the page its session fell off.
    // An unfinished run may not: the window carries it, and a session in the
    // window has to point at it.
    for (const status of ["completed", "limited", "cancelled", "failed"] as const) {
      const settled = { ...terminalRun(status), sessionId: "s-orphan", submissionId: `sub-${status}` };
      const accepted = validateMessage(
        { kind: "host-response", method: "subscriptions.open" },
        hostResponseSuccess({ snapshot: snapshotWith([settled], [readySession(null)]) }),
      );
      expect(accepted.success).toBe(true);
    }

    const activeOrphan = validateMessage(
      { kind: "host-response", method: "subscriptions.open" },
      hostResponseSuccess({ snapshot: snapshotWith([activeRunOf("r-1", "s-orphan")], [readySession(null)]) }),
    );
    expect(activeOrphan).toMatchObject({ success: false });
  });

  it("accepts a settled terminal run whose session exists in the snapshot", () => {
    const response = validateMessage(
      { kind: "host-response", method: "subscriptions.open" },
      hostResponseSuccess({ snapshot: snapshotWith([terminalRun("completed")], [readySession(null)]) }),
    );
    expect(response.success).toBe(true);
  });
});
