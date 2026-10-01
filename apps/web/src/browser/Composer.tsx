/**
 * The composer: the draft, the send button, and the honest reasons it may be
 * off.
 *
 * The draft is the shell's own ephemeral state — the one thing that is purely
 * a page concern — so it lives in React. Sending is not optimistic beyond the
 * input itself: the text is cleared only when the submission actually left the
 * client (accepted, or its outcome is unknown), and kept for editing when it
 * definitely did not. There is no retry here: a submission that was sent is
 * never quietly sent again.
 */

import { useState } from "react";

export interface ComposerProps {
  readonly blocked: boolean;
  readonly canWrite: boolean;
  /** True while the host is already running something: start would be refused. */
  readonly atRunLimit: boolean;
  readonly startingRun: boolean;
  /** Resolves `true` when the submission left the client (accepted or unknown). */
  onSend(text: string): Promise<boolean>;
}

export function Composer(props: ComposerProps) {
  const [draft, setDraft] = useState("");

  const disabledReason = !props.canWrite
    ? "连接未就绪：暂不能提交。"
    : props.blocked
      ? "该会话已阻塞：不能继续运行。"
      : props.atRunLimit
        ? "Host 正忙：同一时间只执行一个运行，请等待当前运行结束。"
        : null;
  const sendable = disabledReason === null && !props.startingRun && draft.trim() !== "";

  async function submit(): Promise<void> {
    if (!sendable) return;
    const text = draft;
    const left = await props.onSend(text);
    // Clear the draft the submission was made of — and only that draft: text
    // typed while the call was in flight is the user's, not ours to discard.
    if (left) setDraft((current) => (current === text ? "" : current));
  }

  return (
    <form
      className="composer"
      data-testid="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        className="composer__input"
        data-testid="composer-input"
        value={draft}
        rows={3}
        placeholder={disabledReason ?? "输入消息，Ctrl+Enter 发送"}
        disabled={!props.canWrite || props.blocked}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer__row">
        <button type="submit" className="button button--primary" data-testid="send-button" disabled={!sendable}>
          {props.startingRun ? "提交中…" : "发送"}
        </button>
        <span className="composer__hint">
          提交后即交给 Host；取消请用运行栏按钮。断线不会取消运行，也不会自动重发提交。
        </span>
      </div>
    </form>
  );
}
