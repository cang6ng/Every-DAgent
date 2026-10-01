/**
 * Request correlation: which answer belongs to which request, and what happens
 * to everything that does not.
 *
 * The rules being tested are the ones the wire cannot express: a response
 * carries no method, so the pending request decides its schema — and before any
 * of that, every response is checked against the connection it arrived on.
 * A response that is merely *unassociated* is dropped; one that contradicts this
 * connection's context is a peer error, whether or not a request is waiting.
 */

import { describe, expect, it } from "vitest";

import { createClient } from "../src/index.js";

import { createFakeHost } from "./helpers/fake-host.js";
import { createScenario, flush } from "./helpers/scenario.js";
import { activeRun, sessionPage, sessionSummary } from "./helpers/values.js";

describe("correlating answers", () => {
  it("resolves out-of-order answers to their own requests", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const host = scenario.host;

    const list = scenario.client.sessions.list();
    const create = scenario.client.sessions.create();
    const listId = host.requestIdOf("sessions.list") ?? "";
    const createId = host.requestIdOf("sessions.create") ?? "";

    // Answered in the opposite order to the one they were sent in.
    host.respond(createId, "sessions.create", { session: sessionSummary({ sessionId: "s-1" }) });
    host.respond(listId, "sessions.list", { sessions: sessionPage([]) });

    await expect(create).resolves.toMatchObject({ session: { sessionId: "s-1" } });
    await expect(list).resolves.toEqual({ sessions: sessionPage([]) });
  });

  it("drops a duplicate answer without resolving anything twice", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const host = scenario.host;

    const list = scenario.client.sessions.list();
    const requestId = host.requestIdOf("sessions.list") ?? "";
    host.respond(requestId, "sessions.list", { sessions: sessionPage([]) });
    await expect(list).resolves.toEqual({ sessions: sessionPage([]) });

    const before = host.delivered.length;
    host.respond(requestId, "sessions.list", { sessions: sessionPage([]) });
    await flush();

    expect(host.delivered.length).toBe(before + 1);
    expect(scenario.client.getSnapshot().status).toBe("ready");
    expect(scenario.client.getSnapshot().presentation).toEqual(scenario.host.snapshot());
  });

  it("drops an answer to a request that was never made", async () => {
    const scenario = createScenario();
    await scenario.ready();

    scenario.host.respond("never-asked", "sessions.list", { sessions: sessionPage([]) });
    await flush();

    expect(scenario.client.getSnapshot().status).toBe("ready");
  });

  it("reports a refused operation as a remote error, keeping its code", async () => {
    const scenario = createScenario();
    await scenario.ready();

    const get = scenario.client.sessions.get({ sessionId: "missing" });
    scenario.host.respondError(scenario.host.requestIdOf("sessions.get") ?? "", "SESSION_NOT_FOUND");

    await expect(get).rejects.toMatchObject({
      kind: "remote",
      code: "SESSION_NOT_FOUND",
      protocolError: { code: "SESSION_NOT_FOUND" },
    });
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });
});

describe("answers that contradict the connection", () => {
  it("ends the connection when an answer names another instance — even an unknown request", async () => {
    const scenario = createScenario();
    await scenario.ready();

    scenario.host.sendRaw(
      JSON.stringify({
        kind: "host-response",
        protocolVersion: "2",
        hostInstanceId: "somewhere-else",
        requestId: "never-asked",
        result: { sessions: sessionPage([]) },
      }),
    );
    await flush();

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
    expect(scenario.client.getSnapshot().error?.reason).toBe("host-instance-mismatch");
  });

  it("ends the connection when a *duplicate* answer names another instance", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const host = scenario.host;

    const list = scenario.client.sessions.list();
    const requestId = host.requestIdOf("sessions.list") ?? "";
    host.respond(requestId, "sessions.list", { sessions: sessionPage([]) });
    await list;

    host.sendRaw(
      JSON.stringify({
        kind: "host-response",
        protocolVersion: "2",
        hostInstanceId: "somewhere-else",
        requestId,
        result: { sessions: sessionPage([]) },
      }),
    );
    await flush();

    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("ends the connection when an answer does not match its request's schema", async () => {
    const scenario = createScenario();
    await scenario.ready();

    const run = scenario.client.runs.get({ runId: "r-1" });
    // A structurally valid response carrying `sessions.list`'s payload under a
    // `runs.get` request: only the pending request knows the right schema.
    scenario.host.sendRaw(
      JSON.stringify({
        kind: "host-response",
        protocolVersion: "2",
        hostInstanceId: scenario.host.hostInstanceId,
        requestId: scenario.host.requestIdOf("runs.get") ?? "",
        result: { sessions: sessionPage([]) },
      }),
    );

    await expect(run).rejects.toMatchObject({ kind: "protocol", reason: "invalid-response" });
    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("ends the connection when a result describes a different request", async () => {
    const scenario = createScenario();
    await scenario.ready();

    const get = scenario.client.sessions.get({ sessionId: "s-1" });
    scenario.host.respond(scenario.host.requestIdOf("sessions.get") ?? "", "sessions.get", {
      session: sessionSummary({ sessionId: "s-OTHER" }),
    });

    await expect(get).rejects.toMatchObject({ kind: "protocol", reason: "result-identity" });
    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("ends the connection when a start result describes a different submission", async () => {
    const scenario = createScenario();
    await scenario.ready();

    const start = scenario.client.runs.start({ sessionId: "s-1", submissionId: "sub-1", text: "hello" });
    scenario.host.respond(scenario.host.requestIdOf("runs.start") ?? "", "runs.start", {
      run: activeRun({
        runId: "r-1",
        sessionId: "s-1",
        submissionId: "sub-OTHER",
        text: "hello",
      }),
    });

    await expect(start).rejects.toMatchObject({ kind: "protocol", reason: "result-identity" });
    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });
});

describe("requests the client will not send", () => {
  it("refuses an operation the host does not support, without sending anything", async () => {
    const scenario = createScenario({ host: { capabilities: { plugins: false } } });
    await scenario.ready();
    const before = scenario.host.sent.length;

    const enabling = scenario.client.plugins.enable({ pluginId: "demo" });

    await expect(enabling).rejects.toMatchObject({
      kind: "client",
      reason: "capability-unavailable",
      outcome: "not-sent",
    });
    expect(scenario.host.sent.length).toBe(before);
  });

  it("refuses a business method before the connection is initialized", async () => {
    const host = createFakeHost();
    const client = createClient({ connect: () => Promise.resolve(host.channel) });

    const listing = client.sessions.list();

    await expect(listing).rejects.toMatchObject({ code: "CONNECTION_LOST", reason: "disconnected" });
    expect(host.sent).toHaveLength(0);
  });

  it("refuses params that do not satisfy the method's contract", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const before = scenario.host.sent.length;

    const start = scenario.client.runs.start({ sessionId: "s-1", submissionId: "sub-1", text: "   " });

    await expect(start).rejects.toMatchObject({ kind: "client", reason: "invalid-params", outcome: "not-sent" });
    expect(scenario.host.sent.length).toBe(before);
  });
});

describe("losing the connection", () => {
  it("ends an outstanding request as connection-lost with an unknown outcome", async () => {
    const scenario = createScenario();
    await scenario.ready();

    const listing = scenario.client.sessions.list();
    scenario.host.close();

    const failure = await listing.catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "connection", code: "CONNECTION_LOST", outcome: "unknown" });
    expect(scenario.client.getSnapshot().status).toBe("lost");
  });

  it("never puts CONNECTION_LOST on the wire", async () => {
    const scenario = createScenario();
    await scenario.ready();

    const listing = scenario.client.sessions.list();
    scenario.host.close();
    await listing.catch(() => undefined);

    for (const frame of scenario.host.sent) {
      expect(frame).not.toContain("CONNECTION_LOST");
    }
  });
});

describe("the request the client remembers is the request it sent", () => {
  it("checks a result against the parameters that travelled, not the caller's object", async () => {
    const scenario = createScenario();
    await scenario.ready();
    const params = { sessionId: "original" };

    const response = scenario.client.sessions.get(params);
    params.sessionId = "changed-after-send";
    scenario.host.respond(scenario.host.requestIdOf("sessions.get") ?? "", "sessions.get", {
      session: sessionSummary({ sessionId: "original" }),
    });

    await expect(response).resolves.toMatchObject({ session: { sessionId: "original" } });
    expect(scenario.client.getSnapshot().status).toBe("ready");
  });

  it("keeps a protocol failure on a sent write conservatively unknown", async () => {
    const scenario = createScenario();
    await scenario.ready();

    const creating = scenario.client.sessions.create();
    scenario.host.sendRaw(
      JSON.stringify({
        kind: "host-response",
        protocolVersion: "2",
        hostInstanceId: scenario.host.hostInstanceId,
        requestId: scenario.host.requestIdOf("sessions.create") ?? "",
        result: { wrong: "schema" },
      }),
    );

    const failure = await creating.catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "protocol", code: "PROTOCOL_VIOLATION", outcome: "unknown" });
    expect(scenario.client.getSnapshot().status).toBe("protocol-error");
  });

  it("keeps a control slot free when every ordinary slot is taken", async () => {
    const scenario = createScenario();
    await scenario.ready();

    const ordinary = Array.from({ length: 128 }, () => scenario.client.sessions.list().catch(() => undefined));
    await expect(scenario.client.resync()).resolves.toBeUndefined();

    const refused = scenario.client.sessions.list();
    await expect(refused).rejects.toMatchObject({ kind: "client", reason: "capacity" });

    scenario.client.disconnect();
    await Promise.all(ordinary);
  });
});
