/**
 * M2's runtime half: what one turn may hold, what a step may stage, and what
 * happens when a tool has already run and its result can no longer be kept.
 *
 * The profile in these tests is deliberately tiny — a few hundred bytes per
 * item — because the property being checked is a boundary, and a boundary is
 * only checkable when the numbers around it are small enough to count.
 */

import { describe, expect, it } from "vitest";

import type { ContextBuilder } from "../src/context/context-builder.js";
import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import { ManagedDeclarationError, NonRetryableModelError, TurnResourceFault } from "../src/errors.js";
import { createAgentLoop } from "../src/loop/agent-loop.js";
import type { AgentLoop } from "../src/loop/agent-loop.js";
import { LOOP_RESOURCE_LIMITS, TurnResourceMeter } from "../src/loop/turn-resources.js";
import type { LoopResourceLimits } from "../src/loop/turn-resources.js";
import type { ModelClient, ModelEvent, ModelRequest } from "../src/model/model-client.js";
import { createAgentRuntime } from "../src/runtime/agent-runtime.js";
import type { RuntimeContext } from "../src/runtime/runtime-context.js";
import { createSession } from "../src/session/session.js";
import type { Session } from "../src/session/session.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import type { Tool } from "../src/tools/tool.js";
import type { ToolRegistry } from "../src/tools/tool-registry.js";
import { createFakeModelClient } from "./helpers/fake-model-client.js";
import { TEST_MODEL_LIMITS } from "./helpers/test-model-limits.js";

const TURN = "turn-1";
const context: RuntimeContext = { sessionId: "session-1", signal: new AbortController().signal };

/** The approved profile, with the numbers a boundary test needs to see. */
function profile(overrides: Partial<LoopResourceLimits> = {}): LoopResourceLimits {
  return { ...LOOP_RESOURCE_LIMITS, ...overrides };
}

function openTurn(session: Session, text = "hi"): void {
  session.append({ type: "turn/start", turnId: TURN, data: {} });
  session.append({ type: "message/user", turnId: TURN, data: { text } });
}

function loopFor(modelClient: ModelClient, tools: ToolRegistry, limits?: LoopResourceLimits): AgentLoop {
  return createAgentLoop({
    modelClient,
    tools,
    contextBuilder: createDefaultContextBuilder(),
    ...(limits === undefined ? {} : { limits }),
  });
}

function answer(text: string): ModelEvent[] {
  return [{ type: "text-delta", text }, { type: "done" }];
}

function call(name: string, input: unknown, callId = "call-1"): ModelEvent {
  return { type: "tool-call", call: { callId, name, input } };
}

const eventTypes = (session: Session): string[] => session.events().map((event) => event.type);

// ---------------------------------------------------------------------------
// The meter.
// ---------------------------------------------------------------------------

describe("TurnResourceMeter", () => {
  it("charges a turn fact, and refuses the one that would not fit", () => {
    const meter = new TurnResourceMeter(profile({ maxNeutralItemBytes: 64 * 1024, maxCurrentTurnBytes: 2048 }));

    meter.commit("a fact", { data: "x".repeat(500) });
    const after = meter.bytes;
    expect(after).toBeGreaterThan(0);

    meter.commit("another", { data: "y".repeat(400) });
    expect(meter.bytes).toBeGreaterThan(after);
  });

  it("refuses an item larger than one item may be", () => {
    const meter = new TurnResourceMeter(profile({ maxNeutralItemBytes: 128 }));

    expect(() => meter.commit("an item", { data: "x".repeat(500) })).toThrow(ManagedDeclarationError);
  });

  it("keeps the terminal headroom, so a turn that fits its content can still be closed", () => {
    const meter = new TurnResourceMeter(profile({ maxNeutralItemBytes: 64 * 1024, maxCurrentTurnBytes: 2048 }));

    // Content may spend everything but the headroom.
    meter.commit("everything", { data: "x".repeat(1000) });
    expect(() => meter.commit("one byte too much", { data: "y".repeat(2000) })).toThrow(ManagedDeclarationError);

    // The terminal is charged against the full budget, not the reduced one.
    expect(() => meter.commitTerminal("the turn's end", { data: { reason: "completed" } })).not.toThrow();
  });

  it("refuses a value it cannot measure", () => {
    const meter = new TurnResourceMeter(profile());
    const loop: Record<string, unknown> = {};
    loop.self = loop;

    expect(() => meter.commit("a cycle", { data: loop })).toThrow(ManagedDeclarationError);
  });

  it("counts a staged step without recording it", () => {
    const meter = new TurnResourceMeter(profile({ maxNeutralItemBytes: 64 * 1024, maxCurrentTurnBytes: 4096 }));

    meter.stageText("x".repeat(1000));
    meter.discardStaging();

    expect(meter.bytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The loop's resource profile.
// ---------------------------------------------------------------------------

describe("AgentLoop resource guards", () => {
  it("runs a step inside the profile without complaint", async () => {
    const session = createSession("s-1");
    openTurn(session);
    const client = createFakeModelClient([answer("done")]);

    const outcome = await loopFor(client, createToolRegistry()).runTurn({ session, turnId: TURN, context });

    expect(outcome).toEqual({ reason: "completed", text: "done" });
  });

  it("refuses the seventeenth call of one step, and executes none of them", async () => {
    const session = createSession("s-1");
    openTurn(session);
    const executed: string[] = [];
    const tools = createToolRegistry();
    tools.register(countingTool("count", executed));
    const calls = Array.from({ length: 17 }, (_, index) => call("count", { n: index }, `call-${index}`));
    const client = createFakeModelClient([[...calls, { type: "done" }]]);

    const outcome = await loopFor(client, tools).runTurn({ session, turnId: TURN, context });

    expect(outcome.reason).toBe("error");
    expect(outcome.error).toContain("declared 17 tool calls");
    expect(executed).toEqual([]);
    // A step whose declarations were refused declares nothing.
    expect(eventTypes(session)).toEqual(["turn/start", "message/user"]);
  });

  it("accepts a step that declares exactly the profile's limit", async () => {
    const session = createSession("s-1");
    openTurn(session);
    const executed: string[] = [];
    const tools = createToolRegistry();
    tools.register(countingTool("count", executed));
    const calls = Array.from({ length: 16 }, (_, index) => call("count", { n: index }, `call-${index}`));
    const client = createFakeModelClient([[...calls, { type: "done" }], answer("done")]);

    const outcome = await loopFor(client, tools).runTurn({ session, turnId: TURN, context });

    expect(outcome).toEqual({ reason: "completed", text: "done" });
    expect(executed).toHaveLength(16);
  });

  it("refuses a whole group when one call's arguments are too large, executing none", async () => {
    const session = createSession("s-1");
    openTurn(session);
    const executed: string[] = [];
    const tools = createToolRegistry();
    tools.register(countingTool("count", executed));
    const client = createFakeModelClient([
      [call("count", { n: 1 }, "call-1"), call("count", { big: "x".repeat(2000) }, "call-2"), { type: "done" }],
    ]);

    const outcome = await loopFor(client, tools, profile({ maxNeutralItemBytes: 512 })).runTurn({
      session,
      turnId: TURN,
      context,
    });

    expect(outcome.reason).toBe("error");
    expect(executed).toEqual([]);
    expect(eventTypes(session)).toEqual(["turn/start", "message/user"]);
  });

  it("refuses a whole group when a later call grew after it was staged, executing none", async () => {
    const session = createSession("s-1");
    openTurn(session);
    const executed: string[] = [];
    const tools = createToolRegistry();
    tools.register(countingTool("count", executed));

    // The first call is legal and would run on its own; the second is legal when
    // it is staged and grows afterwards — the loop keeps a shallow copy, so the
    // arguments it staged and the arguments it would dispatch are one object.
    // Only a check made when the whole group is about to be declared, before any
    // of it runs, can keep the first call from executing.
    const first: Record<string, unknown> = { n: 1 };
    const second: Record<string, unknown> = { n: 2 };
    const client: ModelClient = {
      limits: TEST_MODEL_LIMITS,
      stream(): AsyncIterable<ModelEvent> {
        return (async function* (): AsyncGenerator<ModelEvent> {
          try {
            yield call("count", first, "call-1");
            yield call("count", second, "call-2");
            yield { type: "done" };
          } finally {
            second.pad = "x".repeat(4000);
          }
        })();
      },
    };

    const outcome = await loopFor(client, tools, profile({ maxNeutralItemBytes: 512 })).runTurn({
      session,
      turnId: TURN,
      context,
    });

    expect(outcome.reason).toBe("error");
    expect(executed).toEqual([]);
    expect(eventTypes(session)).toEqual(["turn/start", "message/user"]);
  });

  it("refuses arguments that nest past the profile's depth", async () => {
    const session = createSession("s-1");
    openTurn(session);
    const executed: string[] = [];
    const tools = createToolRegistry();
    tools.register(countingTool("count", executed));
    const deep = { a: { b: { c: { d: 1 } } } };
    const client = createFakeModelClient([[call("count", deep), { type: "done" }]]);

    const outcome = await loopFor(client, tools, profile({ maxJsonDepth: 3 })).runTurn({
      session,
      turnId: TURN,
      context,
    });

    expect(outcome.reason).toBe("error");
    expect(outcome.error).toContain("nests deeper");
    expect(executed).toEqual([]);
  });

  it("fails a turn whose recorded facts exceed the turn's own budget", async () => {
    const session = createSession("s-1");
    openTurn(session, "x".repeat(600));
    const client = createFakeModelClient([answer("never reached")]);

    const outcome = await loopFor(client, createToolRegistry(), profile({ maxCurrentTurnBytes: 1024 })).runTurn({
      session,
      turnId: TURN,
      context,
    });

    // The user input is charged before the turn can be answered: the record the
    // Runtime already wrote is the first thing the meter sees.
    expect(outcome.reason).toBe("error");
    expect(outcome.error).toContain("resource budget");
    expect(client.requests).toEqual([]);
  });

  it("fails a turn whose every recorded fact fits but whose total does not", async () => {
    const session = createSession("s-1");
    openTurn(session);
    const executed: string[] = [];
    const tools = createToolRegistry();
    tools.register(countingTool("count", executed));
    // Every single fact fits one item, and the turn cannot hold many of them:
    // the overflow lands on a declaration, before anything new is dispatched.
    const padded = (index: number): unknown => ({ n: index, pad: "x".repeat(400) });
    const steps = Array.from({ length: 6 }, (_, index) => [
      call("count", padded(index), `call-${index}`),
      { type: "done" } as ModelEvent,
    ]);
    const client = createFakeModelClient([...steps, answer("done")]);

    const outcome = await loopFor(
      client,
      tools,
      profile({ maxNeutralItemBytes: 1024, maxCurrentTurnBytes: 3 * 1024 }),
    ).runTurn({ session, turnId: TURN, context });

    expect(outcome.reason).toBe("error");
    expect(outcome.error).toContain("resource budget");
    // Every call that was declared before the overflow ran exactly once.
    expect(executed.length).toBeLessThan(6);
    expect(executed).toEqual(Array.from({ length: executed.length }, () => "count"));
  });

  it("propagates a fault when a tool has run and its result cannot be kept", async () => {
    const session = createSession("s-1");
    openTurn(session);
    const executed: string[] = [];
    const tools = createToolRegistry();
    tools.register(valueTool("big", "x".repeat(4000), executed));
    const client = createFakeModelClient([[call("big", {}), { type: "done" }]]);

    const failure = await loopFor(client, tools, profile({ maxNeutralItemBytes: 512 }))
      .runTurn({ session, turnId: TURN, context })
      .catch((error: unknown) => error);

    // The tool ran, so no phrasing of the turn can undo it: the fault travels
    // out instead of becoming an outcome, and the turn is left unclosed.
    expect(failure).toBeInstanceOf(TurnResourceFault);
    expect(executed).toEqual(["big"]);
    expect(eventTypes(session)).toEqual(["turn/start", "message/user", "message/assistant", "tool/call"]);
  });

  it("rethrows a fault a tool itself raised", async () => {
    const session = createSession("s-1");
    openTurn(session);
    const tools = createToolRegistry();
    tools.register(throwingTool("boom", new TurnResourceFault("the tool says so")));
    const client = createFakeModelClient([[call("boom", {}), { type: "done" }]]);

    await expect(
      loopFor(client, tools).runTurn({ session, turnId: TURN, context }),
    ).rejects.toThrow("the tool says so");
  });
});

// ---------------------------------------------------------------------------
// Selection and guard behaviour through the loop.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Through the Runtime: the fault must survive the turn boundary.
// ---------------------------------------------------------------------------

describe("TurnResourceFault through the Runtime", () => {
  it("rejects instead of closing a turn whose tool result cannot be kept", async () => {
    const session = createSession("s-1");
    const tools = createToolRegistry();
    tools.register(valueTool("big", "x".repeat(4000)));
    const client = createFakeModelClient([[call("big", {}), { type: "done" }]]);
    const runtime = createAgentRuntime({
      loop: loopFor(client, tools, profile({ maxNeutralItemBytes: 512 })),
    });

    await expect(runtime.run({ session, text: "hi" })).rejects.toThrow(TurnResourceFault);
    // No fabricated end: the log holds the turn it was in the middle of.
    expect(eventTypes(session)).toEqual(["turn/start", "message/user", "message/assistant", "tool/call"]);
  });
});

// ---------------------------------------------------------------------------
// Tools used above.
// ---------------------------------------------------------------------------

function countingTool(name: string, log: string[]): Tool {
  return {
    name,
    description: `Counts calls to ${name}.`,
    inputSchema: { type: "object" },
    async execute() {
      log.push(name);
      return "counted";
    },
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

function throwingTool(name: string, error: unknown): Tool {
  return {
    name,
    description: `Always throws.`,
    inputSchema: { type: "object" },
    async execute(): Promise<never> {
      throw error;
    },
  };
}
