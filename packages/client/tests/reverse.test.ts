/**
 * The reverse dispatcher.
 *
 * The client is where a host request either becomes work or becomes a refusal,
 * and the rules are narrow on purpose: an unknown method is answered
 * immediately, a payload that does not satisfy the registered profile never
 * reaches the handler, an answer travels only while its request is still
 * pending, and every scope that ends — timeout, cancellation, stream, connection
 * — ends the local handler with it.
 */

import { describe, expect, it, vi } from "vitest";

import type { JsonValue } from "@every-dagent/protocol";
import { decodeFrame, encodeFrame, validateMessage } from "@every-dagent/protocol";

import type { ReverseHandlerContext, ReverseHandlerOutcome, ReverseHandlerRegistration } from "../src/reverse.js";

import { createScenario, flush } from "./helpers/scenario.js";
import type { FakeHost } from "./helpers/fake-host.js";
import { sessionSnapshot } from "./helpers/values.js";

const SESSION = sessionSnapshot({ sessionId: "s-1" });

type Answer = (params: JsonValue, context: ReverseHandlerContext) => ReverseHandlerOutcome | Promise<ReverseHandlerOutcome>;

function strictObject(params: JsonValue): Record<string, JsonValue> | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const fields: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(params)) fields[key] = value;
  return Array.isArray(params) ? undefined : fields;
}

/** The strict test profile: exactly `{ value: string }` in, `{ echoed: string }` out. */
function echoHandler(options: { readonly answer?: Answer } = {}): ReverseHandlerRegistration {
  const answer: Answer = options.answer ?? ((params) => ({ result: { echoed: strictObject(params)?.["value"] ?? "" } }));
  return {
    method: "test.echo",
    accepts: (params: JsonValue): boolean => typeof strictObject(params)?.["value"] === "string",
    resultIsValid: (result: JsonValue): boolean => typeof strictObject(result)?.["echoed"] === "string",
    handle: (params: JsonValue, context: ReverseHandlerContext): ReturnType<Answer> => answer(params, context),
  };
}

function scenarioWith(handlers: readonly ReverseHandlerRegistration[]): ReturnType<typeof createScenario> {
  return createScenario({ internals: { reverseHandlers: handlers } });
}

interface HostRequestInput {
  readonly requestId: string;
  readonly method: string;
  readonly params: JsonValue;
  readonly streamId?: string;
  readonly hostInstanceId?: string;
  readonly timeoutMs?: number;
}

/** Sends one host request built and encoded by the protocol, as a real host would. */
function sendHostRequest(host: FakeHost, input: HostRequestInput): void {
  const candidate = {
    kind: "host-request",
    protocolVersion: "1",
    requestId: input.requestId,
    method: input.method,
    params: input.params,
    hostInstanceId: input.hostInstanceId ?? host.hostInstanceId,
    streamId: input.streamId ?? host.currentStreamId ?? "",
    timeoutMs: input.timeoutMs ?? 5000,
  };
  const validated = validateMessage({ kind: "host-request" }, candidate);
  if (!validated.success) throw new Error(`the fixture built an invalid host request: ${validated.failure.reason}`);
  const encoded = encodeFrame({ kind: "host-request" }, validated.output);
  if (!encoded.success) throw new Error("the fixture could not encode its host request");
  host.sendRaw(encoded.output);
}

/** The client's answers, decoded from the frames it sent. */
function clientAnswers(scenario: ReturnType<typeof createScenario>, requestId?: string): readonly Record<string, JsonValue>[] {
  return scenario.host.sent.flatMap((frame) => {
    const decoded = decodeFrame(frame);
    if (!decoded.success || decoded.output.kind !== "client-response") return [];
    const answer = decoded.output;
    if (requestId !== undefined && answer.requestId !== requestId) return [];
    const record: Record<string, JsonValue> = {
      requestId: answer.requestId,
      streamId: answer.streamId,
      hostInstanceId: answer.hostInstanceId,
    };
    if (answer.result !== undefined) record["result"] = answer.result;
    if (answer.error !== undefined) record["error"] = { code: answer.error.code, message: answer.error.message };
    return [record];
  });
}

describe("what the dispatcher answers", () => {
  it("refuses an unknown method immediately, without running anything", async () => {
    const scenario = scenarioWith([]);
    await scenario.ready();

    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.unknown", params: {} });

    const [answer] = clientAnswers(scenario, "h-1");
    expect(answer?.["error"]).toMatchObject({ code: "METHOD_NOT_FOUND" });
    expect(answer?.["result"]).toBeUndefined();
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });

  it("refuses params that do not satisfy the registered profile", async () => {
    const scenario = scenarioWith([echoHandler()]);
    await scenario.ready();

    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: 42 } });

    expect(clientAnswers(scenario, "h-1")[0]?.["error"]).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("answers a handled request with the handler's result, on the request's stream", async () => {
    const scenario = scenarioWith([echoHandler()]);
    await scenario.ready();
    const streamId = scenario.host.currentStreamId;

    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await flush();

    const [answer] = clientAnswers(scenario, "h-1");
    expect(answer?.["result"]).toEqual({ echoed: "hello" });
    expect(answer?.["streamId"]).toBe(streamId);
    expect(answer?.["hostInstanceId"]).toBe(scenario.host.hostInstanceId);
  });

  it("answers a failed handler with a safe internal error", async () => {
    const scenario = scenarioWith([
      echoHandler({
        answer: () => {
          throw new Error("the handler exploded: super-secret-token");
        },
      }),
    ]);
    await scenario.ready();

    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await flush();

    const answer = clientAnswers(scenario, "h-1")[0];
    expect(answer?.["error"]).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(JSON.stringify(answer)).not.toContain("super-secret-token");
  });

  it("refuses a result the wire cannot carry", async () => {
    const scenario = scenarioWith([echoHandler({ answer: () => ({ result: { echoed: Number.NaN } }) })]);
    await scenario.ready();

    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await flush();

    expect(clientAnswers(scenario, "h-1")[0]?.["error"]).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("does not wait for a handler before reading the frames behind it", async () => {
    let release: (() => void) | undefined;
    const scenario = scenarioWith([
      echoHandler({
        answer: () =>
          new Promise<ReverseHandlerOutcome>((resolve) => {
            release = () => {
              resolve({ result: { echoed: "eventually" } });
            };
          }),
      }),
    ]);
    await scenario.ready();

    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "slow" } });

    // A frame behind the request is processed while the handler is still open:
    // the fold has already happened, and no answer has travelled.
    scenario.host.emit({ type: "session.created", session: SESSION });
    expect(scenario.client.getSnapshot().presentation?.sessions).toHaveLength(1);

    await flush();
    expect(clientAnswers(scenario, "h-1")).toHaveLength(0);

    release?.();
    await flush();

    expect(clientAnswers(scenario, "h-1")[0]?.["result"]).toEqual({ echoed: "eventually" });
  });
});

describe("what the dispatcher refuses", () => {
  it("ends the connection when a request id is reused", async () => {
    const scenario = scenarioWith([
      echoHandler({ answer: () => new Promise<ReverseHandlerOutcome>(() => undefined) }),
    ]);
    await scenario.ready();

    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "one" } });
    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "two" } });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
    expect(scenario.client.getSnapshot().error?.reason).toBe("duplicate-request-id");
  });

  it("ends the connection when the request names another instance", async () => {
    const scenario = scenarioWith([echoHandler()]);
    await scenario.ready();

    sendHostRequest(scenario.host, {
      requestId: "h-1",
      method: "test.echo",
      params: { value: "hello" },
      hostInstanceId: "somewhere-else",
    });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
    expect(clientAnswers(scenario, "h-1")).toHaveLength(0);
  });

  it("ends the connection when a host that denies the capability asks anyway", async () => {
    const scenario = createScenario({
      host: { capabilities: { reverseRequests: false } },
      internals: { reverseHandlers: [echoHandler()] },
    });
    await scenario.ready();

    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
    expect(scenario.client.getSnapshot().error?.reason).toBe("capability-violation");
  });

  it("drops a request that arrives for a stream it no longer holds", async () => {
    const scenario = scenarioWith([echoHandler()]);
    await scenario.ready();
    const host = scenario.host;
    const streamId = host.currentStreamId;

    const closing = scenario.client.closeSubscription();
    host.respond(host.requestIdOf("subscriptions.close") ?? "", "subscriptions.close", { closed: true });
    await closing;

    sendHostRequest(host, { requestId: "h-1", method: "test.echo", params: { value: "hello" }, streamId: streamId ?? "" });

    expect(clientAnswers(scenario, "h-1")).toHaveLength(0);
    expect(scenario.client.getSnapshot().status).toBe("connected");
  });
});

describe("ending a handler", () => {
  it("aborts the local handler when the host cancels, and answers nothing", async () => {
    const signals: AbortSignal[] = [];
    const scenario = scenarioWith([
      echoHandler({
        answer: (_params, context) => {
          signals.push(context.signal);
          return new Promise<ReverseHandlerOutcome>((resolve) => {
            context.signal.addEventListener("abort", () => {
              resolve({ result: { echoed: "too late" } });
            });
          });
        },
      }),
    ]);
    await scenario.ready();

    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await flush();

    scenario.host.emit({ type: "host.request.cancelled", requestId: "h-1", reason: "cancelled" });
    await flush();

    expect(signals[0]?.aborted).toBe(true);
    expect(clientAnswers(scenario, "h-1")).toHaveLength(0);
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });

  it("drops the answer when the local wait runs out first", async () => {
    let resolveLate: (() => void) | undefined;
    const scenario = scenarioWith([
      echoHandler({
        answer: () =>
          new Promise<ReverseHandlerOutcome>((resolve) => {
            resolveLate = () => {
              resolve({ result: { echoed: "late" } });
            };
          }),
      }),
    ]);
    await scenario.ready();

    sendHostRequest(scenario.host, {
      requestId: "h-1",
      method: "test.echo",
      params: { value: "hello" },
      timeoutMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    resolveLate?.();
    await flush();

    expect(clientAnswers(scenario, "h-1")).toHaveLength(0);
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });

  it("aborts the handler when the stream is replaced", async () => {
    const signals: AbortSignal[] = [];
    const scenario = scenarioWith([
      echoHandler({
        answer: (_params, context) => {
          signals.push(context.signal);
          return new Promise<ReverseHandlerOutcome>(() => undefined);
        },
      }),
    ]);
    await scenario.ready();

    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await flush();

    await scenario.client.resync();

    expect(signals[0]?.aborted).toBe(true);
  });

  it("aborts the handler when the connection ends", async () => {
    const signals: AbortSignal[] = [];
    const scenario = scenarioWith([
      echoHandler({
        answer: (_params, context) => {
          signals.push(context.signal);
          return new Promise<ReverseHandlerOutcome>(() => undefined);
        },
      }),
    ]);
    await scenario.ready();

    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await flush();

    scenario.client.disconnect();

    expect(signals[0]?.aborted).toBe(true);
  });
});

/**
 * An abort listener is foreign code, and the client has already moved on by the
 * time it runs.
 *
 * Aborting a handler is part of a transition — a cancellation being read, a
 * stream being cut, a connection being retired — and a listener is free to
 * re-enter this client from there. Whatever the transition was doing afterwards
 * belongs to a stream, a status and a lifecycle that the listener may just have
 * replaced.
 */
describe("an abort listener is foreign code", () => {
  it("cannot write the old frame's position over the stream a resync installed", async () => {
    let nested: Promise<unknown> | undefined;
    const scenario = scenarioWith([
      echoHandler({
        answer: (_params, context) => {
          context.signal.addEventListener("abort", () => {
            nested = scenario.client.resync().catch((error: unknown) => error);
          });
          return new Promise<ReverseHandlerOutcome>(() => undefined);
        },
      }),
    ]);
    await scenario.ready();
    const host = scenario.host;
    const oldStream = host.currentStreamId;
    sendHostRequest(host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await flush();

    // The cancellation aborts the handler, the abort listener re-cuts the
    // subscription, and the cut completes before the event that caused it has
    // finished being read.
    host.emit({ type: "host.request.cancelled", requestId: "h-1", reason: "cancelled" });
    await nested;
    await flush();

    // The cancelled frame belonged to the stream the client just ended: it is
    // read and dropped, and its position is not written over the new stream's.
    expect(host.currentStreamId).not.toBe(oldStream);
    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(scenario.client.getSnapshot().presentation?.watermark).toEqual({
      streamId: host.currentStreamId,
      sequence: 0,
    });

    // And the new stream is positioned where it actually is: the next frame the
    // host sends on it is applied as the first one.
    host.emit({ type: "session.created", session: SESSION });
    expect(scenario.client.getSnapshot().presentation?.watermark.sequence).toBe(1);
    expect(scenario.client.getSnapshot().presentation?.sessions).toHaveLength(1);
  });

  for (const operation of ["resync", "close"] as const) {
    it(`never reads a ready client after ${operation} revoked the stream it lives on`, async () => {
      const observed: { readonly status: string; readonly stale: boolean }[] = [];
      const scenario = scenarioWith([
        echoHandler({
          answer: (_params, context) => {
            context.signal.addEventListener("abort", () => {
              const snapshot = scenario.client.getSnapshot();
              observed.push({ status: snapshot.status, stale: snapshot.stale });
            });
            return new Promise<ReverseHandlerOutcome>(() => undefined);
          },
        }),
      ]);
      await scenario.ready();
      sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
      await flush();

      const settling =
        operation === "resync" ? scenario.client.resync() : scenario.client.closeSubscription();
      if (operation === "close") {
        scenario.host.respond(scenario.host.requestIdOf("subscriptions.close") ?? "", "subscriptions.close", {
          closed: true,
        });
      }
      await settling;

      // The stream is dropped and the status that describes it is replaced in one
      // step, before this listener runs: an observer never reads `ready` at a
      // moment when there is nothing left to be ready about.
      expect(observed).toEqual([{ status: operation === "resync" ? "syncing" : "connected", stale: true }]);
    });
  }

  it("does not install a handler for a request whose stream was cut while its params were read", async () => {
    let nested: Promise<unknown> | undefined;
    const scenario = scenarioWith([
      {
        method: "test.echo",
        // The params contract is foreign code too, and this one re-cuts the
        // subscription before the dispatcher has decided anything.
        accepts: (): boolean => {
          nested = scenario.client.resync().catch((error: unknown) => error);
          return true;
        },
        resultIsValid: (result: JsonValue): boolean => typeof strictObject(result)?.["echoed"] === "string",
        handle: (): ReverseHandlerOutcome => ({ result: { echoed: "old-stream" } }),
      },
    ]);
    await scenario.ready();
    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await nested;
    await flush();

    // The request arrived on the stream that the re-cut just ended: no handler is
    // installed for it, and nothing is answered on a stream that is already over.
    expect(clientAnswers(scenario, "h-1")).toHaveLength(0);
    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(scenario.host.currentStreamId).toBeDefined();
  });

  it("a disconnection it makes while the connection is being retired stands", async () => {
    let disconnects = 0;
    const scenario = scenarioWith([
      echoHandler({
        answer: (_params, context) => {
          context.signal.addEventListener("abort", () => {
            disconnects += 1;
            scenario.client.disconnect();
          });
          return new Promise<ReverseHandlerOutcome>(() => undefined);
        },
      }),
    ]);
    await scenario.ready();
    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await flush();

    scenario.host.close();

    // The abort runs inside the retirement, and the disconnection it asked for is
    // the newer fact about this client: the loss cleanup that started the
    // retirement does not get to replace it with "lost".
    expect(disconnects).toBe(1);
    expect(scenario.client.getSnapshot().status).toBe("disconnected");
  });
});

/**
 * The params contract is the first foreign code the dispatcher runs, and the
 * last thing before it answers or installs anything.
 *
 * `accepts` may refuse the payload, and it may re-enter this client — a `resync`
 * or a `closeSubscription` from inside it is legal. A verdict on a request whose
 * stream is gone by the time the verdict is known is a verdict on nothing: no
 * answer travels, and no handler is installed, for either outcome.
 */
describe("the params contract is foreign code too", () => {
  it("a refusal cannot answer the stream its own contract just re-cut", async () => {
    const dispatched: string[] = [];
    let nested: Promise<unknown> | undefined;
    const scenario = scenarioWith([
      {
        method: "test.echo",
        accepts: (): boolean => {
          nested = scenario.client.resync().catch((error: unknown) => error);
          return false;
        },
        resultIsValid: (result: JsonValue): boolean => typeof strictObject(result)?.["echoed"] === "string",
        handle: (): ReverseHandlerOutcome => {
          dispatched.push("ran");
          return { result: { echoed: "old-stream" } };
        },
      },
    ]);
    await scenario.ready();
    const host = scenario.host;
    const oldStream = host.currentStreamId;
    sendHostRequest(host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await nested;
    await flush();

    // The refusal belongs to a stream the contract itself ended: it travels
    // nowhere, and no handler is installed for the request.
    expect(host.currentStreamId).not.toBe(oldStream);
    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(clientAnswers(scenario, "h-1")).toHaveLength(0);
    expect(dispatched).toHaveLength(0);

    // The stream that replaced it is healthy and still positioned at its start.
    host.emit({ type: "session.created", session: SESSION });
    expect(scenario.client.getSnapshot().presentation?.watermark.sequence).toBe(1);
  });

  it("a refusal cannot answer the stream its own contract just closed", async () => {
    const dispatched: string[] = [];
    let closing: Promise<unknown> | undefined;
    const scenario = scenarioWith([
      {
        method: "test.echo",
        accepts: (): boolean => {
          closing = scenario.client.closeSubscription().catch((error: unknown) => error);
          return false;
        },
        resultIsValid: (result: JsonValue): boolean => typeof strictObject(result)?.["echoed"] === "string",
        handle: (): ReverseHandlerOutcome => {
          dispatched.push("ran");
          return { result: { echoed: "old-stream" } };
        },
      },
    ]);
    await scenario.ready();
    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await flush();

    // The stream the request arrived on is already invalidated, and the refusal
    // is not sent to it: the only frame the host hears about this is the close
    // the contract asked for.
    expect(scenario.client.getSnapshot().status).toBe("connected");
    expect(scenario.client.getSnapshot().stale).toBe(true);
    expect(clientAnswers(scenario, "h-1")).toHaveLength(0);
    expect(dispatched).toHaveLength(0);

    scenario.host.respond(scenario.host.requestIdOf("subscriptions.close") ?? "", "subscriptions.close", {
      closed: true,
    });
    await closing;
  });

  it("a contract that throws cannot answer the stream it just re-cut", async () => {
    const dispatched: string[] = [];
    let nested: Promise<unknown> | undefined;
    const scenario = scenarioWith([
      {
        method: "test.echo",
        accepts: (): boolean => {
          nested = scenario.client.resync().catch((error: unknown) => error);
          throw new Error("the params contract blew up");
        },
        resultIsValid: (result: JsonValue): boolean => typeof strictObject(result)?.["echoed"] === "string",
        handle: (): ReverseHandlerOutcome => {
          dispatched.push("ran");
          return { result: { echoed: "old-stream" } };
        },
      },
    ]);
    await scenario.ready();
    const host = scenario.host;
    sendHostRequest(host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await nested;
    await flush();

    // Nor does a contract that fails to run get a say about a stream it took
    // away itself: the frame is delivered, the request is dropped with it.
    expect(clientAnswers(scenario, "h-1")).toHaveLength(0);
    expect(dispatched).toHaveLength(0);

    host.emit({ type: "session.created", session: SESSION });
    expect(scenario.client.getSnapshot().presentation?.watermark.sequence).toBe(1);
  });

  it("a contract that throws while its stream still stands is answered as a failure", async () => {
    const dispatched: string[] = [];
    const scenario = scenarioWith([
      {
        method: "test.echo",
        accepts: (): boolean => {
          throw new Error("the params contract blew up");
        },
        resultIsValid: (result: JsonValue): boolean => typeof strictObject(result)?.["echoed"] === "string",
        handle: (): ReverseHandlerOutcome => {
          dispatched.push("ran");
          return { result: { echoed: "old-stream" } };
        },
      },
    ]);
    await scenario.ready();
    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await flush();

    // A registration that cannot judge a payload is this client's failure, and
    // the host is told so rather than being blamed for its params — while the
    // request itself is never dispatched.
    const [answer] = clientAnswers(scenario, "h-1");
    expect(answer?.["error"]).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(answer?.["result"]).toBeUndefined();
    expect(dispatched).toHaveLength(0);
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });
});

describe("the registration table", () => {
  it("refuses two handlers for the same method", () => {
    expect(() => scenarioWith([echoHandler(), echoHandler()])).toThrowError(/registered twice/);
  });

  it("refuses a handler without a method", () => {
    expect(() => scenarioWith([{ ...echoHandler(), method: "" }])).toThrowError(/must name a method/);
  });

  it("refuses a handler that declares no contracts", () => {
    const bare = { method: "test.bare", handle: () => ({ result: {} }) };
    expect(() =>
      scenarioWith([bare as unknown as ReturnType<typeof echoHandler>]),
    ).toThrowError(/must declare its params and result contracts/);
  });
});

describe("a handler belongs to the connection it arrived on", () => {
  /** Releases the pending handler at `index`, once it exists. */
  function releasing(): { readonly answers: ((value: ReverseHandlerOutcome) => void)[] } {
    return { answers: [] };
  }

  it("cannot answer a request that arrived on a later connection", async () => {
    const control = releasing();
    const scenario = createScenario({
      internals: {
        reverseHandlers: [
          {
            method: "test.echo",
            accepts: () => true,
            resultIsValid: (result: JsonValue): boolean => typeof strictObject(result)?.["echoed"] === "string",
            handle: () =>
              new Promise<ReverseHandlerOutcome>((resolve) => {
                control.answers.push(resolve);
              }),
          },
        ],
      },
    });
    await scenario.ready();

    const first = scenario.host;
    sendHostRequest(first, { requestId: "h-reused", method: "test.echo", params: { value: "old" } });
    await flush();

    // A new connection, and the same request id: hosts number their own
    // requests, and a new connection starts that count again.
    await scenario.client.reconnect();
    const current = scenario.host;
    sendHostRequest(current, { requestId: "h-reused", method: "test.echo", params: { value: "new" } });
    await flush();

    control.answers[0]?.({ result: { echoed: "OLD-EPOCH" } });
    await flush();
    expect(clientAnswers(scenario, "h-reused")).toHaveLength(0);

    control.answers[1]?.({ result: { echoed: "NEW-EPOCH" } });
    await flush();
    const answers = clientAnswers(scenario, "h-reused");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.["result"]).toEqual({ echoed: "NEW-EPOCH" });
  });

  it("cannot end a later connection's request when its own deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const scenario = createScenario({
        internals: {
          reverseHandlers: [
            {
              method: "test.echo",
              accepts: () => true,
              resultIsValid: (result: JsonValue): boolean => typeof strictObject(result)?.["echoed"] === "string",
              handle: (_params, context) => {
                signals.push(context.signal);
                return new Promise<ReverseHandlerOutcome>(() => undefined);
              },
            },
          ],
        },
      });
      await scenario.ready();

      sendHostRequest(scenario.host, {
        requestId: "h-reused",
        method: "test.echo",
        params: { value: "old" },
        timeoutMs: 50,
      });
      await Promise.resolve();

      await scenario.client.reconnect();
      sendHostRequest(scenario.host, {
        requestId: "h-reused",
        method: "test.echo",
        params: { value: "new" },
        timeoutMs: 500,
      });
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(100);

      // The old deadline fired and ended its own handler; the new one is still
      // waiting, and nothing was answered.
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      expect(clientAnswers(scenario, "h-reused")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a result that is valid JSON but not this method's contract", async () => {
    const scenario = scenarioWith([
      echoHandler({ answer: () => ({ result: { echoed: 42 } }) }),
    ]);
    await scenario.ready();

    sendHostRequest(scenario.host, { requestId: "h-1", method: "test.echo", params: { value: "hello" } });
    await flush();

    const answer = clientAnswers(scenario, "h-1")[0];
    expect(answer?.["error"]).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(answer?.["result"]).toBeUndefined();
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });
});
