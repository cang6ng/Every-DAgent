import { describe, expect, it } from "vitest";

import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import { MAX_MODEL_ATTEMPTS, MAX_STEPS, createAgentLoop } from "../src/loop/agent-loop.js";
import type { AgentLoop, AgentLoopEvent } from "../src/loop/agent-loop.js";
import type { ModelClient, ModelEvent } from "../src/model/model-client.js";
import type { RuntimeContext } from "../src/runtime/runtime-context.js";
import type { SessionEvent } from "../src/session/session-event.js";
import { createSession } from "../src/session/session.js";
import type { Session } from "../src/session/session.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import type { ToolRegistry } from "../src/tools/tool-registry.js";
import { createEchoTool } from "./helpers/fake-echo-tool.js";
import {
  createFakeModelClient,
  failingReply,
  replyThenFail,
} from "./helpers/fake-model-client.js";
import { unsettledToolCalls } from "../../../tests/helpers/session-lifecycle.js";

const TURN = "turn-1";
const context: RuntimeContext = { sessionId: "session-1", signal: new AbortController().signal };

/** Writes the two events the AgentRuntime always puts in front of a turn. */
function openTurn(session: Session, text: string): void {
  session.append({ type: "turn/start", turnId: TURN, data: {} });
  session.append({ type: "message/user", turnId: TURN, data: { text } });
}

function loopFor(modelClient: ModelClient, tools: ToolRegistry): AgentLoop {
  return createAgentLoop({ modelClient, tools, contextBuilder: createDefaultContextBuilder() });
}

function assistantSteps(session: Session): Extract<SessionEvent, { type: "message/assistant" }>["data"][] {
  return session.events().flatMap((event) => (event.type === "message/assistant" ? [event.data] : []));
}

function toolResults(session: Session): Extract<SessionEvent, { type: "tool/result" }>["data"][] {
  return session.events().flatMap((event) => (event.type === "tool/result" ? [event.data] : []));
}

function answerReply(text: string): ModelEvent[] {
  return [{ type: "text-delta", text }, { type: "done" }];
}

function echoReply(callId: string, text: string): ModelEvent[] {
  return [{ type: "tool-call", call: { callId, name: "echo", input: { text } } }, { type: "done" }];
}

function abortableContext(signal: AbortSignal): RuntimeContext {
  return { ...context, signal };
}

describe("AgentLoop step budget", () => {
  it("stops a model that never stops asking for a tool", async () => {
    const session = createSession("s-1");
    openTurn(session, "loop forever");
    const tools = createToolRegistry();
    const echo = createEchoTool();
    tools.register(echo);
    const client = createFakeModelClient([echoReply("call-1", "again")], { repeatLast: true });

    const outcome = await loopFor(client, tools).runTurn({ session, turnId: TURN, context });

    expect(outcome).toEqual({ reason: "max_steps", text: "" });
    // The budget counts model calls: the twelfth step runs, a thirteenth is refused.
    expect(client.requests).toHaveLength(MAX_STEPS);
    expect(echo.calls).toHaveLength(MAX_STEPS);
    expect(assistantSteps(session)).toHaveLength(MAX_STEPS);
    // Running out of budget is not a broken history: every call was answered.
    expect(unsettledToolCalls(session)).toEqual([]);
  });

  it("answers on the last allowed step instead of running out of budget", async () => {
    const session = createSession("s-1");
    openTurn(session, "just in time");
    const tools = createToolRegistry();
    const echo = createEchoTool();
    tools.register(echo);
    const script: ModelEvent[][] = Array.from({ length: MAX_STEPS - 1 }, (_unused, index) =>
      echoReply(`call-${index}`, "again"),
    );
    script.push(answerReply("finished"));
    const client = createFakeModelClient(script);

    const outcome = await loopFor(client, tools).runTurn({ session, turnId: TURN, context });

    expect(outcome).toEqual({ reason: "completed", text: "finished" });
    expect(client.requests).toHaveLength(MAX_STEPS);
    expect(echo.calls).toHaveLength(MAX_STEPS - 1);
  });
});

describe("AgentLoop model retry", () => {
  it("retries a step that failed before producing anything", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const client = createFakeModelClient([
      failingReply(new Error("connection reset")),
      answerReply("second try"),
    ]);

    const outcome = await loopFor(client, createToolRegistry()).runTurn({ session, turnId: TURN, context });

    expect(outcome).toEqual({ reason: "completed", text: "second try" });
    expect(client.requests).toHaveLength(2);
    // A retry is invisible: the step is recorded once, as the attempt that worked.
    expect(assistantSteps(session)).toEqual([{ text: "second try", toolCalls: [] }]);
  });

  it("gives up after the attempt budget and reports the last failure", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const client = createFakeModelClient([
      failingReply(new Error("attempt one")),
      failingReply(new Error("attempt two")),
      failingReply(new Error("attempt three")),
      answerReply("never reached"),
    ]);

    const outcome = await loopFor(client, createToolRegistry()).runTurn({ session, turnId: TURN, context });

    expect(outcome.reason).toBe("error");
    expect(outcome.error).toContain(`${MAX_MODEL_ATTEMPTS} attempts`);
    expect(outcome.error).toContain("attempt three");
    expect(client.requests).toHaveLength(MAX_MODEL_ATTEMPTS);
    // A step that never completed leaves no assistant message behind.
    expect(assistantSteps(session)).toEqual([]);
  });

  it("does not retry a step whose output the audience already saw", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const chunks: string[] = [];
    const client = createFakeModelClient([
      replyThenFail([{ type: "text-delta", text: "half an answer" }], new Error("stream died")),
      answerReply("second try"),
    ]);

    const outcome = await loopFor(client, createToolRegistry()).runTurn({
      session,
      turnId: TURN,
      context,
      emit: (event: AgentLoopEvent) => {
        if (event.type === "assistant/chunk") chunks.push(event.text);
      },
    });

    expect(outcome).toEqual({ reason: "error", text: "", error: "stream died" });
    // The text reached the stream, so repeating the step would have shown it twice.
    expect(chunks).toEqual(["half an answer"]);
    expect(client.requests).toHaveLength(1);
    expect(assistantSteps(session)).toEqual([]);
  });

  it("retries a step that failed after assembling a tool call", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const tools = createToolRegistry();
    const echo = createEchoTool();
    tools.register(echo);
    const client = createFakeModelClient([
      replyThenFail(
        [{ type: "tool-call", call: { callId: "call-1", name: "echo", input: { text: "one" } } }],
        new Error("connection reset"),
      ),
      answerReply("recovered"),
    ]);

    const outcome = await loopFor(client, tools).runTurn({ session, turnId: TURN, context });

    expect(outcome).toEqual({ reason: "completed", text: "recovered" });
    expect(client.requests).toHaveLength(2);
    // A tool call is only a fact once its step completes, so the one that died with
    // its stream was never recorded and never executed.
    expect(echo.calls).toEqual([]);
    expect(toolResults(session)).toEqual([]);
    expect(assistantSteps(session)).toEqual([{ text: "recovered", toolCalls: [] }]);
  });

  it("answers a recorded call even when the tool path itself throws", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    // A registry that breaks the contract it was handed: a recorded call still gets
    // an answer, because the other side of the log cannot be left hanging.
    const exploding: ToolRegistry = {
      register: () => () => {},
      get: () => undefined,
      list: () => [],
      async execute() {
        throw new Error("registry exploded");
      },
    };
    const client = createFakeModelClient([
      [{ type: "tool-call", call: { callId: "call-1", name: "echo", input: {} } }, { type: "done" }],
      answerReply("recovered"),
    ]);

    const outcome = await loopFor(client, exploding).runTurn({ session, turnId: TURN, context });

    expect(outcome).toEqual({ reason: "completed", text: "recovered" });
    expect(toolResults(session)).toEqual([
      { callId: "call-1", name: "echo", ok: false, content: "registry exploded" },
    ]);
    expect(unsettledToolCalls(session)).toEqual([]);
  });

  it("treats a reply with no content as a failed attempt", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const client = createFakeModelClient([[], [{ type: "done" }], answerReply("recovered")]);

    const outcome = await loopFor(client, createToolRegistry()).runTurn({ session, turnId: TURN, context });

    expect(outcome).toEqual({ reason: "completed", text: "recovered" });
    expect(client.requests).toHaveLength(MAX_MODEL_ATTEMPTS);
  });

  it("fails the step when the model never says anything", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const client = createFakeModelClient([[], [], []]);

    const outcome = await loopFor(client, createToolRegistry()).runTurn({ session, turnId: TURN, context });

    expect(outcome.reason).toBe("error");
    expect(outcome.error).toContain("no output");
    expect(client.requests).toHaveLength(MAX_MODEL_ATTEMPTS);
  });

  it("reports a Core failure as an error outcome instead of throwing", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const loop = createAgentLoop({
      modelClient: createFakeModelClient([answerReply("never reached")]),
      tools: createToolRegistry(),
      contextBuilder: {
        build: async () => {
          throw new Error("context builder exploded");
        },
        getFixedContext: () => ({ tools: [] }),
      },
    });

    const outcome = await loop.runTurn({ session, turnId: TURN, context });

    expect(outcome).toEqual({ reason: "error", text: "", error: "context builder exploded" });
    expect(assistantSteps(session)).toEqual([]);
  });
});

describe("AgentLoop cancellation", () => {
  it("makes no model call when the turn starts already aborted", async () => {
    const session = createSession("s-1");
    openTurn(session, "too late");
    const abort = new AbortController();
    abort.abort();
    const client = createFakeModelClient([answerReply("never reached")]);

    const outcome = await loopFor(client, createToolRegistry()).runTurn({
      session,
      turnId: TURN,
      context: abortableContext(abort.signal),
    });

    expect(outcome).toEqual({ reason: "cancelled", text: "" });
    expect(client.requests).toEqual([]);
    expect(session.events().map((event) => event.type)).toEqual(["turn/start", "message/user"]);
  });

  it("stops consuming the model stream as soon as the signal aborts", async () => {
    const session = createSession("s-1");
    openTurn(session, "stop mid answer");
    const abort = new AbortController();
    const chunks: string[] = [];
    const client = createFakeModelClient([
      async function* (): AsyncGenerator<ModelEvent> {
        yield { type: "text-delta", text: "first" };
        abort.abort();
        yield { type: "text-delta", text: "second" };
      },
    ]);

    const outcome = await loopFor(client, createToolRegistry()).runTurn({
      session,
      turnId: TURN,
      context: abortableContext(abort.signal),
      emit: (event: AgentLoopEvent) => {
        if (event.type === "assistant/chunk") chunks.push(event.text);
      },
    });

    expect(outcome).toEqual({ reason: "cancelled", text: "" });
    // The delta after the abort is never processed, and the aborted step is not
    // recorded: half of a step is not a fact about the conversation.
    expect(chunks).toEqual(["first"]);
    expect(assistantSteps(session)).toEqual([]);
  });

  it("cancels a step the model client ends quietly after an abort", async () => {
    const session = createSession("s-1");
    openTurn(session, "quiet abort");
    const abort = new AbortController();
    const client = createFakeModelClient([
      async function* (): AsyncGenerator<ModelEvent> {
        // A client that honours the signal by stopping: no throw, no `done`.
        abort.abort();
      },
    ]);

    const outcome = await loopFor(client, createToolRegistry()).runTurn({
      session,
      turnId: TURN,
      context: abortableContext(abort.signal),
    });

    // A silently ended stream is normally a complete step; under an abort it is a
    // cancellation, never an empty answer.
    expect(outcome).toEqual({ reason: "cancelled", text: "" });
  });

  it("settles the tool calls of a step the turn was cancelled inside", async () => {
    const session = createSession("s-1");
    openTurn(session, "two tools");
    const abort = new AbortController();
    const ran: string[] = [];
    const tools = createToolRegistry();
    tools.register({
      name: "first",
      description: "Runs once and then cancels the turn.",
      inputSchema: { type: "object" },
      async execute() {
        ran.push("first");
        abort.abort();
        return "first result";
      },
    });
    const echo = createEchoTool();
    tools.register(echo);
    const client = createFakeModelClient([
      [
        { type: "tool-call", call: { callId: "call-1", name: "first", input: {} } },
        { type: "tool-call", call: { callId: "call-2", name: "echo", input: { text: "never" } } },
        { type: "done" },
      ],
    ]);

    const outcome = await loopFor(client, tools).runTurn({
      session,
      turnId: TURN,
      context: abortableContext(abort.signal),
    });

    expect(outcome).toEqual({ reason: "cancelled", text: "" });
    expect(ran).toEqual(["first"]);
    // The call the cancellation caught is recorded as unanswered-but-settled, so the
    // history stays one a provider will accept.
    expect(echo.calls).toEqual([]);
    expect(toolResults(session)).toEqual([
      { callId: "call-1", name: "first", ok: true, content: "first result" },
      {
        callId: "call-2",
        name: "echo",
        ok: false,
        content: "tool not executed: the turn was cancelled",
      },
    ]);
    expect(unsettledToolCalls(session)).toEqual([]);
  });

  it("keeps a tool's own failure as an observation and still closes as cancelled", async () => {
    const session = createSession("s-1");
    openTurn(session, "slow tool");
    const abort = new AbortController();
    const tools = createToolRegistry();
    tools.register({
      name: "slow",
      description: "Fails the way a tool that honours the signal does.",
      inputSchema: { type: "object" },
      async execute() {
        abort.abort();
        throw new Error("The operation was aborted");
      },
    });
    const client = createFakeModelClient([
      [{ type: "tool-call", call: { callId: "call-1", name: "slow", input: {} } }, { type: "done" }],
    ]);

    const outcome = await loopFor(client, tools).runTurn({
      session,
      turnId: TURN,
      context: abortableContext(abort.signal),
    });

    // A tool that fails is an observation for the model, never a runtime error...
    expect(toolResults(session)).toEqual([
      { callId: "call-1", name: "slow", ok: false, content: "The operation was aborted" },
    ]);
    // ...and the turn it was running in was cancelled, not failed.
    expect(outcome).toEqual({ reason: "cancelled", text: "" });
    expect(unsettledToolCalls(session)).toEqual([]);
  });
});
