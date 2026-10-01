/**
 * The run strip: what the current (or last) run is, and the one control that
 * belongs to it.
 *
 * It says only what the snapshot says. While a run is active it offers cancel;
 * once cancel has been asked for it says so and stops offering it, because an
 * answered cancel request is not a stopped run — the only thing that shows a
 * run stopped is the host publishing a terminal state.
 */

import type { RunSummary } from "@every-dagent/protocol";

import { runView } from "./presentation.js";

export interface RunStripProps {
  readonly run: RunSummary;
  readonly cancelling: boolean;
  readonly canWrite: boolean;
  onCancel(runId: string): void;
}

export function RunStrip(props: RunStripProps) {
  const { run } = props;
  const view = runView(run);
  const active = run.status === "accepted" || run.status === "running";

  return (
    <div className={`run-strip run-strip--${view.tone}`} data-testid="run-strip">
      <span className={`chip chip--${view.tone}`} data-testid="run-status">
        {view.label}
      </span>
      {active && (
        <span className="run-strip__actions">
          {run.cancelRequested ? (
            <span className="run-strip__note" data-testid="cancel-requested">
              已请求取消，等待 Host 确认停止…
            </span>
          ) : (
            <button
              type="button"
              className="button button--warn"
              data-testid="cancel-button"
              disabled={!props.canWrite || props.cancelling}
              onClick={() => props.onCancel(run.runId)}
            >
              取消运行
            </button>
          )}
        </span>
      )}
      {view.note !== null && <span className="run-strip__note">{view.note}</span>}
      {view.error !== null && (
        <span className="run-strip__note" data-testid="run-error">
          {view.error.code}：{view.error.message}
        </span>
      )}
    </div>
  );
}
