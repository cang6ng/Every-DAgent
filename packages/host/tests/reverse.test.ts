/**
 * The generic reverse mechanism, driven through the real host.
 *
 * Every test here goes through the production path: the trigger validates and
 * encodes, the frame crosses the loopback channel as a string, the fixture
 * answers with a frame built by the protocol, and the dispatcher correlates and
 * validates the answer against the profile before anything settles. Nothing
 * reaches into the pending map directly.
 *
 * What is proved: the gates (capability, stream, profile), the correlation
 * rules (instance, stream, profile result), and every way a wait can end —
 * answered, refused, cancelled, timed out, or ended by the stream, the
 * connection or the host. A notice is addressed: the connection that owns the
 * pending is the only one told, on the stream that pending lived on.
 */

import { describe, expect, it } from "vitest";

import { decodeFrame, validateMessage } from "@every-dagent/protocol";

import { composeHost, type AttachedConnection, type Host } from "../src/host.js";
import type { ReverseProfile } from "../src/reverse.js";

import { connect, flush, scriptedModel, textReply } from "./helpers/harness.js";
import {
  ECHO_METHOD,
  echoAnswerOf,
  echoParamsOf,
  echoProfile,
  echoValueOf,
  echoedOf,
} from "./helpers/reverse-fixture.js";

function composed(profiles: readonly ReverseProfile[] = [echoProfile()]): {
  readonly attached: AttachedConnection[];
  readonly host: Host;
} {
  const attached: AttachedConnection[] = [];
  const composedHost = composeHost(
    { modelClient: scriptedModel([textReply("unused")]).client, plugins: [] },
    {
      reverseProfiles: profiles,
      onAttach: (connection) => {
        attached.push(connection);
      },
    },
  );
  return { attached, host: composedHost.host };
}

/** Describes, subscribes, and hands back the connection that owns the stream. */
async function subscribed(answer: "value" | "error" | "ignore" = "value"): Promise<{
  readonly connection: AttachedConnection;
  readonly client: ReturnType<typeof connect>;
  readonly host: Host;
}> {
  const { attached, host } = composed();
  const client = connect(host, {
    reverseRequests: true,
    onReverse: (request, response) => {
      if (answer === "ignore") {
        response.ignore();
        return;
      }
      if (answer === "error") {
        response.fail("REQUEST_CANCELLED");
        return;
      }
      response.respond(echoAnswerOf(echoValueOf(request.params) ?? ""));
    },
  });
  await client.describe();
  await client.call("subscriptions.open", {});
  await flush();
  const connection = attached[0];
  if (connection === undefined) throw new Error("the host attached no connection");
  return { connection, client, host };
}

/** The stream id of the last subscription response the client received. */
function lastStreamId(frames: readonly string[]): string {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame === undefined) continue;
    const decoded = decodeFrame(frame);
    if (!decoded.success || decoded.output.kind !== "host-response") continue;
    const validated = validateMessage(
      { kind: "host-response", method: "subscriptions.open" },
      decoded.output,
    );
    if (validated.success && validated.output.result !== undefined) {
      return validated.output.result.snapshot.watermark.streamId;
    }
  }
  throw new Error("no subscription response was seen");
}

describe("reverse capability", () => {
  it("declares the capability only because the mechanism exists", async () => {
    const { client } = await subscribed();
    const response = await client.call("host.describe", {
      supportedProtocolVersions: ["2"],
      client: { name: "fixture", version: "0.1.0" },
      capabilities: { reverseRequests: true },
    });

    expect(response.result?.capabilities.reverseRequests).toBe(true);
    expect(response.result?.clientCapabilities.reverseRequests).toBe(true);
  });

  it("refuses to send to a client that did not declare the capability", async () => {
    const { attached, host } = composed();
    const client = connect(host, { reverseRequests: false });
    await client.describe();
    await client.call("subscriptions.open", {});
    await flush();
    const connection = attached[0];
    if (connection === undefined) throw new Error("the host attached no connection");

    const before = client.frames.length;
    const outcome = await connection.reverse.request(ECHO_METHOD, echoParamsOf("hi"), 1000).outcome;
    await flush();

    expect(outcome).toEqual({ ok: false, reason: "unavailable" });
    expect(client.frames.length).toBe(before);
  });

  it("refuses a method with no registered profile", async () => {
    const { connection } = await subscribed();

    const outcome = await connection.reverse.request("test.unregistered", echoParamsOf("hi"), 1000).outcome;

    expect(outcome).toEqual({ ok: false, reason: "unavailable" });
  });

  it("refuses params that do not satisfy the profile", async () => {
    const { connection } = await subscribed();

    const outcome = await connection.reverse.request(ECHO_METHOD, { value: 42 }, 1000).outcome;

    expect(outcome).toEqual({ ok: false, reason: "unavailable" });
  });

  it("cannot send before the connection has a stream", async () => {
    const { attached, host } = composed();
    const client = connect(host, { reverseRequests: true });
    await client.describe();
    await flush();
    const connection = attached[0];
    if (connection === undefined) throw new Error("the host attached no connection");

    const outcome = await connection.reverse.request(ECHO_METHOD, echoParamsOf("hi"), 1000).outcome;

    expect(outcome).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("answers", () => {
  it("resolves with the client's validated result", async () => {
    const { connection, client } = await subscribed();

    const outcome = await connection.reverse.request(ECHO_METHOD, echoParamsOf("hello"), 1000).outcome;

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !("result" in outcome)) throw new Error("the request did not succeed");
    expect(echoedOf(outcome.result)).toBe("hello");
    expect(client.isClosed).toBe(false);
  });

  it("resolves with the client's error when it refuses to answer", async () => {
    const { connection } = await subscribed("error");

    const outcome = await connection.reverse.request(ECHO_METHOD, echoParamsOf("hello"), 1000).outcome;

    expect(outcome).toEqual({
      ok: false,
      error: { code: "REQUEST_CANCELLED", message: "test client: REQUEST_CANCELLED" },
    });
  });

  it("ends the connection when an answer does not satisfy the profile", async () => {
    const { attached, host } = composed();
    const client = connect(host, {
      reverseRequests: true,
      onReverse: (_request, response) => {
        response.respond({ echoed: 42 });
      },
    });
    await client.describe();
    await client.call("subscriptions.open", {});
    await flush();
    const connection = attached[0];
    if (connection === undefined) throw new Error("the host attached no connection");

    const outcome = await connection.reverse.request(ECHO_METHOD, echoParamsOf("hello"), 1000).outcome;
    await flush();

    expect(outcome).toEqual({ ok: false, reason: "closed" });
    expect(client.isClosed).toBe(true);
  });

  it("ends the connection when the answer names another instance", async () => {
    const { attached, host } = composed();
    const client = connect(host, {
      reverseRequests: true,
      onReverse: (request, response) => {
        response.ignore();
        client.sendRaw(
          JSON.stringify({
            kind: "client-response",
            protocolVersion: "2",
            hostInstanceId: "somewhere-else",
            streamId: request.streamId,
            requestId: request.requestId,
            result: echoAnswerOf("hello"),
          }),
        );
      },
    });
    await client.describe();
    await client.call("subscriptions.open", {});
    await flush();
    const connection = attached[0];
    if (connection === undefined) throw new Error("the host attached no connection");

    const outcome = await connection.reverse.request(ECHO_METHOD, echoParamsOf("hello"), 1000).outcome;
    await flush();

    expect(outcome).toEqual({ ok: false, reason: "closed" });
    expect(client.isClosed).toBe(true);
  });

  it("ends the connection when the answer names another stream", async () => {
    const { attached, host } = composed();
    const client = connect(host, {
      reverseRequests: true,
      onReverse: (request, response) => {
        response.ignore();
        client.sendRaw(
          JSON.stringify({
            kind: "client-response",
            protocolVersion: "2",
            hostInstanceId: request.hostInstanceId,
            streamId: "not-the-stream",
            requestId: request.requestId,
            result: echoAnswerOf("hello"),
          }),
        );
      },
    });
    await client.describe();
    await client.call("subscriptions.open", {});
    await flush();
    const connection = attached[0];
    if (connection === undefined) throw new Error("the host attached no connection");

    const outcome = await connection.reverse.request(ECHO_METHOD, echoParamsOf("hello"), 1000).outcome;
    await flush();

    expect(outcome).toEqual({ ok: false, reason: "closed" });
    expect(client.isClosed).toBe(true);
  });

  it("drops a duplicate answer without settling anything twice", async () => {
    const { attached, host } = composed();
    const answers: (() => void)[] = [];
    const client = connect(host, {
      reverseRequests: true,
      onReverse: (_request, response) => {
        answers.push(() => response.respond(echoAnswerOf("first")));
      },
    });
    await client.describe();
    await client.call("subscriptions.open", {});
    await flush();
    const connection = attached[0];
    if (connection === undefined) throw new Error("the host attached no connection");

    const handle = connection.reverse.request(ECHO_METHOD, echoParamsOf("hello"), 1000);
    await flush();
    answers[0]?.();
    const outcome = await handle.outcome;

    // The same answer again: the pending is gone, so it is unassociated — read,
    // validated, and never allowed to settle anything a second time.
    answers[0]?.();
    await flush();

    expect(outcome.ok).toBe(true);
    expect(client.isClosed).toBe(false);
  });
});

describe("wait lifecycle", () => {
  it("times out, tells the client, and consumes a sequence for the notice", async () => {
    const { connection, client } = await subscribed("ignore");
    const before = client.events.length;

    const outcome = await connection.reverse.request(ECHO_METHOD, echoParamsOf("slow"), 20).outcome;
    await flush();

    expect(outcome).toEqual({ ok: false, reason: "timeout" });
    const notices = client.events.slice(before).filter((event) => event.type === "host.request.cancelled");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({ reason: "timeout" });

    const sequences = client.events.slice(before).map((event) => event.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("stops waiting on cancel and tells the client why", async () => {
    const { connection, client } = await subscribed("ignore");

    const handle = connection.reverse.request(ECHO_METHOD, echoParamsOf("slow"), 5000);
    handle.cancel();

    expect(await handle.outcome).toEqual({ ok: false, reason: "cancelled" });
    await flush();
    const notices = client.events.filter((event) => event.type === "host.request.cancelled");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload.reason).toBe("cancelled");
  });

  it("ignores a late answer after its own cancellation", async () => {
    const { attached, host } = composed();
    const answers: (() => void)[] = [];
    const client = connect(host, {
      reverseRequests: true,
      onReverse: (_request, response) => {
        answers.push(() => response.respond(echoAnswerOf("late")));
      },
    });
    await client.describe();
    await client.call("subscriptions.open", {});
    await flush();
    const connection = attached[0];
    if (connection === undefined) throw new Error("the host attached no connection");

    const handle = connection.reverse.request(ECHO_METHOD, echoParamsOf("slow"), 5000);
    handle.cancel();
    expect(await handle.outcome).toEqual({ ok: false, reason: "cancelled" });

    await flush();
    answers[0]?.();
    await flush();

    expect(client.isClosed).toBe(false);
  });

  it("ends the wait when the stream it lived on is replaced", async () => {
    const { connection, client } = await subscribed("ignore");

    const handle = connection.reverse.request(ECHO_METHOD, echoParamsOf("slow"), 5000);
    await client.call("subscriptions.open", {});
    await flush();

    expect(await handle.outcome).toEqual({ ok: false, reason: "stream-gone" });
  });

  it("ends the wait when the stream is closed", async () => {
    const { connection, client } = await subscribed("ignore");

    const handle = connection.reverse.request(ECHO_METHOD, echoParamsOf("slow"), 5000);
    const closed = await client.call("subscriptions.close", { streamId: lastStreamId(client.frames) });

    expect(closed.result?.closed).toBe(true);
    expect(await handle.outcome).toEqual({ ok: false, reason: "stream-gone" });
  });

  it("ends the wait when the connection goes away", async () => {
    const { connection, client } = await subscribed("ignore");

    const handle = connection.reverse.request(ECHO_METHOD, echoParamsOf("slow"), 5000);
    client.detach();

    expect(await handle.outcome).toEqual({ ok: false, reason: "closed" });
  });

  it("ends the wait when the host shuts down, and still resolves shutdown", async () => {
    const { attached, host } = composed();
    const client = connect(host, { reverseRequests: true, onReverse: (_request, response) => response.ignore() });
    await client.describe();
    await client.call("subscriptions.open", {});
    await flush();
    const connection = attached[0];
    if (connection === undefined) throw new Error("the host attached no connection");

    const handle = connection.reverse.request(ECHO_METHOD, echoParamsOf("slow"), 5000);
    const shutdown = host.shutdown();

    await expect(handle.outcome).resolves.toEqual({ ok: false, reason: "closed" });
    await expect(shutdown).resolves.toBeUndefined();
  });
});

describe("addressing", () => {
  it("tells only the connection that made the request", async () => {
    const { attached, host } = composed();
    const first = connect(host, { reverseRequests: true, onReverse: (_request, response) => response.ignore() });
    const second = connect(host, { reverseRequests: true });
    await first.describe();
    await first.call("subscriptions.open", {});
    await second.describe();
    await second.call("subscriptions.open", {});
    await flush();
    const connection = attached[0];
    if (connection === undefined) throw new Error("the host attached no connection");

    const handle = connection.reverse.request(ECHO_METHOD, echoParamsOf("slow"), 5000);
    handle.cancel();
    await flush();

    expect(first.events.filter((event) => event.type === "host.request.cancelled")).toHaveLength(1);
    expect(second.events.filter((event) => event.type === "host.request.cancelled")).toHaveLength(0);
  });

  it("keeps the two directions' request ids in separate accounts", async () => {
    const { connection, client } = await subscribed();

    await connection.reverse.request(ECHO_METHOD, echoParamsOf("hello"), 1000).outcome;

    // The client spends a *string* the host used as a reverse id on its own
    // forward request: the two directions are separate accounts, so this is a
    // fresh id rather than a duplicate.
    const response = await client.call("sessions.list", {}, { requestId: "host-request-1" });

    expect(response.result?.sessions.items).toEqual([]);
    expect(response.result?.sessions.hasMore).toBe(false);
    expect(client.isClosed).toBe(false);
  });
});

describe("the deadline is armed against an entry that already exists", () => {
  it("never sends a request whose deadline passed during setup", async () => {
    const { attached, host } = composed();
    const client = connect(host, { reverseRequests: true, onReverse: (_request, response) => response.ignore() });
    await client.describe();
    await client.call("subscriptions.open", {});
    await flush();
    const connection = attached[0];
    if (connection === undefined) throw new Error("the host attached no connection");
    const before = client.frames.length;

    // The clock moves while the request is being set up, so the deadline is
    // already in the past when the wait is armed.
    let reads = 0;
    const realNow = Date.now;
    Date.now = (): number => {
      reads += 1;
      return realNow.call(Date) + reads * 1000;
    };
    try {
      const outcome = await connection.reverse.request(ECHO_METHOD, echoParamsOf("late"), 1).outcome;
      expect(outcome).toEqual({ ok: false, reason: "timeout" });
    } finally {
      Date.now = realNow;
    }
    await flush();

    // Nothing was sent for it, and no cancellation notice was owed for a
    // request the client never saw.
    expect(client.frames.length).toBe(before);
    expect(client.events.filter((event) => event.type === "host.request.cancelled")).toHaveLength(0);
  });

  it("keeps the ordinary timeout path working", async () => {
    const { connection, client } = await subscribed("ignore");
    const before = client.events.length;

    const outcome = await connection.reverse.request(ECHO_METHOD, echoParamsOf("slow"), 30).outcome;
    await flush();

    expect(outcome).toEqual({ ok: false, reason: "timeout" });
    expect(client.events.slice(before).filter((event) => event.type === "host.request.cancelled")).toHaveLength(1);
    expect(client.frames.length).toBeGreaterThan(1);
  });

  it("settles a request at most once when cancel and answer race", async () => {
    const { attached, host } = composed();
    const answers: (() => void)[] = [];
    const client = connect(host, {
      reverseRequests: true,
      onReverse: (_request, response) => {
        answers.push(() => response.respond(echoAnswerOf("late")));
      },
    });
    await client.describe();
    await client.call("subscriptions.open", {});
    await flush();
    const connection = attached[0];
    if (connection === undefined) throw new Error("the host attached no connection");

    const handle = connection.reverse.request(ECHO_METHOD, echoParamsOf("hello"), 5000);
    await flush();

    // The host stops waiting, and *then* the answer arrives: one outcome, and
    // the late answer is not allowed to settle anything a second time.
    handle.cancel();
    expect(await handle.outcome).toEqual({ ok: false, reason: "cancelled" });
    answers[0]?.();
    await flush();

    expect(handle.outcome).toBeDefined();
    expect(client.isClosed).toBe(false);
  });
});
