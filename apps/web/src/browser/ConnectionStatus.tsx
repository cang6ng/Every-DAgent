/**
 * The connection chip in the header: one state, in plain words.
 *
 * It shows the client's own connection state and nothing else — no guessing at
 * liveness from whether the last request worked. The longer explanation lives
 * in the connection panel, next to the buttons that can change the state.
 */

import type { ClientSnapshot } from "@every-dagent/client";

import { connectionView } from "./presentation.js";

export function ConnectionStatus(props: { readonly snapshot: ClientSnapshot }) {
  const view = connectionView(props.snapshot);
  return (
    <div
      className={`chip chip--${view.tone}`}
      data-testid="connection-status"
      title={view.detail ?? undefined}
    >
      {view.label}
    </div>
  );
}
