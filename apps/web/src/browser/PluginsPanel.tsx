/**
 * The plugin rail: what the host registered, what state it is in, and the two
 * lifecycle operations the protocol actually has.
 *
 * The panel obeys the frozen vocabulary: an `error` plugin cannot be operated
 * on at all — the manager refuses — so no reset or retry button is invented
 * for it. While the host is busy with a run, the buttons are off because the
 * host would refuse the mutation anyway; the host still enforces it, this only
 * keeps the page from offering what will bounce.
 */

import type { ClientSnapshot } from "@every-dagent/client";

import { pluginFailureView } from "./presentation.js";
import type { ShellUiState } from "./controller.js";

export interface PluginsPanelProps {
  readonly snapshot: ClientSnapshot;
  readonly ui: ShellUiState;
  readonly canWrite: boolean;
  /** Any run in flight: the host admits no plugin mutation while one is. */
  readonly hostBusy: boolean;
  readonly onSetEnabled(pluginId: string, enabled: boolean): void;
}

export function PluginsPanel(props: PluginsPanelProps) {
  const plugins = props.snapshot.presentation?.plugins ?? [];
  const pending = props.ui.pluginPending;

  return (
    <section className="panel" data-testid="plugins-panel">
      <header className="panel__head">
        <h2>插件</h2>
      </header>
      {props.hostBusy && (
        <p className="panel__note" data-testid="plugins-busy">
          Host 正忙：运行期间不能启用或停用插件。
        </p>
      )}
      {plugins.length === 0 ? (
        <p className="empty" data-testid="plugins-empty">
          没有注册的插件。
        </p>
      ) : (
        <ul className="plugins">
          {plugins.map((plugin) => {
            const busy = pending[plugin.id] !== undefined;
            const transition = plugin.status === "enabling" || plugin.status === "disabling";
            const failed = plugin.status === "error";
            const blocked = !props.canWrite || props.hostBusy || busy;
            return (
              <li className="plugin" key={plugin.id} data-testid="plugin-item" data-plugin-id={plugin.id}>
                <div className="plugin__head">
                  <span className="plugin__name">{plugin.name}</span>
                  <span className={`chip chip--${plugin.status === "error" ? "error" : plugin.status === "enabled" ? "ok" : "neutral"}`} data-testid="plugin-status">
                    {plugin.status}
                  </span>
                </div>
                <p className="plugin__meta">
                  {plugin.id} · v{plugin.version}
                  {plugin.permissions.length > 0 ? ` · 权限：${plugin.permissions.join(", ")}` : ""}
                </p>
                {plugin.description !== undefined && <p className="plugin__desc">{plugin.description}</p>}
                {plugin.lastFailure !== undefined && (
                  <p className="plugin__failure" data-testid="plugin-failure">
                    {pluginFailureView(plugin.lastFailure)}
                  </p>
                )}
                <div className="plugin__row">
                  {failed ? (
                    <span className="plugin__note" data-testid="plugin-error-note">
                      处于错误状态，无法继续操作（没有自动重试或重置）。
                    </span>
                  ) : transition ? (
                    <span className="plugin__note">{plugin.status === "enabling" ? "启用中…" : "停用中…"}</span>
                  ) : plugin.status === "disabled" ? (
                    <button
                      type="button"
                      className="button button--small"
                      data-testid="plugin-enable"
                      data-plugin-id={plugin.id}
                      disabled={blocked}
                      onClick={() => props.onSetEnabled(plugin.id, true)}
                    >
                      {busy ? "启用中…" : "启用"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button button--small"
                      data-testid="plugin-disable"
                      data-plugin-id={plugin.id}
                      disabled={blocked}
                      onClick={() => props.onSetEnabled(plugin.id, false)}
                    >
                      {busy ? "停用中…" : "停用"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
