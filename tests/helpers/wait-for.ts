/**
 * Waiting, and nothing else.
 *
 * The acceptance fixture polls the client's own snapshot while it waits, so its
 * imports have to stay this small: a CLI that reached into a host composition
 * helper to wait would not be evidence of an independent client.
 */

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly what?: string;
}

/** Resolves once `predicate` holds, and refuses to wait forever. */
export async function waitFor(predicate: () => boolean, options: WaitOptions = {}): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 3000);
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.what ?? "the condition"}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}
