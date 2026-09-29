/**
 * The reverse dispatcher's table.
 *
 * The production catalog is empty. A registration is what makes a reverse method
 * real, and the package index deliberately exports neither the table nor the
 * composition that fills it — so v1 can receive a host request, refuse it with
 * METHOD_NOT_FOUND, and answer nothing else.
 *
 * A registration carries a strict params contract of its own: the params arrive
 * as validated JSON, and `accepts` is the only thing standing between them and
 * the handler. An unknown method and a rejected payload are answered
 * differently, because they are different facts.
 */

import type { JsonValue, ProtocolError } from "@every-dagent/protocol";

/** What a handler is told about the request it is answering. */
export interface ReverseHandlerContext {
  readonly method: string;
  /** The host's own communication deadline; the local wait is bounded by it too. */
  readonly timeoutMs: number;
  readonly hostInstanceId: string;
  /**
   * Aborted when the host cancels or times out, when the stream the request
   * lived on is replaced or closed, and when the connection ends. A handler that
   * ignores it is a handler whose answer will simply never travel.
   */
  readonly signal: AbortSignal;
}

export type ReverseHandlerOutcome =
  | { readonly result: JsonValue }
  | { readonly error: ProtocolError };

export interface ReverseHandlerRegistration {
  readonly method: string;
  /** The strict contract for this method's params; `false` is answered INVALID_REQUEST. */
  readonly accepts: (params: JsonValue) => boolean;
  readonly handle: (
    params: JsonValue,
    context: ReverseHandlerContext,
  ) => ReverseHandlerOutcome | Promise<ReverseHandlerOutcome>;
}

export interface ReverseTable {
  readonly get: (method: string) => ReverseHandlerRegistration | undefined;
}

/** Configuration mistakes stop the client from existing, exactly like a host's. */
export function createReverseTable(
  registrations: readonly ReverseHandlerRegistration[],
): ReverseTable {
  const table = new Map<string, ReverseHandlerRegistration>();
  for (const registration of registrations) {
    if (registration.method.length === 0) {
      throw new Error("a reverse handler must name a method");
    }
    if (table.has(registration.method)) {
      throw new Error(`the reverse method "${registration.method}" is registered twice`);
    }
    table.set(registration.method, registration);
  }

  return { get: (method: string): ReverseHandlerRegistration | undefined => table.get(method) };
}
