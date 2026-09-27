/**
 * Turns anything a caller can throw into a message string.
 *
 * The tool registry needs it to keep its "never throws at the caller" contract,
 * and the agent loop needs it to record a failure as `turn/end.error`. It lives on
 * its own so that neither module owns the other's error handling.
 */
export function errorMessageOf(error: unknown): string {
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
