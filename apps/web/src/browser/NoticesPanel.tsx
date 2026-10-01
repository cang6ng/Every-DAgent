/**
 * Notices and the unconfirmed-write panel.
 *
 * The unconfirmed panel exists because the platform refuses to lie about
 * writes whose answers were lost: a submission that was sent is *possibly
 * executed*, and the shell keeps that possibility in front of the user until
 * it is either verified against the host or explicitly dismissed. Dismissing
 * removes the prompt and nothing else — it is not a claim that nothing
 * happened, and the copy says so. Re-sending is offered for one case only: the
 * same submission id, verbatim, which host dedup makes safe; it is never
 * automatic.
 */

import type { ClientSnapshot } from "@every-dagent/client";

import { formatClock, shortId } from "./presentation.js";
import type { ShellUiState, UnknownWrite } from "./controller.js";

export interface NoticesPanelProps {
  readonly ui: ShellUiState;
  readonly snapshot: ClientSnapshot;
  readonly canWrite: boolean;
  onCheck(unknownId: string): void;
  onResubmit(unknownId: string): void;
  onRefresh(): void;
  onDismiss(unknownId: string): void;
  onDismissNotice(noticeId: string): void;
}

const UNKNOWN_TEXT: Readonly<Record<UnknownWrite["kind"], string>> = Object.freeze({
  start: "一次提交的应答丢失：它可能已被接受并执行。不会自动重发。",
  cancel: "一次取消请求的应答丢失：对应的运行可能仍在继续。",
  "create-session": "一次新建会话的应答丢失：会话可能已经创建。",
  plugin: "一次插件操作的应答丢失：插件状态可能已经改变。",
});

/** A user-typed text, as a one-line preview for identification. */
function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= 24 ? collapsed : `${collapsed.slice(0, 24)}…`;
}

/**
 * What identifies one unconfirmed operation.
 *
 * The sentences above say what a lost answer *means*; this line says *which*
 * operation it was, in the ids the panels around it use — so two unconfirmed
 * submissions in different sessions, or a cancel for one particular run, can
 * be told apart before either is queried or dismissed.
 */
function correlationOf(write: UnknownWrite): string {
  const parts: string[] = [];
  switch (write.kind) {
    case "start":
      parts.push(`会话 ${shortId(write.sessionId)}`, `提交 ${shortId(write.submissionId)}`, `内容「${preview(write.text)}」`);
      break;
    case "cancel":
      parts.push(`运行 ${shortId(write.runId)}`);
      break;
    case "create-session":
      parts.push("新建的会话");
      break;
    case "plugin":
      parts.push(`插件 ${write.pluginId}`, write.operation === "enable" ? "启用" : "停用");
      break;
  }
  // Which host instance the request was aimed at: the one fact that decides
  // whether the record can still be checked over the current connection.
  if (write.hostInstanceId !== null) parts.push(`Host ${shortId(write.hostInstanceId)}`);
  parts.push(`记录于 ${formatClock(write.createdAt)}`);
  return parts.join(" · ");
}

export function NoticesPanel(props: NoticesPanelProps) {
  const { ui, snapshot } = props;
  const currentInstance = snapshot.description?.hostInstanceId ?? null;

  return (
    <div className="notices">
      {ui.unknownWrites.length > 0 && (
        <section className="notices__group" data-testid="unknown-panel">
          <h2 className="notices__title">待确认的操作</h2>
          <ul className="notices__list">
            {ui.unknownWrites.map((write) => {
              const sameHost = currentInstance !== null && currentInstance === write.hostInstanceId;
              return (
                <li className="notice notice--warn" key={write.id} data-testid="unknown-item" data-kind={write.kind}>
                  <p className="notice__text">
                    {UNKNOWN_TEXT[write.kind]}
                    {sameHost ? "" : "（Host 已更换，无法通过当前连接确认它。）"}
                  </p>
                  <p className="notice__meta" data-testid="unknown-meta">
                    {correlationOf(write)}
                  </p>
                  <div className="notice__row">
                    {write.kind === "start" || write.kind === "cancel" ? (
                      <button
                        type="button"
                        className="button button--small"
                        data-testid="unknown-check"
                        disabled={!sameHost || !props.canWrite}
                        onClick={() => props.onCheck(write.id)}
                      >
                        查询状态
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button button--small"
                        data-testid="unknown-refresh"
                        disabled={!props.canWrite}
                        onClick={props.onRefresh}
                      >
                        刷新状态
                      </button>
                    )}
                    {write.kind === "start" && (
                      <button
                        type="button"
                        className="button button--small"
                        data-testid="unknown-resubmit"
                        disabled={!sameHost || !props.canWrite}
                        title="重新发送同一次提交（相同的 submissionId 与内容）；Host 的去重保证只会执行一次。"
                        onClick={() => props.onResubmit(write.id)}
                      >
                        重新提交（同一次）
                      </button>
                    )}
                    <button
                      type="button"
                      className="button button--small"
                      data-testid="unknown-dismiss"
                      onClick={() => props.onDismiss(write.id)}
                    >
                      忽略提示
                    </button>
                  </div>
                  <p className="notice__hint">「忽略提示」只移除这条提醒，不代表该操作没有执行。</p>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {ui.notices.length > 0 && (
        <section className="notices__group" data-testid="notices">
          <ul className="notices__list">
            {ui.notices.map((notice) => (
              <li className={`notice notice--${notice.tone}`} key={notice.id} data-testid="notice-item">
                <p className="notice__text">{notice.text}</p>
                <button
                  type="button"
                  className="button button--small"
                  data-testid="notice-dismiss"
                  onClick={() => props.onDismissNotice(notice.id)}
                >
                  知道了
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
