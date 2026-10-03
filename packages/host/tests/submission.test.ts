import { describe, expect, it } from "vitest";

import {
  awaitRunTerminal,
  connect,
  createSessionThrough,
  flush,
  gate,
  gatedReply,
  nextId,
  scriptedModel,
  testHost,
  textReply,
} from "./helpers/harness.js";

describe("submission dedup", () => {
  it("answers a repeated submission with the original run and does not execute it twice", async () => {
    const model = scriptedModel([textReply("once only")]);
    const host = await testHost({ modelClient: model.client });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const submissionId = nextId("sub");
    const first = await client.call("runs.start", { sessionId: session.sessionId, submissionId, text: "hi" });
    const again = await client.call("runs.start", { sessionId: session.sessionId, submissionId, text: "hi" });

    expect(again.result?.run.runId).toBe(first.result?.run.runId);
    await awaitRunTerminal(client, first.result?.run.runId as string);
    expect(model.requests).toHaveLength(1);
  });

  it("answers the duplicate even while the host is occupied", async () => {
    const hold = gate();
    const host = await testHost({ modelClient: scriptedModel([gatedReply(hold)]).client });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const submissionId = nextId("sub");
    const first = await client.call("runs.start", { sessionId: session.sessionId, submissionId, text: "hi" });
    const again = await client.call("runs.start", { sessionId: session.sessionId, submissionId, text: "hi" });

    // Dedup outranks busy: the host is occupied by this very run.
    expect(again.result?.run.runId).toBe(first.result?.run.runId);

    hold.open();
    await awaitRunTerminal(client, first.result?.run.runId as string);
  });

  it("refuses the same submission id with different text", async () => {
    const hold = gate();
    const host = await testHost({ modelClient: scriptedModel([gatedReply(hold)]).client });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const submissionId = nextId("sub");
    const first = await client.call("runs.start", { sessionId: session.sessionId, submissionId, text: "original" });
    const conflict = await client.call("runs.start", {
      sessionId: session.sessionId,
      submissionId,
      text: "different",
    });

    expect(conflict.error?.code).toBe("SUBMISSION_CONFLICT");
    expect(conflict.result).toBeUndefined();

    // The original run is untouched.
    const unchanged = await client.call("runs.get", { runId: first.result?.run.runId as string });
    expect(unchanged.result?.run.text).toBe("original");

    hold.open();
    await awaitRunTerminal(client, first.result?.run.runId as string);
  });

  it("refuses the same submission id from a different session", async () => {
    const hold = gate();
    const host = await testHost({ modelClient: scriptedModel([gatedReply(hold)]).client });
    const client = connect(host);
    await client.describe();
    const first = await createSessionThrough(client);
    const second = await createSessionThrough(client);

    const submissionId = nextId("sub");
    const started = await client.call("runs.start", { sessionId: first.sessionId, submissionId, text: "hi" });
    const conflict = await client.call("runs.start", { sessionId: second.sessionId, submissionId, text: "hi" });

    expect(conflict.error?.code).toBe("SUBMISSION_CONFLICT");

    hold.open();
    await awaitRunTerminal(client, started.result?.run.runId as string);
  });

  it("creates one run when the same submission is sent twice without waiting", async () => {
    const model = scriptedModel([textReply("once")]);
    const host = await testHost({ modelClient: model.client });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const submissionId = nextId("sub");
    const params = { sessionId: session.sessionId, submissionId, text: "concurrent" };
    // Two frames, sent back to back, before either response can arrive.
    const [first, second] = await Promise.all([
      client.call("runs.start", params),
      client.call("runs.start", params),
    ]);

    expect(second.result?.run.runId).toBe(first.result?.run.runId);
    await awaitRunTerminal(client, first.result?.run.runId as string);
    expect(model.requests).toHaveLength(1);
  });

  it("does not claim a submission id that was refused", async () => {
    const hold = gate();
    const host = await testHost({ modelClient: scriptedModel([gatedReply(hold), textReply("second")]).client });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);
    const other = await createSessionThrough(client);

    const busySubmission = nextId("sub");
    await client.call("runs.start", { sessionId: session.sessionId, submissionId: nextId("sub"), text: "first" });

    // Refused for being busy: the id is still free.
    const refused = await client.call("runs.start", {
      sessionId: other.sessionId,
      submissionId: busySubmission,
      text: "retry me",
    });
    expect(refused.error?.code).toBe("HOST_BUSY");

    hold.open();
    await flush();

    const retried = await client.call("runs.start", {
      sessionId: other.sessionId,
      submissionId: busySubmission,
      text: "retry me",
    });
    expect(retried.result?.run.status).toBe("accepted");
    await awaitRunTerminal(client, retried.result?.run.runId as string);
  });

  it("does not claim a submission id refused for an unknown session", async () => {
    const model = scriptedModel([textReply("answer")]);
    const host = await testHost({ modelClient: model.client });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const submissionId = nextId("sub");
    expect(
      (await client.call("runs.start", { sessionId: "ghost", submissionId, text: "hi" })).error?.code,
    ).toBe("SESSION_NOT_FOUND");

    const accepted = await client.call("runs.start", { sessionId: session.sessionId, submissionId, text: "hi" });
    expect(accepted.result?.run.status).toBe("accepted");
    await awaitRunTerminal(client, accepted.result?.run.runId as string);
  });

  it("keeps the dedup record after an accepted run fails", async () => {
    const host = await testHost({ modelClient: scriptedModel([]).client });
    const client = connect(host);
    await client.describe();
    const session = await createSessionThrough(client);

    const submissionId = nextId("sub");
    const first = await client.call("runs.start", { sessionId: session.sessionId, submissionId, text: "doomed" });
    const runId = first.result?.run.runId as string;
    const terminal = await awaitRunTerminal(client, runId);
    expect(terminal.status).toBe("failed");
    expect(terminal.endReason).toBe("error");

    const again = await client.call("runs.start", { sessionId: session.sessionId, submissionId, text: "doomed" });
    expect(again.result?.run.runId).toBe(runId);
    expect(again.result?.run.status).toBe("failed");
  });
});

describe("response loss and reconnect", () => {
  it("finds the run by submission id from a new connection", async () => {
    const hold = gate();
    const model = scriptedModel([gatedReply(hold)]);
    const host = await testHost({ modelClient: model.client });

    const first = connect(host);
    const firstDescription = await first.describe();
    const session = await createSessionThrough(first);
    const submissionId = nextId("sub");

    const started = await first.call("runs.start", { sessionId: session.sessionId, submissionId, text: "lost" });
    // The client that sent the request never reads the response.
    first.detach();

    const second = connect(host);
    const description = await second.describe();
    const found = await second.call("runs.get", { submissionId });

    expect(found.result?.run.runId).toBe(started.result?.run.runId);
    // Same instance: the old submission is still meaningful on this connection.
    expect(description.result?.hostInstanceId).toBe(firstDescription.result?.hostInstanceId);

    hold.open();
    const terminal = await awaitRunTerminal(second, found.result?.run.runId as string);
    expect(terminal.status).toBe("completed");
    // The work ran once, for the one submission that was accepted.
    expect(model.requests).toHaveLength(1);
  });

  it("does not know a submission from a different host instance", async () => {
    const model = scriptedModel([textReply("answer")]);
    const first = await testHost({ modelClient: model.client });
    const second = await testHost({ modelClient: model.client });

    const firstClient = connect(first);
    await firstClient.describe();
    const session = await createSessionThrough(firstClient);
    const submissionId = nextId("sub");
    const started = await firstClient.call("runs.start", { sessionId: session.sessionId, submissionId, text: "hi" });

    const secondClient = connect(second);
    await secondClient.describe();

    // A fresh instance knows nothing about the old submission, and the client
    // is expected to treat its outcome as unknown rather than replay it.
    expect((await secondClient.call("runs.get", { submissionId })).error?.code).toBe("RUN_NOT_FOUND");

    await awaitRunTerminal(firstClient, started.result?.run.runId as string);
  });
});
