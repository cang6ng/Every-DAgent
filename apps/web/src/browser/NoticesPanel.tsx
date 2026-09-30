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

import type { ShellUiState, UnknownWrite } from "./controller.js";

export interface NoticesPanelProps {
  readonly ui: ShellUiState;
  readonly snapshot: ClientSnapshot;
  readonly canWrite: boolean;
  readonly onCheck(unknownId: string): void;
  readonly onResubmit(unknownId: string): void;
  readonly onRefresh(): void;
  readonly onDismiss(unknownId: string): void;
  readonly onDismissNotice(noticeId: string): void;
}

const UNKNOWN_TEXT: Readonly<Record<UnknownWrite["kind"], string>> = Object.freeze({
  start: "一次提交的应答丢失：它可能已被接受并执行。不会自动重发。",
  cancel: "一次取消请求的应答丢失：对应的运行可能仍在继续。",
  "create-session": "一次新建会话的应答丢失：会话可能已经创建。",
  plugin: "一次插件操作的应答丢失：插件状态可能已经改变。",
});

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
