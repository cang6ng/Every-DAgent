/**
 * One tool, as a card — the same card for every tool there is.
 *
 * Nothing here knows a tool's name. The input is shown exactly as the host
 * projected it (complete JSON, or an honest "unavailable"), the result is shown
 * as text with its `ok` flag, and both are rendered as data: a tool's output is
 * never HTML, never script, and never parsed to decide whether the tool really
 * ran.
 */

import type { DisplayInput } from "@every-dagent/protocol";

import { displayInputView, shortId } from "./presentation.js";

export interface ToolResultBody {
  readonly ok: boolean;
  readonly content: string;
}

function ResultBody({ result }: { readonly result: ToolResultBody }) {
  return (
    <div className="tool__section">
      <span className="tool__label">
        结果 <span className={result.ok ? "badge badge--ok" : "badge badge--fail"}>{result.ok ? "ok" : "失败"}</span>
      </span>
      <pre className="tool__content" data-testid="tool-result-content">
        {result.content}
      </pre>
      {!result.ok && (
        <p className="tool__note">ok: false 表示这次调用没有得到成功的 observation；它不证明调用没有被派发。</p>
      )}
    </div>
  );
}

export interface ToolCallCardProps {
  readonly name: string;
  readonly callId: string;
  readonly invocationId: string;
  readonly input: DisplayInput;
  /** `null` while the call is still open. */
  readonly result: ToolResultBody | null;
  /** Live items label an open call as waiting; canonical calls simply have no result yet. */
  readonly live: boolean;
}

export function ToolCallCard(props: ToolCallCardProps) {
  const input = displayInputView(props.input);
  return (
    <article className="tool" data-testid="tool-card" data-tool-name={props.name}>
      <header className="tool__head">
        <span className="tool__name">{props.name}</span>
        <span className="tool__meta">
          callId {props.callId === "" ? "（空）" : props.callId} · {shortId(props.invocationId)}
        </span>
      </header>
      <div className="tool__section">
        <span className="tool__label">输入</span>
        <pre className="tool__json" data-testid={input.kind === "json" ? "tool-input-json" : "tool-input-unavailable"}>
          {input.text}
        </pre>
      </div>
      {props.result !== null ? (
        <ResultBody result={props.result} />
      ) : props.live ? (
        <p className="tool__pending" data-testid="tool-pending">
          等待结果…
        </p>
      ) : null}
    </article>
  );
}

export interface ToolResultCardProps {
  readonly name: string;
  readonly callId: string;
  readonly ok: boolean;
  readonly content: string;
}

/** A settled tool result from canonical history, as its own card. */
export function ToolResultCard(props: ToolResultCardProps) {
  return (
    <article className="tool tool--result" data-testid="tool-card" data-tool-name={props.name}>
      <header className="tool__head">
        <span className="tool__name">{props.name}</span>
        <span className="tool__meta">callId {props.callId === "" ? "（空）" : props.callId}</span>
      </header>
      <ResultBody result={{ ok: props.ok, content: props.content }} />
    </article>
  );
}
