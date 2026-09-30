/**
 * The connection panel: which host address this page talks to, and the three
 * lifecycle controls.
 *
 * The address is the one thing a user configures that is not part of the
 * protocol. It is stored in React state while typed and kept in the controller
 * once connected; while a connection exists it is locked, because a page that
 * could silently change its target under a running session is a page whose
 * buttons no longer mean what they say. Disconnecting never cancels a run —
 * the copy says so, because it is true and it is surprising.
 */

import { useEffect, useState } from "react";

import type { ClientSnapshot } from "@every-dagent/client";

import { connectionView } from "./presentation.js";
import type { ShellUiState } from "./controller.js";

export interface ConnectionPanelProps {
  readonly snapshot: ClientSnapshot;
  readonly ui: ShellUiState;
  readonly onConnectTo(origin: string): void;
  readonly onReconnect(): void;
  readonly onDisconnect(): void;
}

export function ConnectionPanel(props: ConnectionPanelProps) {
  const { snapshot, ui } = props;
  const [address, setAddress] = useState(ui.bindingOrigin ?? "");

  // A normalized origin (or one taken from the URL) flows back into the field;
  // typing itself never writes controller state.
  useEffect(() => {
    if (ui.bindingOrigin !== null) setAddress(ui.bindingOrigin);
  }, [ui.bindingOrigin]);

  const online =
    snapshot.status === "connecting" ||
    snapshot.status === "connected" ||
    snapshot.status === "syncing" ||
    snapshot.status === "ready";
  const canReconnect =
    snapshot.status === "ready" ||
    snapshot.status === "connected" ||
    snapshot.status === "lost" ||
    snapshot.status === "protocol-error";

  const view = connectionView(snapshot);

  return (
    <section className="panel" data-testid="connection-panel">
      <header className="panel__head">
        <h2>连接</h2>
      </header>
      <p className="panel__detail" data-testid="connection-detail">
        {view.detail ?? "页面只会连接到你在下面填写的 Host；不会自行创建或选择模型。"}
      </p>
      <label className="field">
        <span className="field__label">Host 地址</span>
        <input
          className="field__input"
          data-testid="binding-input"
          type="text"
          value={address}
          placeholder="http://127.0.0.1:PORT"
          disabled={online}
          onChange={(event) => {
            setAddress(event.target.value);
          }}
        />
      </label>
      <p className="panel__detail" data-testid="binding-origin">
        当前目标：{ui.bindingOrigin ?? "（未配置）"}
      </p>
      <div className="panel__row">
        <button
          type="button"
          className="button button--primary"
          data-testid="connect-button"
          disabled={online || address.trim() === ""}
          onClick={() => props.onConnectTo(address)}
        >
          连接
        </button>
        <button
          type="button"
          className="button"
          data-testid="reconnect-button"
          disabled={!canReconnect || ui.bindingOrigin === null}
          onClick={props.onReconnect}
        >
          重新连接
        </button>
        <button
          type="button"
          className="button"
          data-testid="disconnect-button"
          disabled={snapshot.status === "disconnected"}
          onClick={props.onDisconnect}
        >
          断开
        </button>
      </div>
      <p className="panel__note">断开连接不会取消正在运行的任务；结果以 Host 为准。</p>
    </section>
  );
}
