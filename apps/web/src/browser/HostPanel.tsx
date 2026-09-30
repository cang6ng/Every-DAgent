/**
 * Who this page is talking to, and what that host is willing to promise.
 *
 * The card repeats the host's own description — name, version, instance,
 * capabilities and limits — and states the one retention fact v1 has: nothing
 * is on disk, and a host restart takes the history with it. Saying that here is
 * what keeps the shell honest about a limitation the protocol itself declares.
 */

import type { ClientSnapshot } from "@every-dagent/client";

import { shortId } from "./presentation.js";

export interface HostPanelProps {
  readonly snapshot: ClientSnapshot;
}

export function HostPanel(props: HostPanelProps) {
  const description = props.snapshot.description;

  return (
    <section className="panel" data-testid="host-panel">
      <header className="panel__head">
        <h2>Host</h2>
      </header>
      {description === null ? (
        <p className="empty" data-testid="host-empty">
          还没有连接到任何 Host。
        </p>
      ) : (
        <>
          <p className="panel__detail">
            {description.host.name} v{description.host.version} · 协议 {description.protocolVersion}
          </p>
          <p className="panel__detail" data-testid="host-instance">
            实例 {shortId(description.hostInstanceId)}
          </p>
          <p className="panel__detail" data-testid="host-limits">
            并发运行上限 {description.limits.maxActiveRuns}
          </p>
          <p className="panel__detail" data-testid="host-capabilities">
            能力：
            {Object.entries(description.capabilities)
              .filter(([, supported]) => supported)
              .map(([name]) => name)
              .join(", ")}
          </p>
          <p className="panel__note">历史只保留在 Host 的内存中；Host 停止后会话与记录都会消失。</p>
        </>
      )}
    </section>
  );
}
