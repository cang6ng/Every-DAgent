/**
 * Execution context owned by the Runtime, never by the model.
 *
 * The LLM controls business parameters; the Runtime controls system context.
 * Identity (`userId`) and cancellation (`signal`) are therefore never tool
 * arguments — they are handed to `Tool.execute` by the runtime itself.
 */
export interface RuntimeContext {
  readonly sessionId: string;
  readonly userId?: string;
  readonly signal: AbortSignal;
}
