import type { Tool } from "@every-dagent/agent-core";

import { normalizeThrownValue } from "./errors.js";
import type { PluginDisposer, PluginStorage } from "./plugin.js";

const STALE_HANDLE = "plugin storage handle is no longer valid: its activation has ended";

/**
 * Everything one activation owns: staged tools, the registry disposers the
 * manager acquired for them, and the plugin's own cleanup callbacks.
 *
 * A scope belongs to a single transition out of `disabled`. Re-enabling never
 * reuses one, and cleanup runs at most once per scope.
 */
export interface ActivationScope {
  /** Closes both registration entry points; later calls throw. */
  seal(): void;
  stageTool(tool: Tool): void;
  registerDisposer(disposer: PluginDisposer): void;
  /** The staged tools in registration order, copied for preflight. */
  stagedTools(): readonly Tool[];
  ownRegistration(dispose: () => void): void;
  /** Binds a host view to this scope; the handle stops working when it ends. */
  bindStorage(view: PluginStorage): PluginStorage;
  /**
   * Releases everything this scope owns and resolves with the failures that
   * happened while doing so; it never rejects.
   */
  cleanup(): Promise<readonly string[]>;
}

export function createActivationScope(): ActivationScope {
  const staged: Tool[] = [];
  const registrations: Array<() => void> = [];
  const disposers: PluginDisposer[] = [];
  let sealed = false;
  let ended = false;
  let cleanupRun: Promise<readonly string[]> | undefined;

  /**
   * Each call re-checks the scope, so a handle kept by the plugin keeps working
   * for exactly as long as its own activation does.
   */
  function guarded<T>(operation: () => Promise<T>): Promise<T> {
    if (ended) {
      return Promise.reject(new Error(STALE_HANDLE));
    }
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async function runCleanup(): Promise<readonly string[]> {
    const errors: string[] = [];

    // Tool ownership first: the shared registry stops offering this plugin's
    // tools before plugin code releases its own resources.
    for (const dispose of [...registrations].reverse()) {
      try {
        dispose();
      } catch (error) {
        errors.push(normalizeThrownValue(error));
      }
    }

    // Then the plugin's own cleanup, newest first and one at a time: a plugin
    // that registered two disposers can rely on the second finishing before the
    // first starts. Storage stays usable throughout.
    for (const dispose of [...disposers].reverse()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(normalizeThrownValue(error));
      }
    }

    // Every attempt has been made, so the handle ends here even when some of
    // them failed: an error state is not a reason to keep capabilities alive.
    ended = true;

    return Object.freeze(errors);
  }

  return {
    seal() {
      sealed = true;
    },

    stageTool(tool) {
      if (sealed) {
        throw new Error("tools.register is sealed: this activation already finished");
      }
      staged.push(tool);
    },

    registerDisposer(disposer) {
      if (sealed) {
        throw new Error("onDispose is sealed: this activation already finished");
      }
      disposers.push(disposer);
    },

    stagedTools() {
      return [...staged];
    },

    ownRegistration(dispose) {
      registrations.push(dispose);
    },

    bindStorage(view) {
      return {
        get: (key) => guarded(() => view.get(key)),
        set: (key, value) => guarded(() => view.set(key, value)),
        delete: (key) => guarded(() => view.delete(key)),
      };
    },

    cleanup() {
      cleanupRun ??= runCleanup();
      return cleanupRun;
    },
  };
}
