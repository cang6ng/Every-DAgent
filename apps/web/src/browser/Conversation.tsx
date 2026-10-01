/**
 * The conversation: what the client has loaded of committed history, then the
 * live run, and never the two mixed.
 *
 * History arrives a page at a time and is rendered exactly as recorded. What is
 * *not* loaded is shown as not loaded: a conversation that starts mid-history
 * says so, and a conversation whose committed high-water has moved past what has
 * been read says there is newer history rather than presenting a complete-looking
 * transcript. The active run is rendered *after* history and labelled as live:
 * its user text comes from the run itself, its text items are what the model has
 * streamed so far, and its tool items show the call with its result when one has
 * arrived. When the run settles the host publishes one atomic update, the draft
 * disappears, and the recorded turns appear as history once they are read — the
 * page never shows a draft that became history twice, because it renders the two
 * from different sources.
 */

import type { ActiveRunSnapshot, CanonicalItem, SessionSummary } from "@every-dagent/protocol";
import type { HistoryCoverage } from "@every-dagent/client";

import { shortId } from "./presentation.js";
import { ToolCallCard, ToolResultCard } from "./ToolCard.js";

export interface ConversationProps {
  readonly session: SessionSummary;
  readonly coverage: HistoryCoverage | null;
  readonly activeRun: ActiveRunSnapshot | null;
  readonly loading: boolean;
  onLoadOlder(): void;
  onLoadNewer(): void;
}

function CanonicalRow({ item }: { readonly item: CanonicalItem }) {
  switch (item.kind) {
    case "user":
      return (
        <li className="item">
          <div className="msg msg--user" data-testid="msg-user">
            <span className="msg__role">你</span>
            <p className="msg__text">{item.text}</p>
          </div>
        </li>
      );
    case "assistant":
      // A recorded assistant message may be empty — a step that only asked for
      // a tool. The tool cards say what happened; an empty bubble would not.
      if (item.text === "") return null;
      return (
        <li className="item">
          <div className="msg msg--assistant" data-testid="msg-assistant">
            <span className="msg__role">助手</span>
            <p className="msg__text">{item.text}</p>
          </div>
        </li>
      );
    case "tool-call":
      return (
        <li className="item">
          <ToolCallCard
            name={item.name}
            callId={item.callId}
            invocationId={item.invocationId}
            input={item.input}
            result={null}
            live={false}
          />
        </li>
      );
    case "tool-result":
      return (
        <li className="item">
          <ToolResultCard name={item.name} callId={item.callId} ok={item.ok} content={item.content} />
        </li>
      );
  }
}

export function Conversation(props: ConversationProps) {
  const { session, coverage, activeRun, loading } = props;
  const items = coverage?.items ?? [];
  const blockedReason =
    session.status !== "blocked"
      ? null
      : session.blockedReason === "unknown-execution"
        ? "该会话被 Host 标记为阻塞：上一次运行有开始标记但没有已提交的终态，无法确认是否已经产生副作用。历史仍可查看；不会被自动恢复执行。"
        : "该会话被 Host 标记为阻塞：Host 无法安全地记录其运行结果。历史仍可查看；不会被自动恢复执行。";
  const empty = items.length === 0 && activeRun === null;

  return (
    <section className="conversation" data-testid="conversation">
      {blockedReason !== null && (
        <p className="banner banner--error" data-testid="blocked-banner">
          {blockedReason}
        </p>
      )}
      {coverage === null && !loading && (
        <p className="empty" data-testid="history-unloaded">
          尚未读取该会话的历史。选择该会话时会自动读取最新一页。
        </p>
      )}
      {coverage !== null && !coverage.atStart && (
        <p className="banner" data-testid="history-older">
          <button
            type="button"
            className="button button--small"
            data-testid="load-older"
            disabled={loading || coverage.nextCursor === null}
            onClick={props.onLoadOlder}
          >
            {loading ? "读取中…" : "读取更早的记录"}
          </button>
          <span className="run-strip__note">
            最早的已加载位置为 seq {coverage.fromSeq}；更早的记录仍在 Host 上。
          </span>
        </p>
      )}
      {coverage !== null && coverage.behind && (
        <p className="banner" data-testid="history-newer">
          <button
            type="button"
            className="button button--small"
            data-testid="load-newer"
            disabled={loading}
            onClick={props.onLoadNewer}
          >
            {loading ? "读取中…" : "读取最新记录"}
          </button>
          <span className="run-strip__note">
            已加载到 seq {coverage.toSeq}，此后 Host 又提交了新的记录；这里不会用实时内容补齐。
          </span>
        </p>
      )}
      {empty ? (
        <p className="empty" data-testid="conversation-empty">
          还没有记录的消息。在下方输入内容开始一次运行。
        </p>
      ) : (
        <ol className="conversation__items">
          {items.map((item) => (
            <CanonicalRow key={item.id} item={item} />
          ))}
          {activeRun !== null && (
            <li className="item item--live" data-testid="live-run">
              <div className="msg msg--user" data-testid="msg-user">
                <span className="msg__role">你</span>
                <p className="msg__text">{activeRun.text}</p>
              </div>
              {/* `activeRunOf` only ever hands over accepted/running runs, whose
                  `live` is a timeline; the guard states that invariant where the
                  union type cannot prove it. */}
              {activeRun.live.map((item) =>
                item.kind === "text" ? (
                  <div className="msg msg--assistant msg--live" data-testid="live-text" key={item.itemId}>
                    <span className="msg__role">助手（生成中）</span>
                    <p className="msg__text">{item.text}</p>
                  </div>
                ) : (
                  <ToolCallCard
                    key={item.itemId}
                    name={item.name}
                    callId={item.callId}
                    invocationId={item.invocationId}
                    input={item.input}
                    result={item.result}
                    live
                  />
                ),
              )}
              {activeRun.liveTruncated && (
                <p className="run-strip__note" data-testid="live-truncated">
                  实时输出已达展示上限，之后的增量不再显示；运行结束后以已提交的历史为准。
                </p>
              )}
            </li>
          )}
        </ol>
      )}
      {coverage !== null && items.length > 0 && (
        <p className="conversation__foot">
          已加载 {items.length} 条记录（seq {coverage.fromSeq}–{coverage.toSeq}）· 会话{" "}
          {shortId(session.sessionId)}
        </p>
      )}
    </section>
  );
}
