/**
 * The session rail: the directory the host publishes, and the selection.
 *
 * There is no naming, no renaming and no deletion, because the protocol has
 * none — a session is an id, a creation time and a status, and the panel shows
 * exactly that. Selecting is local and cheap; it is remembered with the host
 * instance it belongs to, so a reconnect to a different host does not carry a
 * selection across.
 */

import type { ClientSnapshot } from "@every-dagent/client";
import type { SessionSnapshot } from "@every-dagent/protocol";

import { formatClock, shortId } from "./presentation.js";
import type { ShellUiState } from "./controller.js";

export interface SessionsPanelProps {
  readonly snapshot: ClientSnapshot;
  readonly ui: ShellUiState;
  readonly selected: SessionSnapshot | null;
  readonly canWrite: boolean;
  onCreate(): void;
  onSelect(sessionId: string): void;
}

export function SessionsPanel(props: SessionsPanelProps) {
  const sessions = props.snapshot.presentation?.sessions ?? [];

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
          没有会话。新建一个即可开始；Host 重启后这里会重新变空。
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
                  <span className="session__label">会话 {shortId(session.sessionId)}</span>
                  <span className="session__meta">
                    {formatClock(session.createdAt)}
                    {session.status === "blocked" ? " · 已阻塞" : ""}
                    {session.activeRunId !== null ? " · 运行中" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
