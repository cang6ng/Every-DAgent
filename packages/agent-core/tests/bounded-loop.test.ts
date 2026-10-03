/**
 * M2's loop half: what the Core does with a request before it is sent, and what
 * a retry is allowed to re-decide.
 *
 * These are the tests of the contract between a builder and the loop — one
 * frozen request per step, one independent check per attempt, and a budget
 * nothing reaches past — and they are separate from the resource tests because
 * the two answer different questions: this file is about *what is sent*, and
 * that one is about *what a turn may hold*.
 */

import { describe, expect, it } from "vitest";

import type { ContextBuilder } from "../src/context/context-builder.js";
import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import { DEFAULT_MODEL_FRAMING } from "../src/context/model-budget.js";
import type { ModelLimits } from "../src/context/model-budget.js";
import { NonRetryableModelError } from "../src/errors.js";
import { createAgentLoop } from "../src/loop/agent-loop.js";
import type { ModelClient, ModelEvent, ModelRequest } from "../src/model/model-client.js";
import type { RuntimeContext } from "../src/runtime/runtime-context.js";
import { createSession } from "../src/session/session.js";
import type { Session } from "../src/session/session.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import type { Tool } from "../src/tools/tool.js";
import { createFakeModelClient } from "./helpers/fake-model-client.js";
import { TEST_MODEL_LIMITS } from "./helpers/test-model-limits.js";

const TURN = "turn-1";
const context: RuntimeContext = { sessionId: "session-1", signal: new AbortController().signal };

function openTurn(session: Session, text = "hi"): void {
  session.append({ type: "turn/start", turnId: TURN, data: {} });
  session.append({ type: "message/user", turnId: TURN, data: { text } });
}

function loopFor(modelClient: ModelClient, tools = createToolRegistry()) {
  return createAgentLoop({ modelClient, tools, contextBuilder: createDefaultContextBuilder() });
}

function answer(text: string): ModelEvent[] {
  return [{ type: "text-delta", text }, { type: "done" }];
}

function call(name: string, input: unknown, callId = "call-1"): ModelEvent {
  return { type: "tool-call", call: { callId, name, input } };
}

/**
 * A capability whose whole input budget is `maxInputCost`.
 *
 * The loop's tests are about the *model* budget, and a 128k window cannot be
 * crossed by a test fixture. This one is small enough that one appended message
 * decides it.
 */
function tightLimits(maxInputCost: number): ModelLimits {
  return {
    contextWindow: maxInputCost + 1024 + 1024,
    maxOutputTokens: 1024,
    framing: DEFAULT_MODEL_FRAMING,
  };
}

function valueTool(name: string, value: unknown, log: string[] = []): Tool {
  return {
    name,
    description: `Returns a fixed value for ${name}.`,
    inputSchema: { type: "object" },
    async execute() {
      log.push(name);
      return value;
    },
  };
}

describe("AgentLoop bounding", () => {
  function countingBuilder(inner: ContextBuilder): { builder: ContextBuilder; builds: () => number } {
    let builds = 0;
    return {
      builds: () => builds,
      builder: {
        getFixedContext: (input) => inner.getFixedContext(input),
        build: async (input) => {
          builds += 1;
          return inner.build(input);
        },
      },
    };
  }

  it("builds once per step and guards before every attempt", async () => {
    const session = createSession("s-1");
    openTurn(session, "echo please");
    const tools = createToolRegistry();
    tools.register(valueTool("echo", "hi"));
    const counting = countingBuilder(createDefaultContextBuilder());
    // The first attempt produces nothing, so the loop retries inside the step.
    const client = createFakeModelClient([
      [],
      [call("echo", { text: "hi" }), { type: "done" }],
      answer("done"),
    ]);
    const loop = createAgentLoop({ modelClient: client, tools, contextBuilder: counting.builder });

    const outcome = await loop.runTurn({ session, turnId: TURN, context });

    expect(outcome).toEqual({ reason: "completed", text: "done" });
    // Two steps, two builds — a retry never rebuilds.
    expect(counting.builds()).toBe(2);
    // The retried step sent the very same frozen request.
    expect(client.requests[0]).toBe(client.requests[1]);
    expect(Object.isFrozen(client.requests[0])).toBe(true);
  });

  it("re-proves the request before each retry, not once per step", async () => {
    const session = createSession("s-1");
    openTurn(session);
    // The budget fits the first request with room to spare, and little else:
    // one appended message is enough to put the retry over.
    const inner = createFakeModelClient([[], answer("never reached")], { limits: tightLimits(500) });
    const asked: ModelRequest[] = [];
    const watching: ModelClient = {
      limits: inner.limits,
      stream(request, runtime): AsyncIterable<ModelEvent> {
        asked.push(request);
        // A model that changes the conversation and then produces nothing: the
        // retry's own guard is what sees the change, before the provider would.
        session.append({ type: "message/user", turnId: TURN, data: { text: "x".repeat(4000) } });
        return inner.stream(request, runtime);
      },
    };

    const outcome = await loopFor(watching, createToolRegistry()).runTurn({ session, turnId: TURN, context });

    // The retry was refused by the Core's own guard — by the budget, by the
    // current turn no longer being the one the frozen request carries, or by
    // both — and what matters is that it was refused before the provider.
    expect(outcome.reason).toBe("error");
    expect(outcome.error).toMatch(/context budget|current turn/);
    expect(asked).toHaveLength(1);
    expect(inner.requests).toHaveLength(1);
  });

  it("sees a tool registered between two steps on the next step", async () => {
    const session = createSession("s-1");
    openTurn(session);
    const tools = createToolRegistry();
    tools.register(valueTool("first", "one"));
    const client: ModelClient = {
      limits: TEST_MODEL_LIMITS,
      stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        const names = request.tools.map((tool) => tool.name);
        return (async function* (): AsyncGenerator<ModelEvent> {
          if (names.includes("second")) {
            yield { type: "text-delta", text: "the registry grew" };
            yield { type: "done" };
            return;
          }
          tools.register(valueTool("second", "two"));
          yield call("first", {});
          yield { type: "done" };
        })();
      },
    };

    const outcome = await loopFor(client, tools).runTurn({ session, turnId: TURN, context });

    expect(outcome).toEqual({ reason: "completed", text: "the registry grew" });
  });

  it("makes no model call when the fixed context alone exceeds the budget", async () => {
    const session = createSession("s-1");
    openTurn(session);
    const tools = createToolRegistry();
    tools.register({
      name: "huge",
      description: "x".repeat(8000),
      inputSchema: { type: "object" },
      async execute() {
        return null;
      },
    });
    const client = createFakeModelClient([answer("never reached")], { limits: tightLimits(300) });

    const outcome = await loopFor(client, tools).runTurn({ session, turnId: TURN, context });

    expect(outcome.reason).toBe("error");
    expect(outcome.error).toContain("context budget");
    expect(client.requests).toEqual([]);
  });

  it("blocks a custom builder whose request is legal but too large", async () => {
    const session = createSession("s-1");
    openTurn(session);
    // The budget is roomy enough that the builder's own selection succeeds, and
    // too small for what the builder then adds on top of it: only the guard,
    // looking at the request that is really about to be sent, can catch this.
    const limits = tightLimits(500);
    const base = createDefaultContextBuilder();
    const client = createFakeModelClient([answer("never reached")], { limits });
    const loop = createAgentLoop({
      modelClient: client,
      tools: createToolRegistry(),
      contextBuilder: {
        getFixedContext: (input) => base.getFixedContext(input),
        build: async (input) => {
          const request = await base.build(input);
          return { ...request, messages: [{ role: "user" as const, text: "x".repeat(300) }, ...request.messages] };
        },
      },
    });

    const outcome = await loop.runTurn({ session, turnId: TURN, context });

    expect(outcome.reason).toBe("error");
    expect(outcome.error).toContain("context budget");
    expect(client.requests).toEqual([]);
  });

  it("blocks a custom builder that deletes the current user input", async () => {
    const session = createSession("s-1");
    openTurn(session, "the real question");
    const base = createDefaultContextBuilder();
    const client = createFakeModelClient([answer("never reached")]);
    const loop = createAgentLoop({
      modelClient: client,
      tools: createToolRegistry(),
      contextBuilder: {
        getFixedContext: (input) => base.getFixedContext(input),
        build: async (input) => ({ ...(await base.build(input)), messages: [] }),
      },
    });

    const outcome = await loop.runTurn({ session, turnId: TURN, context });

    expect(outcome.reason).toBe("error");
    expect(outcome.error).toContain("current turn");
    expect(client.requests).toEqual([]);
  });

  it("does not retry a deterministic failure", async () => {
    const session = createSession("s-1");
    openTurn(session);
    let attempts = 0;
    const client: ModelClient = {
      limits: TEST_MODEL_LIMITS,
      stream(): AsyncIterable<ModelEvent> {
        attempts += 1;
        return (async function* (): AsyncGenerator<ModelEvent> {
          throw new NonRetryableModelError("this failure will not change");
          yield { type: "done" };
        })();
      },
    };

    const outcome = await loopFor(client, createToolRegistry()).runTurn({ session, turnId: TURN, context });

    expect(outcome.reason).toBe("error");
    expect(outcome.error).toBe("this failure will not change");
    expect(attempts).toBe(1);
  });

  it("still retries an ordinary failure that produced nothing", async () => {
    const session = createSession("s-1");
    openTurn(session);
    const client = createFakeModelClient([[], [], answer("third time")]);

    const outcome = await loopFor(client, createToolRegistry()).runTurn({ session, turnId: TURN, context });

    expect(outcome).toEqual({ reason: "completed", text: "third time" });
    expect(client.requests).toHaveLength(3);
  });
});

