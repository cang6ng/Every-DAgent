/**
 * The two subscriptions the shell reads through.
 *
 * The client's snapshot is the presentation truth, and it is a *stable* object
 * between changes by contract, so it can be read through `useSyncExternalStore`
 * as-is — the same getter that compares with `Object.is` is the client's own.
 * The controller's state is the shell's own, and is subscribed to the same way.
 * The third argument is the same getter: this page is client-only, but the
 * shell is rendered under `renderToStaticMarkup` in tests, and a missing server
 * snapshot would make that impossible rather than wrong.
 */

import { useCallback, useSyncExternalStore } from "react";

import type { Client, ClientSnapshot } from "@every-dagent/client";

import type { ShellController, ShellUiState } from "./controller.js";

export function useClientSnapshot(client: Client): ClientSnapshot {
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useShellState(controller: ShellController): ShellUiState {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getSnapshot = useCallback(() => controller.getState(), [controller]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
