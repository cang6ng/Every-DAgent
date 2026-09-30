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
  CanonicalItem,
  HostSnapshot,
  OperationMap,
  PluginSummary,
  ProtocolErrorCode,
  RunSnapshot,
  SessionSnapshot,
} from "@every-dagent/protocol";

import { createShellControllerWith, explainError, normalizedOrigin } from "../src/browser/controller.js";
import { memorySelectionStorage } from "../src/browser/selection.js";

const INSTANCE = "host-instance-a";

function sessionFixture(sessionId: string, canonical: readonly CanonicalItem[] = []): SessionSnapshot {
  return { sessionId, createdAt: 1_700_000_000_000, status: "ready", activeRunId: null, canonical };
}

function pluginFixture(id: string, status: PluginSummary["status"] = "disabled"): PluginSummary {
  return { id, name: id, version: "1.0.0", permissions: [], status };
}

function runFixture(runId: string, sessionId: string, status: RunSnapshot["status"] = "completed"): RunSnapshot {
  const base = { runId, submissionId: `sub-${runId}`, sessionId, text: "hi", turnId: null, cancelRequested: false };
  switch (status) {
    case "accepted":
    case "running":
      return { ...base, status, endReason: null, error: null, live: [] };
    case "completed":
      return { ...base, status: "completed", endReason: "completed", error: null, live: null };
    case "limited":
      return { ...base, status: "limited", endReason: "max_steps", error: null, live: null };
    case "cancelled":
      return { ...base, status: "cancelled", endReason: "cancelled", error: null, live: null };
    case "failed":
      return { ...base, status: "failed", endReason: "error", error: { code: "INTERNAL_ERROR", message: "it failed" }, live: null };
  }
}

function presentationFixture(parts: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    hostInstanceId: INSTANCE,
    watermark: { streamId: "stream-1", sequence: 3 },
    sessions: [],
    runs: [],
    plugins: [],
    ...parts,
  };
}

function snapshotFixture(parts: Partial<ClientSnapshot> = {}): ClientSnapshot {
  const base: ClientSnapshot = {
    status: "ready",
    description: {
      protocolVersion: "1",
      hostInstanceId: INSTANCE,
      host: { name: "every-dagent-host", version: "0.1.0" },
      capabilities: { sessions: true, runs: true, plugins: true, subscriptions: true, reverseRequests: false },
      clientCapabilities: { reverseRequests: true },
      limits: { maxActiveRuns: 1 },
      retention: "host-lifetime",
    },
    presentation: presentationFixture(),
    presentationHost: "current",
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
      return Promise.resolve({ sessions: [] });
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
