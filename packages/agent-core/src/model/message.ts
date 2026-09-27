/**
 * Provider-neutral conversation content.
 *
 * These shapes are what the Core reasons about; mapping them onto a specific
 * provider's wire format is the ModelClient adapter's job. A provider that takes
 * tool results as their own role and one that folds them into the next user turn
 * are served by the same neutral `role: "tool"` — a distinction the Core must not
 * know about.
 */

/** A tool invocation requested by the model. */
export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

/** The outcome of one tool invocation, as fed back to the model. */
export interface ToolResult {
  readonly callId: string;
  readonly name: string;
  readonly ok: boolean;
  readonly content: string;
}

/**
 * The system prompt is deliberately absent: it travels on
 * `ModelRequest.systemPrompt`, not as a message, because it is not part of the
 * session log.
 */
export type ModelMessage =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "assistant"; readonly text: string; readonly toolCalls: readonly ToolCall[] }
  | { readonly role: "tool"; readonly results: readonly ToolResult[] };
