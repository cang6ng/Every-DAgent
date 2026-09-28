/**
 * Rejection raised while another lifecycle operation for the same plugin is
 * still in flight. The manager never queues the request, so the caller must
 * await the in-flight operation and retry deliberately.
 */
export class PluginBusyError extends Error {
  constructor(pluginId: string) {
    super(`plugin "${pluginId}" is busy: another lifecycle operation is in progress`);
    this.name = "PluginBusyError";
  }
}

/**
 * Turns anything a plugin can throw into a message string.
 *
 * Cleanup keeps going even when a disposer throws something that cannot be
 * rendered, so a formatting failure returns the fallback instead of escaping
 * and cutting the remaining cleanup short.
 */
export function normalizeThrownValue(error: unknown): string {
  try {
    if (error instanceof Error) return error.message;
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof (error as { message?: unknown }).message === "string"
    ) {
      return (error as { message: string }).message;
    }
    return String(error);
  } catch {
    return "<unprintable thrown value>";
  }
}
