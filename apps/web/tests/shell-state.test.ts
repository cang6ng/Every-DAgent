/**
 * The controller's own contract: what the shell does about writes, and what it
 * refuses to claim.
 *
 * The client here is a fake — the controller's job is bookkeeping and
 * phrasing, and both can be checked without a host. What must hold is the
 * honesty rule: only an `unknown` outcome becomes an "unconfirmed" record;
 * a refusal stays a refusal; and recovery is an explicit query or an explicit
 * resend of the same submission, never an automatic one.
 */

import { describe, expect, it } from "vitest";

import { ClientError, type Client, type ClientSnapshot } from "@every-dagent/client";
import type {
  HostSnapshot,
  OperationMap,
  PluginSummary,
  ProtocolErrorCode,
  RunSnapshot,
  SessionSummary,
} from "@every-dagent/protocol";

import { createShellControllerWith, explainError, normalizedOrigin } from "../src/browser/controller.js";
import { memorySelectionStorage } from "../src/browser/selection.js";

const INSTANCE = "host-instance-a";

const STORAGE = { storageId: "storage-1", retention: "ephemeral" as const, schemaVersion: 1 };

function sessionFixture(sessionId: string): SessionSummary {
  return {
    sessionId,
    generation: 1,
    title: `会话 ${sessionId}`,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    status: "ready",
    blockedReason: null,
    metadataRevision: 0,
    historyRevision: 0,
    committedSeq: 0,
    activeRunId: null,
  };
}

function pluginFixture(id: string, status: PluginSummary["status"] = "disabled"): PluginSummary {
  return {
    id,
    name: id,
    version: "1.0.0",
    permissions: [],
    status,
    desiredEnabled: false,
    configRevision: null,
    effectiveConfigRevision: null,
    restartRequired: false,
    unavailable: status === "error",
  };
}

function runFixture(runId: string, sessionId: string, status: RunSnapshot["status"] = "completed"): RunSnapshot {
  const base = {
    runId,
    submissionId: `sub-${runId}`,
    sessionId,
    text: "hi",
    turnId: null,
    cancelRequested: false,
    acceptedAt: 1_700_000_000_000,
    startedAt: null,
    endedAt: null,
  };
  switch (status) {
    case "accepted":
      return { ...base, status: "accepted", endReason: null, error: null, executionKnowledge: null, live: [], liveTruncated: false };
    case "running":
      return { ...base, status: "running", endReason: null, error: null, executionKnowledge: null, live: [], liveTruncated: false };
    case "completed":
      return { ...base, status: "completed", endReason: "completed", error: null, executionKnowledge: null, live: null };
    case "limited":
      return { ...base, status: "limited", endReason: "max_steps", error: null, executionKnowledge: null, live: null };
    case "cancelled":
      return { ...base, status: "cancelled", endReason: "cancelled", error: null, executionKnowledge: null, live: null };
    case "failed":
      return {
        ...base,
        status: "failed",
        endReason: "error",
        error: { code: "INTERNAL_ERROR", message: "it failed" },
        executionKnowledge: null,
        live: null,
      };
    case "interrupted":
      return {
        ...base,
        status: "interrupted",
        endReason: "interrupted",
        error: null,
        executionKnowledge: "unknown",
        live: null,
      };
  }
}

function presentationFixture(parts: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    hostInstanceId: INSTANCE,
    watermark: { streamId: "stream-1", sequence: 3 },
    storage: STORAGE,
    collections: { sessions: 1, runs: 1, plugins: 1 },
    sessions: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false },
    runs: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false },
    plugins: [],
    ...parts,
  };
}

function snapshotFixture(parts: Partial<ClientSnapshot> = {}): ClientSnapshot {
  const base: ClientSnapshot = {
    status: "ready",
    description: {
      protocolVersion: "2",
      hostInstanceId: INSTANCE,
      host: { name: "every-dagent-host", version: "0.1.0" },
      storage: STORAGE,
      capabilities: {
        sessions: true,
        runs: true,
        plugins: true,
        subscriptions: true,
        reverseRequests: false,
        historyPages: true,
        sessionMutations: true,
        settings: false,
        approvals: false,
      },
      clientCapabilities: { reverseRequests: true },
      limits: {
        maxActiveRuns: 1,
        maxInputBytes: 65536,
        maxRecordBytes: 262144,
        maxPageItems: 50,
        maxPageBytes: 196608,
        maxFrameBytes: 262144,
        maxOutboxBytes: 1048576,
        maxTitleChars: 200,
      },
    },
    presentation: presentationFixture(),
    presentationHost: "current",
    live: {},
    history: {},
    stale: false,
    error: null,
  };
  return { ...base, ...parts };
}

interface FakeCall {
  readonly method: string;
  readonly params: unknown;
}

class FakeClient implements Client {
  readonly calls: FakeCall[] = [];
  onConnect: (() => Promise<void>) | undefined;
  onReconnect: (() => Promise<void>) | undefined;
  onResync: (() => Promise<void>) | undefined;
  onCreate: (() => Promise<OperationMap["sessions.create"]["result"]>) | undefined;
  onStart: ((params: OperationMap["runs.start"]["params"]) => Promise<OperationMap["runs.start"]["result"]>) | undefined;
  onRunGet: ((params: OperationMap["runs.get"]["params"]) => Promise<OperationMap["runs.get"]["result"]>) | undefined;
  onCancel: ((params: OperationMap["runs.cancel"]["params"]) => Promise<OperationMap["runs.cancel"]["result"]>) | undefined;
  onEnable: ((params: OperationMap["plugins.enable"]["params"]) => Promise<OperationMap["plugins.enable"]["result"]>) | undefined;
  onDisable: ((params: OperationMap["plugins.disable"]["params"]) => Promise<OperationMap["plugins.disable"]["result"]>) | undefined;

  private current: ClientSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(initial: ClientSnapshot) {
    this.current = initial;
  }

  setSnapshot(snapshot: ClientSnapshot): void {
    this.current = snapshot;
    for (const listener of [...this.listeners]) listener();
  }

  getSnapshot(): ClientSnapshot {
    return this.current;
  }

  getState(): ClientSnapshot {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  async connect(): Promise<void> {
    this.calls.push({ method: "connect", params: {} });
    await this.onConnect?.();
  }

  async reconnect(): Promise<void> {
    this.calls.push({ method: "reconnect", params: {} });
    await this.onReconnect?.();
  }

  disconnect(): void {
    this.calls.push({ method: "disconnect", params: {} });
  }

  async resync(): Promise<void> {
    this.calls.push({ method: "resync", params: {} });
    await this.onResync?.();
  }

  async closeSubscription(): Promise<void> {
    this.calls.push({ method: "closeSubscription", params: {} });
  }

  readonly sessions = {
    list: (): Promise<OperationMap["sessions.list"]["result"]> => {
      this.calls.push({ method: "sessions.list", params: {} });
      return Promise.resolve({
        sessions: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false },
      });
    },
    create: (): Promise<OperationMap["sessions.create"]["result"]> => {
      this.calls.push({ method: "sessions.create", params: {} });
      return this.onCreate === undefined
        ? Promise.reject(new Error("no create behaviour"))
        : this.onCreate();
    },
    get: (params: OperationMap["sessions.get"]["params"]): Promise<OperationMap["sessions.get"]["result"]> => {
      this.calls.push({ method: "sessions.get", params });
      return Promise.reject(new Error("not used"));
    },
    history: (params: OperationMap["sessions.history"]["params"]): Promise<OperationMap["sessions.history"]["result"]> => {
      this.calls.push({ method: "sessions.history", params });
      return Promise.reject(new Error("not used"));
    },
    rename: (params: OperationMap["sessions.rename"]["params"]): Promise<OperationMap["sessions.rename"]["result"]> => {
      this.calls.push({ method: "sessions.rename", params });
      return Promise.reject(new Error("not used"));
    },
    delete: (params: OperationMap["sessions.delete"]["params"]): Promise<OperationMap["sessions.delete"]["result"]> => {
      this.calls.push({ method: "sessions.delete", params });
      return Promise.reject(new Error("not used"));
    },
  };

  readonly runs = {
    start: (params: OperationMap["runs.start"]["params"]): Promise<OperationMap["runs.start"]["result"]> => {
      this.calls.push({ method: "runs.start", params });
      return this.onStart === undefined ? Promise.reject(new Error("no start behaviour")) : this.onStart(params);
    },
    get: (params: OperationMap["runs.get"]["params"]): Promise<OperationMap["runs.get"]["result"]> => {
      this.calls.push({ method: "runs.get", params });
      return this.onRunGet === undefined ? Promise.reject(new Error("no get behaviour")) : this.onRunGet(params);
    },
    list: (params: OperationMap["runs.list"]["params"]): Promise<OperationMap["runs.list"]["result"]> => {
      this.calls.push({ method: "runs.list", params });
      return Promise.resolve({ runs: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false } });
    },
    cancel: (params: OperationMap["runs.cancel"]["params"]): Promise<OperationMap["runs.cancel"]["result"]> => {
      this.calls.push({ method: "runs.cancel", params });
      return this.onCancel === undefined ? Promise.reject(new Error("no cancel behaviour")) : this.onCancel(params);
    },
  };

  readonly plugins = {
    list: (): Promise<OperationMap["plugins.list"]["result"]> => {
      this.calls.push({ method: "plugins.list", params: {} });
      return Promise.resolve({ plugins: [] });
    },
    enable: (params: OperationMap["plugins.enable"]["params"]): Promise<OperationMap["plugins.enable"]["result"]> => {
      this.calls.push({ method: "plugins.enable", params });
      return this.onEnable === undefined ? Promise.reject(new Error("no enable behaviour")) : this.onEnable(params);
    },
    disable: (params: OperationMap["plugins.disable"]["params"]): Promise<OperationMap["plugins.disable"]["result"]> => {
      this.calls.push({ method: "plugins.disable", params });
      return this.onDisable === undefined ? Promise.reject(new Error("no disable behaviour")) : this.onDisable(params);
    },
  };
}

function unknownOutcome(): ClientError {
  return new ClientError({ kind: "connection", code: "CONNECTION_LOST", message: "lost", outcome: "unknown", reason: "channel-closed" });
}

function remoteError(code: ProtocolErrorCode, message = "no"): ClientError {
  return new ClientError({ kind: "remote", code, message });
}

function makeController(snapshot: ClientSnapshot = snapshotFixture(), initial: string | null = "http://127.0.0.1:4100") {
  const client = new FakeClient(snapshot);
  const storage = memorySelectionStorage();
  const controller = createShellControllerWith(client, {
    storage,
    initialBinding: initial,
    newId: (() => {
      let count = 0;
      return (): string => {
        count += 1;
        return `submission-${count}`;
      };
    })(),
    now: () => 1_700_000_000_000,
  });
  return { client, storage, controller };
}

describe("starting a run", () => {
  it("passes the submission through and clears the pending flag", async () => {
    const { client, controller } = makeController();
    let sawParams: OperationMap["runs.start"]["params"] | undefined;
    client.onStart = async (params) => {
      sawParams = params;
      return { run: runFixture("run-1", params.sessionId, "accepted") };
    };

    const submitted = await controller.startRun("session-1", "你好 ");

    expect(submitted).toBe(true);
    // The text is passed verbatim: the shell does not trim what the user sent.
    expect(sawParams).toEqual({ sessionId: "session-1", submissionId: "submission-1", text: "你好 " });
    expect(controller.getState().startingRun).toBe(false);
    expect(controller.getState().unknownWrites).toEqual([]);
  });

  it("refuses empty input without calling the client", async () => {
    const { client, controller } = makeController();
    const submitted = await controller.startRun("session-1", "   ");
    expect(submitted).toBe(false);
    expect(client.calls.filter((call) => call.method === "runs.start")).toEqual([]);
    expect(controller.getState().notices[0]?.text).toContain("不能为空");
  });

  it("guards against a second submit while one is in flight", async () => {
    const { client, controller } = makeController();
    let release: (() => void) | undefined;
    client.onStart = (params) =>
      new Promise((resolve) => {
        release = () => {
          resolve({ run: runFixture("run-1", params.sessionId, "accepted") });
        };
      });

    const first = controller.startRun("session-1", "one");
    await controller.startRun("session-1", "two");
    release?.();
    await first;

    const starts = client.calls.filter((call) => call.method === "runs.start");
    expect(starts).toHaveLength(1);
    expect((starts[0]?.params as { text: string }).text).toBe("one");
  });

  it("records an unknown outcome as unconfirmed, with the original identity", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw unknownOutcome();
    };

    const submitted = await controller.startRun("session-1", "hello");

    // The submission left the client; the draft may be cleared.
    expect(submitted).toBe(true);
    const [record] = controller.getState().unknownWrites;
    expect(record).toMatchObject({
      kind: "start",
      hostInstanceId: INSTANCE,
      sessionId: "session-1",
      submissionId: "submission-1",
      text: "hello",
    });
    expect(controller.getState().notices.at(-1)?.text).toContain("未确认");
  });

  it("keeps a definite refusal a refusal, not an unconfirmed write", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw remoteError("HOST_BUSY");
    };

    const submitted = await controller.startRun("session-1", "hello");

    expect(submitted).toBe(false);
    expect(controller.getState().unknownWrites).toEqual([]);
    expect(controller.getState().notices.at(-1)?.text).toContain("Host 正忙");
  });
});

describe("sessions and selection", () => {
  it("selects a created session under the described instance", async () => {
    const { client, storage, controller } = makeController();
    client.onCreate = async () => ({ session: sessionFixture("session-9") });

    await controller.createSession();

    expect(controller.getState().selection).toEqual({ hostInstanceId: INSTANCE, sessionId: "session-9" });
    expect(storage.read()).toEqual({ hostInstanceId: INSTANCE, sessionId: "session-9" });
  });

  it("records a lost create answer as unconfirmed", async () => {
    const { client, controller } = makeController();
    client.onCreate = async () => {
      throw unknownOutcome();
    };

    await controller.createSession();

    expect(controller.getState().unknownWrites[0]).toMatchObject({ kind: "create-session", hostInstanceId: INSTANCE });
    expect(controller.getState().creatingSession).toBe(false);
  });

  it("keeps a selection the user made while a create was still in flight", async () => {
    // The late answer belongs to a request from before the user picked another
    // session; selecting the new session here would take back that choice — and
    // with it the composer and whatever draft it was holding.
    const { client, storage, controller } = makeController();
    let release: (() => void) | undefined;
    client.onCreate = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ session: sessionFixture("session-9") });
        };
      });

    const creating = controller.createSession();
    controller.selectSession("session-4");
    release?.();
    await creating;

    expect(controller.getState().selection).toEqual({ hostInstanceId: INSTANCE, sessionId: "session-4" });
    expect(storage.read()).toEqual({ hostInstanceId: INSTANCE, sessionId: "session-4" });
    // Silence would leave the user wondering where the new session went.
    expect(controller.getState().notices.at(-1)?.text).toContain("未自动切换");
  });

  it("scopes a selection to the presentation's host", () => {
    const { controller } = makeController(
      snapshotFixture({ presentation: presentationFixture({ hostInstanceId: "another-host" }) }),
    );
    controller.selectSession("session-1");
    expect(controller.getState().selection).toEqual({ hostInstanceId: "another-host", sessionId: "session-1" });
  });
});

describe("cancel and plugin operations", () => {
  it("records a lost cancel answer without pretending the run stopped", async () => {
    const { client, controller } = makeController();
    client.onCancel = async () => {
      throw unknownOutcome();
    };

    await controller.cancelRun("run-7");

    expect(controller.getState().unknownWrites[0]).toMatchObject({ kind: "cancel", runId: "run-7" });
    expect(controller.getState().cancellingRunId).toBeNull();
  });

  it("records a lost plugin operation and reports a definite failure", async () => {
    const { client, controller } = makeController();
    client.onEnable = async () => {
      throw unknownOutcome();
    };
    await controller.setPluginEnabled("calculator", true);
    expect(controller.getState().unknownWrites[0]).toMatchObject({ kind: "plugin", pluginId: "calculator", operation: "enable" });

    client.onDisable = async () => {
      throw remoteError("PLUGIN_UNAVAILABLE");
    };
    await controller.setPluginEnabled("calculator", false);
    expect(controller.getState().unknownWrites).toHaveLength(1);
    expect(controller.getState().notices.at(-1)?.text).toContain("插件当前不可操作");
    expect(controller.getState().pluginPending).toEqual({});
  });

  it("treats a plugin id that names an inherited property like any other id", async () => {
    // `constructor` is a legal plugin id under the protocol's id grammar, and
    // the pending map is a plain record: an unguarded read finds
    // `Object.prototype.constructor` and the plugin is locked out of both
    // operations as if one were always in flight.
    const { client, controller } = makeController();
    let release: (() => void) | undefined;
    client.onEnable = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ plugin: pluginFixture("constructor", "enabled") });
        };
      });

    const enabling = controller.setPluginEnabled("constructor", true);
    // Own property, not the inherited one: the operation really started.
    expect(Object.hasOwn(controller.getState().pluginPending, "constructor")).toBe(true);
    release?.();
    await enabling;

    expect(client.calls.filter((call) => call.method === "plugins.enable")).toHaveLength(1);
    expect(controller.getState().pluginPending).toEqual({});
    // Not busy, and not a lost answer: an ordinary operation, correctly recorded.
    expect(controller.getState().notices.filter((notice) => notice.tone === "error")).toEqual([]);
    expect(controller.getState().unknownWrites).toEqual([]);
  });
});

describe("recovering an unconfirmed submission", () => {
  it("resolves the record when the host confirms it", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw unknownOutcome();
    };
    await controller.startRun("session-1", "hello");
    const record = controller.getState().unknownWrites[0];

    client.onRunGet = async (params) => {
      expect(params).toEqual({ submissionId: "submission-1" });
      return { run: runFixture("run-3", "session-1", "completed") };
    };
    await controller.checkUnknown(record?.id ?? "");

    expect(controller.getState().unknownWrites).toEqual([]);
    expect(controller.getState().notices.at(-1)?.text).toContain("已被 Host 接受");
  });

  it("keeps the record when the host does not know the submission", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw unknownOutcome();
    };
    await controller.startRun("session-1", "hello");
    const record = controller.getState().unknownWrites[0];

    client.onRunGet = async () => {
      throw remoteError("RUN_NOT_FOUND");
    };
    await controller.checkUnknown(record?.id ?? "");

    expect(controller.getState().unknownWrites).toHaveLength(1);
    expect(controller.getState().notices.at(-1)?.text).toContain("仍待确认");
  });

  it("refuses to confirm anything across a host change", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw unknownOutcome();
    };
    await controller.startRun("session-1", "hello");
    const record = controller.getState().unknownWrites[0];

    // The page reconnects to a different host.
    client.setSnapshot(
      snapshotFixture({
        description: { ...snapshotFixture().description!, hostInstanceId: "host-instance-b" },
        presentation: presentationFixture({ hostInstanceId: "host-instance-b" }),
      }),
    );

    let queried = false;
    client.onRunGet = async () => {
      queried = true;
      return { run: runFixture("run-3", "session-1", "completed") };
    };
    await controller.checkUnknown(record?.id ?? "");

    expect(queried).toBe(false);
    expect(controller.getState().unknownWrites).toHaveLength(1);
    expect(controller.getState().notices.at(-1)?.text).toContain("Host 已更换");
  });

  it("resends the same submission verbatim, on the same host", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw unknownOutcome();
    };
    await controller.startRun("session-1", "hello world");
    const record = controller.getState().unknownWrites[0];

    const resent: OperationMap["runs.start"]["params"][] = [];
    client.onStart = async (params) => {
      resent.push(params);
      return { run: runFixture("run-9", params.sessionId, "completed") };
    };
    await controller.resubmitUnknownStart(record?.id ?? "");

    expect(resent).toEqual([{ sessionId: "session-1", submissionId: "submission-1", text: "hello world" }]);
    expect(controller.getState().unknownWrites).toEqual([]);
  });
});

describe("connection controls and notices", () => {
  it("refuses to connect without an address, and normalizes a valid one", async () => {
    const bare = makeController(snapshotFixture(), null);
    await bare.controller.connect();
    expect(bare.controller.getState().notices.at(-1)?.text).toContain("尚未配置");

    await bare.controller.connectTo("not a url");
    expect(bare.controller.getState().notices.at(-1)?.text).toContain("不是有效的");

    await bare.controller.connectTo("http://127.0.0.1:4100/");
    expect(bare.controller.getState().bindingOrigin).toBe("http://127.0.0.1:4100");
    expect(bare.client.calls.some((call) => call.method === "connect")).toBe(true);
  });

  it("keeps only the newest notices", async () => {
    const { controller } = makeController();
    for (let index = 0; index < 12; index += 1) {
      await controller.startRun("session-1", "   ");
    }
    expect(controller.getState().notices).toHaveLength(8);
  });

  it("dismisses records and notices without touching anything else", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw unknownOutcome();
    };
    await controller.startRun("session-1", "hello");
    const record = controller.getState().unknownWrites[0];

    controller.dismissUnknown(record?.id ?? "");
    expect(controller.getState().unknownWrites).toEqual([]);

    const notice = controller.getState().notices[0];
    controller.dismissNotice(notice?.id ?? "");
    expect(controller.getState().notices.map((entry) => entry.id)).not.toContain(notice?.id);
  });
});

describe("phrasing", () => {
  it("maps every error kind to a sentence without parsing the wire message", () => {
    expect(explainError(remoteError("HOST_BUSY", "not parsable"))).toContain("Host 正忙");
    expect(explainError(unknownOutcome())).toContain("结果未知");
    expect(
      explainError(new ClientError({ kind: "client", code: "CLIENT_MISUSE", message: "no", outcome: "not-sent", reason: "sync-in-flight" })),
    ).toContain("未发送");
    expect(explainError(new ClientError({ kind: "protocol", code: "PROTOCOL_VIOLATION", message: "no", outcome: "unknown", reason: "invalid-frame" }))).toContain("协议错误");
    expect(explainError(new Error("raw"))).toContain("未预期");
  });

  it("accepts only real http origins", () => {
    expect(normalizedOrigin("http://127.0.0.1:4100")).toBe("http://127.0.0.1:4100");
    expect(normalizedOrigin("http://127.0.0.1:4100/")).toBe("http://127.0.0.1:4100");
    expect(normalizedOrigin("ftp://example.com")).toBeNull();
    expect(normalizedOrigin("http://user:pass@127.0.0.1:1")).toBeNull();
    expect(normalizedOrigin("")).toBeNull();
  });
});
