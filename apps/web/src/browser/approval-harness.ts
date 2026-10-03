/**
 * The minimal approval harness: a real client, in a real browser, answering a
 * real tool approval.
 *
 * M4 deliberately ships no rich approval UI — that is M5 — so this page is not
 * part of the shell. It is the smallest thing a browser can be that still
 * answers an approval *as a browser*: it connects with the shipped client, the
 * shipped client's typed handler renders the Host's snapshot into plain DOM,
 * and two buttons resolve it. Nothing here talks the protocol by hand, and
 * nothing here decides anything: a click is a decision, and what the Host did
 * with it arrives as the Host's own state.
 */

import { createClient } from "@every-dagent/client";
import type { ApprovalSnapshot, ToolApprovalResponse } from "@every-dagent/protocol";

import { connectHttpChannel } from "../client/http-channel.js";

const params = new URLSearchParams(location.search);
const binding = params.get("binding") ?? "";

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`the harness page has no #${id}`);
  return found;
}

function setText(id: string, text: string): void {
  element(id).textContent = text;
}

const client = createClient({
  connect: () => connectHttpChannel({ origin: binding }),
  client: { name: "approval-harness", version: "1.0.0" },
});

let pending: ((response: ToolApprovalResponse) => void) | undefined;
let current: ApprovalSnapshot | undefined;

function decide(decision: "approve" | "reject"): void {
  if (current === undefined || pending === undefined) return;
  setText("approval-status", decision === "approve" ? "sending-approve" : "sending-reject");
  const resolve = pending;
  pending = undefined;
  resolve({ approvalId: current.approvalId, executionId: current.executionId, decision });
}

client.registerToolApprovalHandler((snapshot, signal) => {
  current = snapshot;
  setText("approval-status", snapshot.status);
  setText("approval-name", snapshot.name);
  setText("approval-input", JSON.stringify(snapshot.input));
  element("approval-card").dataset["visible"] = "true";
  setText("reply-state", client.getSnapshot().approvalReply.state);
  return new Promise<ToolApprovalResponse>((resolve) => {
    pending = resolve;
    // A delivery the Host ended — reconnect, deadline, cancellation — stops
    // being answerable, and the card says so instead of keeping a live button.
    signal.addEventListener(
      "abort",
      () => {
        if (pending === resolve) pending = undefined;
        setText("approval-status", "delivery-closed");
      },
      { once: true },
    );
  });
});

/**
 * The last tool result the page saw while the run was live.
 *
 * A settled run has no timeline — the live map is emptied the moment its
 * terminal is durable — so the harness remembers what the card showed instead
 * of forgetting it the instant the run ends.
 */
let lastToolResult = "none";

function render(): void {
  const snapshot = client.getSnapshot();
  setText("connection-status", snapshot.status);
  setText("approval-can-respond", String(snapshot.approvalCanRespond));
  setText("reply-state", snapshot.approvalReply.state);
  const presentation = snapshot.presentation;
  setText("sessions", String(presentation?.sessions.items.length ?? 0));
  const active = snapshot.presentation?.runs.items.find(
    (run) => run.status === "accepted" || run.status === "running",
  );
  const latest = snapshot.presentation?.runs.items[0];
  setText("run-status", active?.status ?? latest?.status ?? "none");
  setText("live-items", String(Object.values(snapshot.live).flatMap((run) => run.live).length));
  const live = Object.values(snapshot.live).flatMap((run) => run.live);
  const tool = live.find((item) => item.kind === "tool");
  if (tool !== undefined && tool.kind === "tool") lastToolResult = JSON.stringify(tool.result);
  setText("tool-result", lastToolResult);
  if (presentation?.approval === null && element("approval-card").dataset["visible"] === "true") {
    setText("approval-status", snapshot.approvalReply.state === "closed" ? "closed" : "gone");
  }
}

client.subscribe(render);

element("approve").addEventListener("click", () => decide("approve"));
element("reject").addEventListener("click", () => decide("reject"));
element("reconnect").addEventListener("click", () => {
  void client.reconnect();
});
element("start").addEventListener("click", () => {
  void (async () => {
    element("approval-card").dataset["visible"] = "false";
    // The tool exists exactly while its plugin is enabled — and a step that
    // names a tool the registry does not have is refused before anything runs.
    await client.plugins.enable({ pluginId: "counter" });
    const session = await client.sessions.create();
    await client.runs.start({
      sessionId: session.session.sessionId,
      submissionId: `harness-${String(Date.now())}`,
      text: "计数",
    });
  })().catch((error: unknown) => {
    setText("run-status", `error: ${String(error)}`);
  });
});

void client
  .connect()
  .then(() => {
    setText("harness", "ready");
  })
  .catch((error: unknown) => {
    setText("harness", `error: ${String(error)}`);
  });
