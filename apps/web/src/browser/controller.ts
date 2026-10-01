/**
 * The shell's own logic, with no React in it.
 *
 * The controller owns the two things the shell is responsible for beyond the
 * client's snapshot: the few pieces of ephemeral UI state a page needs (which
 * host address was typed, which session is selected, which action is in
 * flight) and the "unconfirmed outcome" bookkeeping the platform's honesty
 * rules demand — a write whose answer was lost is shown as *unconfirmed*, and
 * the shell never converts that into either a silent retry or a claim that
 * nothing happened.
 *
 * It holds no host facts of its own: sessions, runs and plugins are read from
 * the client snapshot every time they are rendered, and nothing here writes a
 * response back into that snapshot. What is kept locally is only a description
 * of what the *user* did and what the *call* returned.
 */

import { ClientError, createClient, type Client, type ClientSnapshot } from "@every-dagent/client";
import type { ProtocolChannel, ProtocolErrorCode } from "@every-dagent/protocol";

import type { SelectionStorage, SessionSelection } from "./selection.js";
import { describedHostInstance, presentationHostInstance } from "./presentation.js";

export interface Notice {
  readonly id: string;
  readonly tone: "info" | "error";
  readonly text: string;
}

interface UnknownWriteBase {
  readonly id: string;
  /** The host instance the request was aimed at, when one was known. */
  readonly hostInstanceId: string | null;
  readonly createdAt: number;
}

export type UnknownWrite =
  | (UnknownWriteBase & {
      readonly kind: "start";
      readonly sessionId: string;
      readonly submissionId: string;
      readonly text: string;
    })
  | (UnknownWriteBase & { readonly kind: "cancel"; readonly runId: string })
  | (UnknownWriteBase & { readonly kind: "create-session" })
  | (UnknownWriteBase & {
      readonly kind: "plugin";
      readonly pluginId: string;
      readonly operation: "enable" | "disable";
    });

export interface ShellUiState {
  /** The host address to connect to; `null` until one is configured. */
  readonly bindingOrigin: string | null;
  readonly selection: SessionSelection | null;
  readonly creatingSession: boolean;
  readonly startingRun: boolean;
  /** The run whose cancel request is in flight, if any. */
  readonly cancellingRunId: string | null;
  readonly pluginPending: Readonly<Record<string, "enable" | "disable">>;
  readonly notices: readonly Notice[];
  readonly unknownWrites: readonly UnknownWrite[];
}

export interface ShellActions {
  connect(): Promise<void>;
  connectTo(origin: string): Promise<void>;
  reconnect(): Promise<void>;
  disconnect(): void;
  createSession(): Promise<void>;
  selectSession(sessionId: string): void;
  /**
   * Submits one run.
   *
   * Resolves `true` when the submission left the client — answered, or sent
   * with its answer lost — and `false` when it definitely did not: the caller
   * may clear a draft in the first case and must keep it in the second.
   */
  startRun(sessionId: string, text: string): Promise<boolean>;
  cancelRun(runId: string): Promise<void>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<void>;
  /** Queries the host for an unconfirmed write's outcome, when it can be queried at all. */
  checkUnknown(unknownId: string): Promise<void>;
  /** Re-sends the *same* start submission, letting host dedup decide, on the user's explicit ask. */
  resubmitUnknownStart(unknownId: string): Promise<void>;
  /** Re-synchronizes the presentation (a fresh snapshot replaces the old one). */
  refresh(): Promise<void>;
  dismissUnknown(unknownId: string): void;
  dismissNotice(noticeId: string): void;
}

export interface ShellController extends ShellActions {
  readonly client: Client;
  getState(): ShellUiState;
  subscribe(listener: () => void): () => void;
}

export interface ShellControllerOptions {
  readonly storage: SelectionStorage;
  /** The `?binding=` origin, when the page was opened with one. */
  readonly initialBinding: string | null;
}

export interface ComposedShellControllerOptions extends ShellControllerOptions {
  /** How a host origin becomes a channel; the browser passes `connectHttpChannel`. */
  readonly connector: (origin: string) => Promise<ProtocolChannel>;
  /** The submission-id source. Defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
  readonly now?: () => number;
}

const MAX_NOTICES = 8;

/** The host-error codes, as short fixed sentences. The wire message is never parsed; the code is the meaning. */
const REMOTE_HINTS: Readonly<Record<ProtocolErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: "请求不符合契约",
  UNSUPPORTED_PROTOCOL: "Host 不支持该协议代际",
  NOT_INITIALIZED: "连接尚未完成初始化",
  HOST_INSTANCE_MISMATCH: "目标 Host 与当前连接不一致",
  METHOD_NOT_FOUND: "Host 不认识该方法",
  CAPABILITY_NOT_SUPPORTED: "Host 未声明该能力",
  SESSION_NOT_FOUND: "会话不存在",
  SESSION_UNAVAILABLE: "会话当前不可用（可能已阻塞）",
  RUN_NOT_FOUND: "运行不存在",
  PLUGIN_NOT_FOUND: "插件不存在",
  HOST_BUSY: "Host 正忙：同一时间只允许一个运行或一次插件变更",
  PLUGIN_UNAVAILABLE: "插件当前不可操作（可能处于错误状态）",
  PLUGIN_PERMISSION_DENIED: "插件权限被拒绝",
  PLUGIN_OPERATION_FAILED: "插件操作失败",
  SUBMISSION_CONFLICT: "提交标识冲突",
  REQUEST_CANCELLED: "请求已被取消",
  INTERNAL_ERROR: "Host 内部错误",
});

const MISUSE_HINTS: Readonly<Record<string, string>> = Object.freeze({
  "not-initialized": "连接尚未完成初始化",
  "capability-unavailable": "Host 不支持该操作",
  "invalid-params": "请求参数不合法",
  "sync-in-flight": "已有一次同步正在进行",
  capacity: "客户端的未完成请求已达上限",
});

/**
 * The in-flight operation a plugin has, if it has one.
 *
 * The read is own-property only. A plugin id may legally be `constructor` (the
 * protocol's id grammar allows it), and an unguarded `pending[id]` read would
 * find `Object.prototype.constructor`, report the plugin as permanently busy,
 * and lock it out of both lifecycle operations.
 */
export function pluginPendingOf(
  pending: Readonly<Record<string, "enable" | "disable">>,
  pluginId: string,
): "enable" | "disable" | undefined {
  return Object.hasOwn(pending, pluginId) ? pending[pluginId] : undefined;
}

/** One client error, as a sentence for a person. */
export function explainError(error: unknown): string {
  if (error instanceof ClientError) {
    switch (error.kind) {
      case "remote":
        return `${REMOTE_HINTS[error.code as ProtocolErrorCode] ?? "Host 拒绝了该操作"}（${error.code}）`;
      case "connection":
        return error.outcome === "not-sent"
          ? `连接已断开，操作未发送（${error.code}）`
          : `连接已断开，操作结果未知（${error.code}）`;
      case "protocol":
        return error.outcome === "unknown"
          ? `协议错误：客户端已关闭连接，已发送操作的结果未知（${error.code}）`
          : `协议错误：客户端已关闭连接（${error.code}）`;
      case "client":
        return `操作未发送：${MISUSE_HINTS[error.reason ?? ""] ?? "客户端拒绝了该调用"}（${error.code}）`;
    }
  }
  return "操作失败：发生了未预期的问题";
}

/** A URL's origin, or nothing when the text is not an http(s) address at all. */
export function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function defaultNewId(): string {
  const source = globalThis.crypto;
  if (typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasContent(text: string): boolean {
  return text.trim() !== "";
}

interface ControllerInternals {
  readonly client: Client;
  readonly storage: SelectionStorage;
  readonly initialBinding: string | null;
  readonly newId: () => string;
  readonly now: () => number;
  /** Called with the origin before a connection attempt reads it. */
  readonly onTarget: (origin: string | null) => void;
}

function createController(internals: ControllerInternals): ShellController {
  const { client, storage, newId, now, onTarget } = internals;

  let state: ShellUiState = Object.freeze({
    bindingOrigin: internals.initialBinding,
    selection: storage.read(),
    creatingSession: false,
    startingRun: false,
    cancellingRunId: null,
    pluginPending: Object.freeze<Record<string, "enable" | "disable">>({}),
    notices: Object.freeze([]) as readonly Notice[],
    unknownWrites: Object.freeze([]) as readonly UnknownWrite[],
  });
  const listeners = new Set<() => void>();
  let nextNumber = 0;

  function set(partial: Partial<ShellUiState>): void {
    state = Object.freeze({ ...state, ...partial });
    for (const listener of [...listeners]) listener();
  }

  function addNotice(tone: Notice["tone"], text: string): void {
    nextNumber += 1;
    const notice: Notice = Object.freeze({ id: `notice-${nextNumber}`, tone, text });
    const notices = [...state.notices, notice];
    set({ notices: Object.freeze(notices.length > MAX_NOTICES ? notices.slice(notices.length - MAX_NOTICES) : notices) });
  }

  function recordUnknown(write: UnknownWrite): void {
    set({ unknownWrites: Object.freeze([...state.unknownWrites, write]) });
  }

  function unknownOf(id: string): UnknownWrite | undefined {
    return state.unknownWrites.find((write) => write.id === id);
  }

  function resolveUnknown(id: string): void {
    set({ unknownWrites: Object.freeze(state.unknownWrites.filter((write) => write.id !== id)) });
  }

  function newUnknownBase(hostInstanceId: string | null): UnknownWriteBase {
    nextNumber += 1;
    return {
      id: `unknown-${nextNumber}`,
      hostInstanceId,
      createdAt: now(),
    };
  }

  function setSelection(selection: SessionSelection | null): void {
    storage.write(selection);
    set({ selection });
  }

  /** Whether the answer may still be treated as belonging to the host that received the request. */
  function sameHost(instance: string | null): boolean {
    const current = describedHostInstance(client.getSnapshot());
    return current !== null && instance !== null && current === instance;
  }

  async function classifyWriteFailure(error: unknown, record: () => UnknownWrite, unconfirmed: string): Promise<void> {
    if (error instanceof ClientError && error.outcome === "unknown") {
      recordUnknown(record());
      addNotice("error", unconfirmed);
      return;
    }
    addNotice("error", explainError(error));
  }

  return {
    client,
    getState: (): ShellUiState => state,
    subscribe(listener: () => void): (() => void) {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },

    async connect(): Promise<void> {
      if (state.bindingOrigin === null) {
        addNotice("error", "尚未配置 Host 地址：请在上方填入后点击连接。");
        return;
      }
      onTarget(state.bindingOrigin);
      try {
        await client.connect();
      } catch (error) {
        addNotice("error", explainError(error));
      }
    },

    async connectTo(origin: string): Promise<void> {
      const normalized = normalizedOrigin(origin);
      if (normalized === null) {
        addNotice("error", `地址不是有效的 http(s) 源：${origin}`);
        return;
      }
      set({ bindingOrigin: normalized });
      onTarget(normalized);
      await this.connect();
    },

    async reconnect(): Promise<void> {
      if (state.bindingOrigin === null) {
        addNotice("error", "尚未配置 Host 地址。");
        return;
      }
      onTarget(state.bindingOrigin);
      try {
        await client.reconnect();
      } catch (error) {
        addNotice("error", explainError(error));
      }
    },

    disconnect(): void {
      client.disconnect();
    },

    async createSession(): Promise<void> {
      if (state.creatingSession) return;
      // The instance is captured before the call: an instance observed after a
      // failure is not evidence of where the request went.
      const instance = describedHostInstance(client.getSnapshot());
      // The selection the user had when the create started. A selection made
      // *while* the answer was in flight is theirs — the late answer must not
      // take it back, and with it the composer and the draft it holds.
      const selectionBefore = state.selection;
      set({ creatingSession: true });
      try {
        const { session } = await client.sessions.create();
        if (instance === null) return;
        if (state.selection === selectionBefore) {
          setSelection({ hostInstanceId: instance, sessionId: session.sessionId });
        } else {
          addNotice("info", "新会话已创建；你已切换到其他会话，未自动切换选择。");
        }
      } catch (error) {
        await classifyWriteFailure(
          error,
          () => ({ ...newUnknownBase(instance), kind: "create-session" }),
          "新建会话的结果未确认：会话可能已经创建。不会自动重试；请刷新后在列表中确认。",
        );
      } finally {
        set({ creatingSession: false });
      }
    },

    selectSession(sessionId: string): void {
      const instance = presentationHostInstance(client.getSnapshot());
      if (instance === null) return;
      setSelection({ hostInstanceId: instance, sessionId });
    },

    async startRun(sessionId: string, text: string): Promise<boolean> {
      if (state.startingRun) return false;
      if (!hasContent(text)) {
        addNotice("error", "输入不能为空。");
        return false;
      }
      const instance = describedHostInstance(client.getSnapshot());
      const submissionId = newId();
      set({ startingRun: true });
      try {
        await client.runs.start({ sessionId, submissionId, text });
        return true;
      } catch (error) {
        if (error instanceof ClientError && error.outcome === "unknown") {
          recordUnknown({ ...newUnknownBase(instance), kind: "start", sessionId, submissionId, text });
          addNotice("error", "提交结果未确认：可能已被接受并执行。不会自动重发；可在待确认面板中查询。");
          return true;
        }
        addNotice("error", explainError(error));
        return false;
      } finally {
        set({ startingRun: false });
      }
    },

    async cancelRun(runId: string): Promise<void> {
      if (state.cancellingRunId !== null) return;
      const instance = describedHostInstance(client.getSnapshot());
      set({ cancellingRunId: runId });
      try {
        await client.runs.cancel({ runId });
      } catch (error) {
        await classifyWriteFailure(
          error,
          () => ({ ...newUnknownBase(instance), kind: "cancel", runId }),
          "取消请求的结果未确认：运行可能仍在继续。可在待确认面板中查询其状态。",
        );
      } finally {
        set({ cancellingRunId: null });
      }
    },

    async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
      if (pluginPendingOf(state.pluginPending, pluginId) !== undefined) return;
      const instance = describedHostInstance(client.getSnapshot());
      const operation = enabled ? "enable" : "disable";
      set({ pluginPending: Object.freeze({ ...state.pluginPending, [pluginId]: operation }) });
      try {
        const params = { pluginId };
        if (enabled) {
          await client.plugins.enable(params);
        } else {
          await client.plugins.disable(params);
        }
      } catch (error) {
        await classifyWriteFailure(
          error,
          () => ({ ...newUnknownBase(instance), kind: "plugin", pluginId, operation }),
          "插件操作的结果未确认：插件状态可能已经改变。不会自动重试；请刷新后查看真实状态。",
        );
      } finally {
        const pluginPending = { ...state.pluginPending };
        delete pluginPending[pluginId];
        set({ pluginPending: Object.freeze(pluginPending) });
      }
    },

    async checkUnknown(unknownId: string): Promise<void> {
      const write = unknownOf(unknownId);
      if (write === undefined) return;

      if (write.kind === "create-session" || write.kind === "plugin") {
        await this.refresh();
        addNotice("info", "已刷新：请按当前状态确认该操作的真实结果，然后关闭提示。");
        return;
      }

      if (!sameHost(write.hostInstanceId)) {
        addNotice("error", "Host 已更换，无法确认该操作；不会在新 Host 上自动重跑。");
        return;
      }

      try {
        if (write.kind === "start") {
          const { run } = await client.runs.get({ submissionId: write.submissionId });
          resolveUnknown(write.id);
          addNotice("info", `已确认：这次提交已被 Host 接受（run ${run.runId}，状态 ${run.status}）。`);
        } else {
          const { run } = await client.runs.get({ runId: write.runId });
          resolveUnknown(write.id);
          addNotice(
            "info",
            run.cancelRequested
              ? `已确认：取消请求已被记录；运行当前状态为 ${run.status}。`
              : `已确认：运行当前状态为 ${run.status}，取消请求未被记录。`,
          );
        }
      } catch (error) {
        if (error instanceof ClientError && error.code === "RUN_NOT_FOUND" && write.kind === "start") {
          addNotice("info", "当前未找到这次提交：它可能没有被 Host 接受。结果仍待确认，可稍后再次查询。");
          return;
        }
        addNotice("error", explainError(error));
      }
    },

    async resubmitUnknownStart(unknownId: string): Promise<void> {
      const write = unknownOf(unknownId);
      if (write === undefined || write.kind !== "start") return;
      if (!sameHost(write.hostInstanceId)) {
        addNotice("error", "Host 已更换，不会重发这次提交。");
        return;
      }
      try {
        await client.runs.start({ sessionId: write.sessionId, submissionId: write.submissionId, text: write.text });
        resolveUnknown(write.id);
        addNotice("info", "已重新提交同一次提交：Host 的去重记录让它只会执行一次。");
      } catch (error) {
        if (error instanceof ClientError && error.code === "SUBMISSION_CONFLICT") {
          addNotice("error", "Host 报告该提交标识与不同内容冲突；这次提交的结果仍未确认。");
          return;
        }
        addNotice("error", explainError(error));
      }
    },

    async refresh(): Promise<void> {
      try {
        await client.resync();
      } catch (error) {
        addNotice("error", explainError(error));
      }
    },

    dismissUnknown(unknownId: string): void {
      resolveUnknown(unknownId);
    },

    dismissNotice(noticeId: string): void {
      set({ notices: Object.freeze(state.notices.filter((notice) => notice.id !== noticeId)) });
    },
  };
}

/** The real composition: this is `createShellControllerWith` plus a client of its own. */
export function createShellController(options: ComposedShellControllerOptions): ShellController {
  const target: { origin: string | null } = { origin: null };
  const client = createClient({
    connect: async (): Promise<ProtocolChannel> => {
      const origin = target.origin;
      if (origin === null) throw new Error("no host address is configured");
      return options.connector(origin);
    },
  });
  return createController({
    client,
    storage: options.storage,
    initialBinding: options.initialBinding,
    newId: options.newId ?? defaultNewId,
    now: options.now ?? Date.now,
    onTarget: (origin: string | null): void => {
      target.origin = origin;
    },
  });
}

/** The seam a test composes with: the same controller over any client. */
export function createShellControllerWith(
  client: Client,
  options: ShellControllerOptions & { readonly newId?: () => string; readonly now?: () => number },
): ShellController {
  return createController({
    client,
    storage: options.storage,
    initialBinding: options.initialBinding,
    newId: options.newId ?? defaultNewId,
    now: options.now ?? Date.now,
    onTarget: (): void => undefined,
  });
}
