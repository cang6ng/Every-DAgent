/**
 * What the panels render, checked on the markup they produce.
 *
 * These are static renders — `renderToStaticMarkup`, no DOM — so what is
 * checked is the structure and the text a page would contain, not the browser
 * behaviour (the real-browser files cover that). What matters here is the
 * vocabulary: live items are labelled live, terminal states carry their
 * caveats, `ok:false` is not explained away, a plugin in error has no reset,
 * and tool text is escaped rather than executed.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ClientSnapshot, HistoryCoverage } from "@every-dagent/client";
import type {
  ActiveRunSnapshot,
  CanonicalItem,
  HostSnapshot,
  LiveItem,
  PluginSummary,
  RunSummary,
  SessionSummary,
} from "@every-dagent/protocol";

import { App } from "../src/browser/App.js";
import { ConnectionPanel } from "../src/browser/ConnectionPanel.js";
import { ConnectionStatus } from "../src/browser/ConnectionStatus.js";
import { Conversation } from "../src/browser/Conversation.js";
import { HostPanel } from "../src/browser/HostPanel.js";
import { NoticesPanel } from "../src/browser/NoticesPanel.js";
import { PluginsPanel } from "../src/browser/PluginsPanel.js";
import { RunStrip } from "../src/browser/RunStrip.js";
import { ToolCallCard, ToolResultCard } from "../src/browser/ToolCard.js";
import { createShellControllerWith, type ShellUiState } from "../src/browser/controller.js";
import { memorySelectionStorage } from "../src/browser/selection.js";

const INSTANCE = "instance-abcdefgh";

const DURABLE_STORAGE = { storageId: "storage-1", retention: "durable" as const, schemaVersion: 1 };

function uiState(parts: Partial<ShellUiState> = {}): ShellUiState {
  return {
    bindingOrigin: "http://127.0.0.1:4100",
    selection: null,
    creatingSession: false,
    startingRun: false,
    cancellingRunId: null,
    pluginPending: {},
    historyLoading: false,
    notices: [],
    unknownWrites: [],
    ...parts,
  };
}

function presentation(parts: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    hostInstanceId: INSTANCE,
    watermark: { streamId: "s", sequence: 1 },
    storage: DURABLE_STORAGE,
    collections: { sessions: 1, runs: 1, plugins: 1 },
    sessions: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false },
    runs: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false },
    plugins: [],
    ...parts,
  };
}

function snapshot(parts: Partial<ClientSnapshot> = {}): ClientSnapshot {
  const base: ClientSnapshot = {
    status: "ready",
    description: {
      protocolVersion: "2",
      hostInstanceId: INSTANCE,
      host: { name: "every-dagent-host", version: "0.1.0" },
      storage: DURABLE_STORAGE,
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
    presentation: presentation(),
    presentationHost: "current",
    live: {},
    history: {},
    stale: false,
    error: null,
  };
  return { ...base, ...parts };
}

function session(parts: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "session-1",
    generation: 1,
    title: "会话 session-1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    status: "ready",
    blockedReason: null,
    metadataRevision: 0,
    historyRevision: 1,
    committedSeq: 4,
    activeRunId: null,
    ...parts,
  };
}

/** What the client has read of one session's history, as `Conversation` takes it. */
function coverage(items: readonly CanonicalItem[], parts: Partial<HistoryCoverage> = {}): HistoryCoverage {
  return {
    storageId: "storage-1",
    sessionId: "session-1",
    generation: 1,
    historyRevision: 1,
    fenceSeq: 4,
    fromSeq: 0,
    toSeq: 4,
    atStart: true,
    atFence: true,
    behind: false,
    nextCursor: null,
    items,
    segments: [],
    ...parts,
  };
}

function activeRun(parts: Partial<ActiveRunSnapshot> = {}): ActiveRunSnapshot {
  const base = {
    runId: "run-1",
    submissionId: "sub-1",
    sessionId: "session-1",
    text: "算一下",
    turnId: null,
    cancelRequested: false,
    acceptedAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    endedAt: null,
    live: [],
    liveTruncated: false,
  };
  return { ...base, status: "running", endReason: null, error: null, executionKnowledge: null, ...parts };
}

/** The durable summary a settled run is shown by, once its timeline is gone. */
function runSummary(parts: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    submissionId: "sub-1",
    sessionId: "session-1",
    text: "算一下",
    turnId: null,
    cancelRequested: false,
    acceptedAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_000,
    status: "completed",
    endReason: "completed",
    error: null,
    executionKnowledge: null,
    ...parts,
  };
}

const noop = (): void => undefined;

describe("the connection chip and panel", () => {
  it("names every status in plain words", () => {
    for (const [status, expected] of [
      ["disconnected", "未连接"],
      ["connecting", "正在连接"],
      ["connected", "已连接（未同步）"],
      ["syncing", "正在同步"],
      ["lost", "连接已断开"],
      ["protocol-error", "协议错误（已停止）"],
    ] as const) {
      const markup = renderToStaticMarkup(
        <ConnectionStatus snapshot={snapshot({ status, presentation: null, presentationHost: "none" })} />,
      );
      expect(markup).toContain(expected);
    }
  });

  it("says a stale presentation is read-only and was not cancelled", () => {
    const markup = renderToStaticMarkup(
      <ConnectionPanel
        snapshot={snapshot({ status: "lost", stale: true })}
        ui={uiState()}
        onConnectTo={noop}
        onReconnect={noop}
        onDisconnect={noop}
      />,
    );
    expect(markup).toContain("断开连接不会取消正在运行的任务");
  });

  it("keeps the previous-host and stale notes while a connection is not ready", () => {
    // A panel full of the previous host's facts under a "正在同步" chip is
    // exactly where a reader would take them for confirmed, current facts —
    // every unsettled status has to keep saying what the presentation is.
    for (const status of ["disconnected", "connecting", "connected", "syncing"] as const) {
      const markup = renderToStaticMarkup(
        <ConnectionPanel
          snapshot={snapshot({ status, stale: true, presentationHost: "previous" })}
          ui={uiState()}
          onConnectTo={noop}
          onReconnect={noop}
          onDisconnect={noop}
        />,
      );
      expect(markup, `${status} must carry the previous-host note`).toContain("展示的是上一个 Host 的内容，仅供参考。");
      expect(markup, `${status} must carry the stale note`).toContain("展示的是最后一次同步的内容。");
    }

    // And a syncing page with nothing to show yet has nothing to warn about.
    const empty = renderToStaticMarkup(
      <ConnectionPanel
        snapshot={snapshot({ status: "syncing", stale: false, presentation: null, presentationHost: "none" })}
        ui={uiState()}
        onConnectTo={noop}
        onReconnect={noop}
        onDisconnect={noop}
      />,
    );
    expect(empty).not.toContain("展示的是最后一次同步的内容。");
  });
});

describe("the conversation", () => {
  const canonical: readonly CanonicalItem[] = [
    { id: "item-1", turnId: "turn-1", seq: 0, kind: "user", text: "算一下 6*7" },
    { id: "item-2", turnId: "turn-1", seq: 1, kind: "tool-call", invocationId: "inv-1", callId: "call-1", name: "calculator", input: { kind: "json", value: { a: 6, b: 7 } } },
    { id: "item-3", turnId: "turn-1", seq: 2, kind: "tool-result", invocationId: "inv-1", callId: "call-1", name: "calculator", ok: true, content: "42" },
    { id: "item-4", turnId: "turn-1", seq: 3, kind: "assistant", text: "结果是 42。" },
  ];

  it("renders history and labels the live area as live", () => {
    const live: readonly LiveItem[] = [
      { kind: "text", itemId: "live-1", text: "正在生成" },
      { kind: "tool", itemId: "live-2", invocationId: "inv-2", callId: "", name: "calculator", input: { kind: "json", value: { a: 1, b: 2 } }, result: null },
    ];
    const markup = renderToStaticMarkup(
      <Conversation
        session={session({ activeRunId: "run-1" })}
        coverage={coverage(canonical)}
        activeRun={activeRun({ live })}
        loading={false}
        onLoadOlder={noop}
        onLoadNewer={noop}
      />,
    );

    expect(markup).toContain("data-testid=\"msg-user\"");
    expect(markup).toContain("data-testid=\"msg-assistant\"");
    expect(markup).toContain("data-testid=\"tool-input-json\"");
    expect(markup).toContain("42");
    // The live area is its own region, with the streaming text labelled.
    expect(markup).toContain("data-testid=\"live-run\"");
    expect(markup).toContain("生成中");
    expect(markup).toContain("data-testid=\"tool-pending\"");
    // An empty callId is shown as empty, never hidden.
    expect(markup).toContain("（空）");
  });

  it("says a conversation that has not been read yet is unread, not empty", () => {
    // The absence of coverage is a fact of its own: nothing has been read,
    // which is not the same as the session having no recorded messages.
    const markup = renderToStaticMarkup(
      <Conversation session={session()} coverage={null} activeRun={null} loading={false} onLoadOlder={noop} onLoadNewer={noop} />,
    );
    expect(markup).toContain("data-testid=\"history-unloaded\"");
    expect(markup).toContain("尚未读取该会话的历史");
  });

  it("keeps a blocked session readable but says it cannot continue", () => {
    const markup = renderToStaticMarkup(
      <Conversation
        session={session({ status: "blocked", blockedReason: "unknown-execution" })}
        coverage={coverage(canonical)}
        activeRun={null}
        loading={false}
        onLoadOlder={noop}
        onLoadNewer={noop}
      />,
    );
    expect(markup).toContain("data-testid=\"blocked-banner\"");
    // The banner names the reason the host gave, not a generic "blocked".
    expect(markup).toContain("无法确认是否已经产生副作用");
    expect(markup).toContain("结果是 42。");
  });

  it("escapes tool text instead of executing it", () => {
    const markup = renderToStaticMarkup(
      <ToolResultCard name="echo" callId="c" ok={true} content={'<script>alert("x")</script>'} />,
    );
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("shows an unavailable input honestly and does not explain ok:false away", () => {
    const markup = renderToStaticMarkup(
      <>
        <ToolCallCard name="calculator" callId="c" invocationId="i" input={{ kind: "unavailable", reason: "not-json-safe" }} result={null} live={false} />
        <ToolResultCard name="calculator" callId="c" ok={false} content="the tool failed" />
      </>,
    );
    expect(markup).toContain("data-testid=\"tool-input-unavailable\"");
    expect(markup).toContain("无法表示为 JSON");
    expect(markup).toContain("badge--fail");
    expect(markup).toContain("不证明调用没有被派发");
  });
});

describe("the run strip", () => {
  it("offers cancel while active and stops offering it once requested", () => {
    const active = renderToStaticMarkup(
      <RunStrip run={runSummary({ status: "running", endReason: null, endedAt: null })} cancelling={false} canWrite onCancel={noop} />,
    );
    expect(active).toContain("运行中");
    expect(active).toContain("data-testid=\"cancel-button\"");

    const requested = renderToStaticMarkup(
      <RunStrip
        run={runSummary({ status: "running", endReason: null, endedAt: null, cancelRequested: true })}
        cancelling={false}
        canWrite
        onCancel={noop}
      />,
    );
    expect(requested).toContain("data-testid=\"cancel-requested\"");
    expect(requested).not.toContain("data-testid=\"cancel-button\"");
    // The request is not the stop.
    expect(requested).toContain("运行中");
  });

  it("never describes a limited or cancelled run as a completion", () => {
    const limited = renderToStaticMarkup(
      <RunStrip run={runSummary({ status: "limited", endReason: "max_steps" })} cancelling={false} canWrite onCancel={noop} />,
    );
    expect(limited).toContain("达到步数上限");
    expect(limited).toContain("不是一次完整回答");
    expect(limited).not.toContain("已完成");

    const cancelled = renderToStaticMarkup(
      <RunStrip run={runSummary({ status: "cancelled", endReason: "cancelled" })} cancelling={false} canWrite onCancel={noop} />,
    );
    expect(cancelled).toContain("不会因此回滚");
  });

  it("shows a failed run's safe error", () => {
    const failed = renderToStaticMarkup(
      <RunStrip
        run={runSummary({
          status: "failed",
          endReason: "error",
          error: { code: "INTERNAL_ERROR", message: "it failed" },
        })}
        cancelling={false}
        canWrite
        onCancel={noop}
      />,
    );
    expect(failed).toContain("data-testid=\"run-error\"");
    expect(failed).toContain("INTERNAL_ERROR");
  });

  it("describes an interrupted run by what the record can prove", () => {
    // `interrupted` is its own terminal: a previous host stopped without
    // committing an outcome. An execution that was never observed running is
    // provably not-started; one with a running marker cannot be called either way.
    const notStarted = renderToStaticMarkup(
      <RunStrip
        run={runSummary({ status: "interrupted", endReason: "interrupted", executionKnowledge: "not-started" })}
        cancelling={false}
        canWrite
        onCancel={noop}
      />,
    );
    expect(notStarted).toContain("已中断");
    expect(notStarted).toContain("可以确认它没有被执行");

    const unknown = renderToStaticMarkup(
      <RunStrip
        run={runSummary({ status: "interrupted", endReason: "interrupted", executionKnowledge: "unknown" })}
        cancelling={false}
        canWrite
        onCancel={noop}
      />,
    );
    expect(unknown).toContain("无法确认是否已经产生副作用");
    expect(unknown).not.toContain("可以确认它没有被执行");
  });
});

describe("the plugin panel", () => {
  const plugins: readonly PluginSummary[] = [
    { id: "calculator", name: "Calculator", version: "0.1.0", permissions: [], status: "disabled" },
    { id: "text-stats", name: "Text Stats", version: "1.0.0", description: "Measures a text.", permissions: ["storage"], status: "enabled" },
    {
      id: "broken",
      name: "Broken",
      version: "0.0.1",
      permissions: [],
      status: "error",
      lastFailure: { operation: "enable", phase: "activate", code: "PLUGIN_OPERATION_FAILED", message: "activation failed", cleanupFailureCount: 1 },
    },
  ];

  it("offers the one operation each state actually has", () => {
    const markup = renderToStaticMarkup(
      <PluginsPanel snapshot={snapshot({ presentation: presentation({ plugins }) })} ui={uiState()} canWrite hostBusy={false} onSetEnabled={noop} />,
    );
    expect(markup).toContain("data-testid=\"plugin-enable\" data-plugin-id=\"calculator\"");
    expect(markup).toContain("data-testid=\"plugin-disable\" data-plugin-id=\"text-stats\"");
    // An error plugin cannot be operated on at all: no reset, no retry.
    expect(markup).not.toContain("data-plugin-id=\"broken\" data-");
    expect(markup).toContain("没有自动重试或重置");
    expect(markup).toContain("activate");
    expect(markup).toContain("清理失败");
  });

  it("explains a busy host instead of hiding the buttons' reason", () => {
    const markup = renderToStaticMarkup(
      <PluginsPanel snapshot={snapshot({ presentation: presentation({ plugins }) })} ui={uiState()} canWrite hostBusy onSetEnabled={noop} />,
    );
    expect(markup).toContain("data-testid=\"plugins-busy\"");
    expect(markup).toContain("disabled");
  });

  it("does not mistake an inherited property for a pending plugin", () => {
    // A plugin id may legally be `constructor`; reading the pending map
    // unguarded would find `Object.prototype.constructor` and render the
    // plugin as permanently mid-operation, with its button disabled.
    const inherited: readonly PluginSummary[] = [
      { id: "constructor", name: "Constructor", version: "1.0.0", permissions: [], status: "disabled" },
    ];
    const markup = renderToStaticMarkup(
      <PluginsPanel
        snapshot={snapshot({ presentation: presentation({ plugins: inherited }) })}
        ui={uiState()}
        canWrite
        hostBusy={false}
        onSetEnabled={noop}
      />,
    );
    expect(markup).toContain("data-testid=\"plugin-enable\" data-plugin-id=\"constructor\"");
    expect(markup).not.toContain("启用中…");
  });
});

describe("notices and unconfirmed writes", () => {
  it("never lets a lost answer read as a failure or a retry", () => {
    const markup = renderToStaticMarkup(
      <NoticesPanel
        ui={uiState({
          unknownWrites: [
            { id: "u1", kind: "start", hostInstanceId: INSTANCE, createdAt: 0, sessionId: "s", submissionId: "sub", text: "hi" },
          ],
        })}
        snapshot={snapshot()}
        canWrite
        onCheck={noop}
        onResubmit={noop}
        onRefresh={noop}
        onDismiss={noop}
        onDismissNotice={noop}
      />,
    );
    expect(markup).toContain("可能已被接受并执行");
    expect(markup).toContain("不会自动重发");
    expect(markup).toContain("data-testid=\"unknown-resubmit\"");
    // Dismissing is not a claim about what happened.
    expect(markup).toContain("不代表该操作没有执行");
  });

  it("offers no resubmit for a different host and only refresh for a create", () => {
    const markup = renderToStaticMarkup(
      <NoticesPanel
        ui={uiState({
          unknownWrites: [
            { id: "u1", kind: "start", hostInstanceId: "other-host", createdAt: 0, sessionId: "s", submissionId: "sub", text: "hi" },
            { id: "u2", kind: "create-session", hostInstanceId: INSTANCE, createdAt: 0 },
          ],
        })}
        snapshot={snapshot()}
        canWrite
        onCheck={noop}
        onResubmit={noop}
        onRefresh={noop}
        onDismiss={noop}
        onDismissNotice={noop}
      />,
    );
    expect(markup).toContain("Host 已更换");
    expect(markup).toContain("data-testid=\"unknown-refresh\"");
  });

  it("identifies each unconfirmed operation by the ids its panels use", () => {
    // Two lost answers of the same kind are otherwise indistinguishable text:
    // the record has to name the session, the submission, the run, the plugin
    // or the host instance it concerns, in the same short forms used around it.
    const markup = renderToStaticMarkup(
      <NoticesPanel
        ui={uiState({
          unknownWrites: [
            {
              id: "u1",
              kind: "start",
              hostInstanceId: "11111111-2222-3333-4444-555555555555",
              createdAt: 0,
              sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
              submissionId: "bbbbbbbb-1111-2222-3333-444444444444",
              text: "算一下 6*7 顺带解释一下每一步怎么来的，越详细越好",
            },
            { id: "u2", kind: "cancel", hostInstanceId: "11111111-2222-3333-4444-555555555555", createdAt: 0, runId: "cccccccc-1111-2222-3333-444444444444" },
            { id: "u3", kind: "plugin", hostInstanceId: "11111111-2222-3333-4444-555555555555", createdAt: 0, pluginId: "calculator", operation: "disable" },
          ],
        })}
        snapshot={snapshot()}
        canWrite
        onCheck={noop}
        onResubmit={noop}
        onRefresh={noop}
        onDismiss={noop}
        onDismissNotice={noop}
      />,
    );
    expect(markup).toContain("data-testid=\"unknown-meta\"");
    expect(markup).toContain("会话 aaaaaaaa");
    expect(markup).toContain("提交 bbbbbbbb");
    // The prompt is recognisable, and a long one is cut rather than dropped in.
    expect(markup).toContain("内容「算一下 6*7 顺带解释一下每一步怎么来");
    expect(markup).not.toContain("越详细越好");
    expect(markup).toContain("运行 cccccccc");
    expect(markup).toContain("插件 calculator · 停用");
    expect(markup).toContain("Host 11111111");
  });
});

describe("the host panel and the whole shell", () => {
  it("states the in-memory retention plainly", () => {
    const markup = renderToStaticMarkup(<HostPanel snapshot={snapshot()} />);
    expect(markup).toContain("every-dagent-host");
    expect(markup).toContain("实例 instance");
    expect(markup).toContain("Host 停止后");
    expect(markup).toContain("并发运行上限 1");
  });

  it("renders the whole shell with no sessions and no connection", () => {
    // One frozen snapshot candidate: `getSnapshot` must keep its identity, or
    // React would have to re-read it forever.
    const disconnected = snapshot({ status: "disconnected", description: null, presentation: null, presentationHost: "none" });
    const controller = createShellControllerWith(
      {
        // The smallest client that satisfies the shell: nothing is called here.
        connect: async () => undefined,
        reconnect: async () => undefined,
        disconnect: () => undefined,
        resync: async () => undefined,
        closeSubscription: async () => undefined,
        getSnapshot: () => disconnected,
        getState: () => disconnected,
        subscribe: () => () => undefined,
        sessions: {
          list: async () => ({ sessions: presentation().sessions }),
          create: async () => ({ session: session() }),
          get: async () => ({ session: session() }),
          history: async () => {
            throw new Error("nothing is read here");
          },
          rename: async () => ({ session: session() }),
          delete: async () => ({ sessionId: "session-1", generation: 1, deleted: true as const }),
        },
        runs: {
          start: async () => ({ run: activeRun() }),
          get: async () => ({ run: activeRun() }),
          list: async () => ({ runs: presentation().runs }),
          cancel: async () => ({ run: activeRun() }),
        },
        plugins: { list: async () => ({ plugins: [] }), enable: async () => ({ plugin: plugins0() }), disable: async () => ({ plugin: plugins0() }) },
      },
      { storage: memorySelectionStorage(), initialBinding: null },
    );
    const markup = renderToStaticMarkup(<App controller={controller} />);

    expect(markup).toContain("Every-DAgent");
    expect(markup).toContain("data-testid=\"connection-status\"");
    expect(markup).toContain("未连接");
    expect(markup).toContain("data-testid=\"sessions-empty\"");
    expect(markup).toContain("data-testid=\"host-empty\"");
    expect(markup).toContain("data-testid=\"no-session\"");
  });
});

function plugins0(): PluginSummary {
  return { id: "p", name: "p", version: "0", permissions: [], status: "disabled" };
}
