/**
 * The session rail: the bounded directory the host publishes, and the selection.
 *
 * A session is a title, a creation time, a last-changed time and a status, and
 * the panel shows exactly that — including how much of the directory it is
 * holding: a bounded window says so rather than looking like the whole
 * collection. Selecting is local and cheap; it is remembered with the host
 * instance it belongs to, so a reconnect to a different host does not carry a
 * selection across.
 */

import type { ClientSnapshot } from "@every-dagent/client";
import type { SessionSummary } from "@every-dagent/protocol";

import { formatClock, shortId } from "./presentation.js";
import type { ShellUiState } from "./controller.js";

export interface SessionsPanelProps {
  readonly snapshot: ClientSnapshot;
  readonly ui: ShellUiState;
  readonly selected: SessionSummary | null;
  readonly canWrite: boolean;
  readonly durable: boolean;
  onCreate(): void;
  onSelect(sessionId: string): void;
}

export function SessionsPanel(props: SessionsPanelProps) {
  const page = props.snapshot.presentation?.sessions;
  const sessions = page?.items ?? [];

  return (
    <section className="panel" data-testid="sessions-panel">
      <header className="panel__head">
        <h2>会话</h2>
        <button
          type="button"
          className="button button--small"
          data-testid="new-session"
          disabled={!props.canWrite || props.ui.creatingSession}
          onClick={props.onCreate}
        >
          {props.ui.creatingSession ? "创建中…" : "新建会话"}
        </button>
      </header>
      {sessions.length === 0 ? (
        <p className="empty" data-testid="sessions-empty">
          没有会话。新建一个即可开始。
        </p>
      ) : (
        <ul className="sessions">
          {sessions.map((session) => {
            const selected = props.selected !== null && props.selected.sessionId === session.sessionId;
            return (
              <li key={session.sessionId}>
                <button
                  type="button"
                  className={selected ? "session session--selected" : "session"}
                  data-testid="session-item"
                  data-session-id={session.sessionId}
                  data-selected={selected ? "true" : "false"}
                  onClick={() => props.onSelect(session.sessionId)}
                >
                  <span className="session__label">{session.title}</span>
                  <span className="session__meta">
                    {formatClock(session.updatedAt)}
                    {session.status === "blocked" ? " · 已阻塞" : ""}
                    {session.activeRunId !== null ? " · 运行中" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {page !== undefined && (page.hasMore || page.nextCursor !== null) && (
        <p className="panel__note" data-testid="sessions-window">
          仅显示最近的 {sessions.length} 个会话；更早的会话仍在 Host 上（
          {props.durable ? "durable 存储" : "本次进程内存中"}）。
        </p>
      )}
      {page !== undefined && !page.hasMore && page.nextCursor === null && (
        <p className="panel__note" data-testid="sessions-complete">
          共 {sessions.length} 个会话（{props.durable ? "durable 存储" : "本次进程内存中"}）。
        </p>
      )}
    </section>
  );
}

