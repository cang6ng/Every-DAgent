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
