/**
 * What the shell derives from a client snapshot, as plain functions.
 *
 * Everything in this module is a pure read: it never asks a client for
 * anything, never changes a snapshot, and never assumes a fact the protocol did
 * not publish. The distinction the shell must keep is the one the platform
 * keeps — canonical history is what the host published, live items are what the
 * active run is showing, and a terminal run's draft is gone — so the two are
 * derived separately and never folded into one another here.
 */

import type { ClientSnapshot, PresentationHost } from "@every-dagent/client";
import type {
  DisplayInput,
  PluginFailureSummary,
  ProtocolError,
  RunSnapshot,
  SessionSnapshot,
} from "@every-dagent/protocol";

import type { SessionSelection } from "./selection.js";

/** The host instance that published the current presentation, if there is one. */
export function presentationHostInstance(snapshot: ClientSnapshot): string | null {
  return snapshot.presentation === null ? null : snapshot.presentation.hostInstanceId;
}

/** The host instance this connection described, if it has described one. */
export function describedHostInstance(snapshot: ClientSnapshot): string | null {
  return snapshot.description === null ? null : snapshot.description.hostInstanceId;
}

/**
 * The selected session, but only while the selection really belongs to the
 * presentation on screen. A selection from another host instance is not a
 * selection of anything.
 */
export function selectedSession(
  snapshot: ClientSnapshot,
  selection: SessionSelection | null,
): SessionSnapshot | null {
  if (selection === null) return null;
  const presentation = snapshot.presentation;
  if (presentation === null || presentation.hostInstanceId !== selection.hostInstanceId) return null;
  return presentation.sessions.find((session) => session.sessionId === selection.sessionId) ?? null;
}

/**
 * The session's active run, looked up by `activeRunId` — never guessed from the
 * order of the run directory. If the directory and the session disagree, this
 * returns nothing rather than inventing a run.
 */
export function activeRunOf(snapshot: ClientSnapshot, session: SessionSnapshot): RunSnapshot | null {
  if (session.activeRunId === null) return null;
  const run = snapshot.presentation?.runs.find((candidate) => candidate.runId === session.activeRunId);
  if (run === undefined || run.sessionId !== session.sessionId) return null;
  return run.status === "accepted" || run.status === "running" ? run : null;
}

/** The most recently accepted run of a session, terminal or not. */
export function latestRunOf(snapshot: ClientSnapshot, sessionId: string): RunSnapshot | null {
  const runs = snapshot.presentation?.runs ?? [];
  let latest: RunSnapshot | null = null;
  for (const run of runs) {
    if (run.sessionId === sessionId) latest = run;
  }
  return latest;
}

/** How many runs the host is currently executing, across all sessions. */
export function activeRunCount(snapshot: ClientSnapshot): number {
  const runs = snapshot.presentation?.runs ?? [];
  let count = 0;
  for (const run of runs) {
    if (run.status === "accepted" || run.status === "running") count += 1;
  }
  return count;
}

/**
 * The gate the shell puts on its own write buttons.
 *
 * It is deliberately stricter than the client's: a write is offered only while
 * the connection is ready, the presentation is not stale, and the presented
 * facts belong to the described host. The host still enforces everything it
 * enforces; this only keeps the UI from making offers it cannot honour.
 */
export function writesAllowed(snapshot: ClientSnapshot): boolean {
  return snapshot.status === "ready" && !snapshot.stale && snapshot.presentationHost === "current";
}

export interface StatusView {
  readonly label: string;
  readonly tone: "neutral" | "active" | "ok" | "warn" | "error";
  readonly detail: string | null;
}

const PRESENTATION_HOST_NOTES: Readonly<Record<PresentationHost, string | null>> = Object.freeze({
  none: null,
  unconfirmed: "展示的内容尚未确认属于当前 Host。",
  current: null,
  previous: "展示的是上一个 Host 的内容，仅供参考。",
});

/** The connection chip and its explanation. */
export function connectionView(snapshot: ClientSnapshot): StatusView {
  const hostNote = PRESENTATION_HOST_NOTES[snapshot.presentationHost];
  const errorNote =
    snapshot.error === null ? null : `${snapshot.error.message}（${snapshot.error.code}）`;
  const hostAndError = [errorNote, hostNote].filter((note) => note !== null).join(" ");

  // Every status that can still display a presentation says what that
  // presentation is. A "正在同步" chip above a panel full of the previous
  // host's sessions — or of the last synchronized ones — would otherwise read
  // as if those facts had just been confirmed against the current host.
  const staleNote = snapshot.stale ? "展示的是最后一次同步的内容。" : null;
  const carried = [hostAndError, staleNote].filter((part) => part !== null && part !== "").join(" ");
  const carriedOrNone = carried === "" ? null : carried;

  switch (snapshot.status) {
    case "disconnected":
      return { label: "未连接", tone: "neutral", detail: carriedOrNone };
    case "connecting":
      return { label: "正在连接", tone: "active", detail: carriedOrNone };
    case "connected":
      return { label: "已连接（未同步）", tone: "active", detail: carriedOrNone };
    case "syncing":
      return { label: "正在同步", tone: "active", detail: carriedOrNone };
    case "ready":
      return snapshot.stale
        ? {
            label: "已就绪（展示已过期）",
            tone: "warn",
            detail:
              hostNote === null
                ? "展示的是最后一次同步的内容；写操作已停用。"
                : `${hostNote} 展示的是最后一次同步的内容；写操作已停用。`,
          }
        : { label: "已就绪", tone: "ok", detail: null };
    case "lost":
      return {
        label: "连接已断开",
        tone: "warn",
        detail: `${hostAndError === "" ? "" : `${hostAndError} `}展示的是最后一次同步的内容；运行不会被自动取消。`,
      };
    case "protocol-error":
      return {
        label: "协议错误（已停止）",
        tone: "error",
        detail: `${hostAndError === "" ? "" : `${hostAndError} `}客户端已关闭该连接，不会自动无限重试。`,
      };
  }
}

const RUN_STATUS_VIEWS: Readonly<
  Record<RunSnapshot["status"], { readonly label: string; readonly tone: StatusView["tone"] }>
> = Object.freeze({
  accepted: { label: "已接受（等待开始）", tone: "active" },
  running: { label: "运行中", tone: "active" },
  completed: { label: "已完成", tone: "ok" },
  limited: { label: "达到步数上限", tone: "warn" },
  cancelled: { label: "已取消", tone: "warn" },
  failed: { label: "失败", tone: "error" },
});

export interface RunView {
  readonly status: RunSnapshot["status"];
  readonly label: string;
  readonly tone: StatusView["tone"];
  readonly error: ProtocolError | null;
  /** What the terminal state does *not* mean, phrased so it cannot sound like a rollback. */
  readonly note: string | null;
}

export function runView(run: RunSnapshot): RunView {
  const base = RUN_STATUS_VIEWS[run.status];
  let note: string | null = null;
  if (run.status === "limited") {
    note = "运行因达到最大步数而停止；这不是一次完整回答。";
  } else if (run.status === "cancelled") {
    note = "未记录的部分不会进入历史；已经执行过的工具不会因此回滚。";
  } else if (run.status === "failed") {
    note = "未记录的部分不会进入历史；已经执行过的工具不会因此回滚。";
  }
  return {
    status: run.status,
    label: base.label,
    tone: base.tone,
    error: run.status === "failed" ? run.error : null,
    note,
  };
}

export interface DisplayInputView {
  readonly kind: "json" | "unavailable";
  readonly text: string;
}

/** A tool input, as text a page can show without interpreting it. */
export function displayInputView(input: DisplayInput): DisplayInputView {
  if (input.kind === "json") {
    return { kind: "json", text: JSON.stringify(input.value, null, 2) ?? "null" };
  }
  return { kind: "unavailable", text: "该输入无法表示为 JSON（Host 标记为 unavailable）。" };
}

export function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** A short, display-only form of an opaque id. */
export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

/** The failure summary of a plugin, as a single sentence. */
export function pluginFailureView(failure: PluginFailureSummary): string {
  const cleanup =
    failure.cleanupFailureCount > 0 ? `；另有 ${failure.cleanupFailureCount} 项清理失败` : "";
  return `最近一次${failure.operation === "enable" ? "启用" : "停用"}在 ${failure.phase} 阶段失败（${failure.code}）${cleanup}：${failure.message}`;
}
