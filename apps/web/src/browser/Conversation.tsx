/**
 * The conversation: canonical history, then the live run, and never the two
 * mixed.
 *
 * History is what the host published — user, assistant, tool calls, tool
 * results — and it is rendered exactly as recorded. The active run is rendered
 * *after* history and labelled as live: its user text comes from the run
 * itself (the message is not in history until the run settles), its text items
 * are what the model has streamed so far, and its tool items show the call
 * with its result when one has arrived. When the run settles, the host
 * publishes one atomic update, the run disappears from the live area, and the
 * recorded part appears in history — the page never shows a draft that became
 * history twice, because it renders the two from different sources.
 */

import type { CanonicalItem, RunSnapshot, SessionSnapshot } from "@every-dagent/protocol";

import { shortId } from "./presentation.js";
import { ToolCallCard, ToolResultCard } from "./ToolCard.js";

export interface ConversationProps {
  readonly session: SessionSnapshot;
  readonly activeRun: RunSnapshot | null;
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
  const { session, activeRun } = props;
  const empty = session.canonical.length === 0 && activeRun === null;

  return (
    <section className="conversation" data-testid="conversation">
      {session.status === "blocked" && (
        <p className="banner banner--error" data-testid="blocked-banner">
          该会话被 Host 标记为阻塞：无法安全地继续或修复其中的运行。请创建一个新会话；已有的历史仍可查看。
        </p>
      )}
      {empty ? (
        <p className="empty" data-testid="conversation-empty">
          还没有记录的消息。在下方输入内容开始一次运行。
        </p>
      ) : (
        <ol className="conversation__items">
          {session.canonical.map((item) => (
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
              {activeRun.live !== null &&
                activeRun.live.map((item) =>
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
            </li>
          )}
        </ol>
      )}
      {session.canonical.length > 0 && (
        <p className="conversation__foot">
          共 {session.canonical.length} 条记录 · 会话 {shortId(session.sessionId)}
        </p>
      )}
    </section>
  );
}
