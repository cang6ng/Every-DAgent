/**
 * The shell, assembled.
 *
 * Everything a panel shows is derived here, from the two stores, in one place:
 * the snapshot is read once, the derived facts (selected session, its loaded
 * history coverage, the live run, the latest run, whether writes are allowed)
 * are computed once, and the panels below take them as props. No panel holds a
 * second copy of a host fact; what the controller keeps is only what the user
 * did.
 */

import { useEffect } from "react";

import type { ShellController } from "./controller.js";
import { Composer } from "./Composer.js";
import { ConnectionPanel } from "./ConnectionPanel.js";
import { ConnectionStatus } from "./ConnectionStatus.js";
import { Conversation } from "./Conversation.js";
import { HostPanel } from "./HostPanel.js";
import { NoticesPanel } from "./NoticesPanel.js";
import { PluginsPanel } from "./PluginsPanel.js";
import { RunStrip } from "./RunStrip.js";
import { SessionsPanel } from "./SessionsPanel.js";
import { useClientSnapshot, useShellState } from "./use-shell.js";
import { activeRunCount, activeRunOf, historyOf, latestRunOf, selectedSession, writesAllowed } from "./presentation.js";

export interface AppProps {
  readonly controller: ShellController;
}

export function App(props: AppProps) {
  const { controller } = props;
  const snapshot = useClientSnapshot(controller.client);
  const ui = useShellState(controller);

  const session = selectedSession(snapshot, ui.selection);
  const sessionId = session === null ? null : session.sessionId;
  const coverage = sessionId === null ? null : historyOf(snapshot, sessionId);
  const activeRun = session === null ? null : activeRunOf(snapshot, session);
  const latestRun = session === null ? null : latestRunOf(snapshot, session.sessionId);
  const canWrite = writesAllowed(snapshot);
  const running = activeRunCount(snapshot);
  const maxActiveRuns = snapshot.description?.limits.maxActiveRuns ?? 1;
  const atRunLimit = running >= maxActiveRuns;
  const durable = snapshot.description?.storage.retention === "durable";
  const strip =
    activeRun ?? (latestRun !== null && latestRun.status !== "accepted" && latestRun.status !== "running" ? latestRun : null);

  const behind = coverage?.behind ?? false;
  const loadingHistory = ui.historyLoading;

  // Loading history is a read, and reads are safe: a session the user is looking
  // at should show what is on the host without them having to ask. The effect
  // re-runs when the selection changes or when the loaded coverage falls behind
  // the committed high-water.
  useEffect(() => {
    if (sessionId === null) return;
    if (snapshot.status !== "ready") return;
    if (session === null || session.status === "blocked") return;
    void controller.ensureHistory(sessionId);
  }, [controller, sessionId, snapshot.status, behind]);

  return (
    <div className="shell">
      <header className="shell__header">
        <div className="shell__brand">
          Every-DAgent <span className="shell__sub">generic web shell</span>
        </div>
        <ConnectionStatus snapshot={snapshot} />
      </header>

      <NoticesPanel
        ui={ui}
        snapshot={snapshot}
        canWrite={canWrite}
        onCheck={(unknownId) => {
          void controller.checkUnknown(unknownId);
        }}
        onResubmit={(unknownId) => {
          void controller.resubmitUnknownStart(unknownId);
        }}
        onRefresh={() => {
          void controller.refresh();
        }}
        onDismiss={(unknownId) => {
          controller.dismissUnknown(unknownId);
        }}
        onDismissNotice={(noticeId) => {
          controller.dismissNotice(noticeId);
        }}
      />

      <div className="shell__body">
        <aside className="shell__rail">
          <ConnectionPanel
            snapshot={snapshot}
            ui={ui}
            onConnectTo={(origin) => {
              void controller.connectTo(origin);
            }}
            onReconnect={() => {
              void controller.reconnect();
            }}
            onDisconnect={() => {
              controller.disconnect();
            }}
          />
          <SessionsPanel
            snapshot={snapshot}
            ui={ui}
            selected={session}
            canWrite={canWrite}
            durable={durable}
            onCreate={() => {
              void controller.createSession();
            }}
            onSelect={(sessionId) => {
              controller.selectSession(sessionId);
            }}
          />
        </aside>

        <main className="shell__main">
          {session === null ? (
            <p className="empty empty--main" data-testid="no-session">
              {snapshot.presentation === null
                ? "尚未从 Host 取得内容：连接成功后可以创建或选择会话。"
                : "请选择一个会话，或新建一个。"}
            </p>
          ) : (
            <>
              <Conversation
                session={session}
                coverage={coverage}
                activeRun={activeRun}
                loading={loadingHistory}
                onLoadOlder={() => {
                  void controller.loadOlderHistory(session.sessionId);
                }}
                onLoadNewer={() => {
                  void controller.reloadHistory(session.sessionId);
                }}
              />
              {strip !== null && (
                <RunStrip
                  run={strip}
                  cancelling={ui.cancellingRunId === strip.runId}
                  canWrite={canWrite}
                  onCancel={(runId) => {
                    void controller.cancelRun(runId);
                  }}
                />
              )}
              <Composer
                key={session.sessionId}
                blocked={session.status === "blocked"}
                canWrite={canWrite}
                atRunLimit={atRunLimit}
                startingRun={ui.startingRun}
                onSend={async (text) => await controller.startRun(session.sessionId, text)}
              />
            </>
          )}
        </main>

        <aside className="shell__rail">
          <HostPanel snapshot={snapshot} />
          <PluginsPanel
            snapshot={snapshot}
            ui={ui}
            canWrite={canWrite}
            hostBusy={running > 0}
            onSetEnabled={(pluginId, enabled) => {
              void controller.setPluginEnabled(pluginId, enabled);
            }}
          />
        </aside>
      </div>
    </div>
  );
}
