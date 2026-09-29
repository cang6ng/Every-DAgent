/**
 * The one coordination gate: tool execution and plugin tool-set mutation never
 * overlap on the shared registry.
 *
 * The mechanism is deliberately not a queue and not a lock library. There is
 * exactly one token; taking it is a single synchronous read-and-clear, so the
 * winner is decided by the JavaScript execution order itself rather than by a
 * check that some other task could slip past. Whoever fails to take the token
 * is told "busy" immediately — the frozen contract has no waiting, no FIFO and
 * no pre-emption.
 *
 * The token is not released by anything but the lease that took it, and a lease
 * is released exactly once. Losing that discipline is the one way this gate
 * could be wrong, which is why every acquisition site gets its lease back in a
 * `finally`, and why nothing outside this module may treat "not busy" as
 * something it can set.
 */

export type LeaseKind = "execution" | "mutation";

export interface Lease {
  readonly kind: LeaseKind;
  /** Returns the token. Idempotent: a second call is not a second token. */
  release(): void;
}

export interface RegistryGate {
  /**
   * Takes the registry token for one run or one plugin lifecycle operation.
   *
   * @returns the lease, or `undefined` when somebody else holds the token. This
   * decision is made in one synchronous step: there is no window between
   * "nothing is running" and "this operation owns the registry".
   */
  tryAcquire(kind: LeaseKind): Lease | undefined;
  readonly busy: boolean;
  /** Resolves when the token is free. Never resolves while a task holds it. */
  idle(): Promise<void>;
}

export function createRegistryGate(): RegistryGate {
  let available = true;
  const waiters = new Set<() => void>();

  return {
    tryAcquire(kind: LeaseKind): Lease | undefined {
      if (!available) return undefined;
      available = false;

      let released = false;
      return {
        kind,
        release(): void {
          if (released) return;
          released = true;
          available = true;

          // Waiters are collected before any of them runs: releasing the token
          // must not let one waiter's callback decide who wakes next.
          const pending = [...waiters];
          waiters.clear();
          for (const resolve of pending) resolve();
        },
      };
    },

    get busy(): boolean {
      return !available;
    },

    async idle(): Promise<void> {
      // A loop, not a single wait: an awakened caller re-checks the token
      // instead of assuming it is now its turn to hold one.
      while (!available) {
        await new Promise<void>((resolve) => {
          waiters.add(resolve);
        });
      }
    },
  };
}
