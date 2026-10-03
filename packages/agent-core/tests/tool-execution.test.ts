/**
 * M4's Core half: the prepared-execution seam, the registry's generation and
 * binding, and the ownership rules an argument must survive.
 *
 * These are Core-level facts — what a registry is, what a boundary is allowed
 * to hand back, what the loop records — and every host-level guarantee builds
 * on them. The host's own acceptance lives with the host; this file proves the
 * machinery underneath it.
 */

import { describe, expect, it } from "vitest";

import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import { ownJsonValue, stableJSON } from "../src/context/stable-json.js";
import { ManagedDeclarationError } from "../src/errors.js";
import { createAgentLoop } from "../src/loop/agent-loop.js";
import type { ToolCall } from "../src/model/message.js";
import type { ModelClient, ModelEvent } from "../src/model/model-client.js";
import type { RuntimeContext } from "../src/runtime/runtime-context.js";
import type { SessionEvent } from "../src/session/session-event.js";
import { createSession } from "../src/session/session.js";
import type { Session } from "../src/session/session.js";
import type {
  PreparedDispatchOutcome,
  PreparedToolExecution,
  PrepareToolBatchInput,
  ToolExecutionBoundary,
} from "../src/tools/tool-execution.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import type { ToolRegistry } from "../src/tools/tool-registry.js";
import type { Tool, ToolExecutionResult } from "../src/tools/tool.js";
import { createFakeModelClient } from "./helpers/fake-model-client.js";

const TURN = "turn-1";
const context: RuntimeContext = { sessionId: "session-1", signal: new AbortController().signal };

function openTurn(session: Session, text: string): void {
  session.append({ type: "turn/start", turnId: TURN, data: {} });
  session.append({ type: "message/user", turnId: TURN, data: { text } });
}

function toolFrom(
  name: string,
  execute: (input: unknown, context: RuntimeContext) => Promise<unknown>,
): Tool {
  return { name, description: `The ${name} tool.`, inputSchema: { type: "object" }, execute };
}

function loopFor(
  modelClient: ModelClient,
  tools: ToolRegistry,
  executionBoundary?: ToolExecutionBoundary,
): ReturnType<typeof createAgentLoop> {
  return createAgentLoop({
    modelClient,
    tools,
    contextBuilder: createDefaultContextBuilder(),
    ...(executionBoundary === undefined ? {} : { executionBoundary }),
  });
}

function eventsOf(session: Session): readonly SessionEvent[] {
  return session.events();
}

// ---------------------------------------------------------------------------
// Generation: what counts as a mapping change.
// ---------------------------------------------------------------------------

describe("ToolRegistry generation", () => {
  it("counts successful registrations and deletions, and nothing else", () => {
    const registry = createToolRegistry();
    expect(registry.generation).toBe(0);

    const dispose = registry.register(toolFrom("echo", async () => "ok"));
    expect(registry.generation).toBe(1);

    // A duplicate and a refused registration change nothing.
    expect(() => registry.register(toolFrom("echo", async () => "other"))).toThrow();
    expect(registry.generation).toBe(1);

    dispose();
    expect(registry.generation).toBe(2);

    // A second call of the same disposer is not a second deletion.
    dispose();
    expect(registry.generation).toBe(2);

    // A stale disposer that deletes nothing is not a change either.
    const first = registry.register(toolFrom("echo", async () => "first"));
    first();
    const replacement = toolFrom("echo", async () => "second");
    registry.register(replacement);
    expect(registry.generation).toBe(5);
    first();
    expect(registry.generation).toBe(5);
    expect(registry.get("echo")).toBe(replacement);
  });

  it("disposes by the key it registered under, not by a later tool.name", () => {
    const registry = createToolRegistry();
    const tool = toolFrom("echo", async () => "ok");
    const dispose = registry.register(tool);

    // A tool that renames itself must not be able to make its own disposer
    // delete a different registration — or nothing at all.
    (tool as { name: string }).name = "renamed";
    dispose();

    expect(registry.get("echo")).toBeUndefined();
    expect(registry.get("renamed")).toBeUndefined();
    expect(registry.generation).toBe(2);
  });

  it("captures the concrete executor and its receiver at registration", async () => {
    const registry = createToolRegistry();
    let calls = 0;
    const tool = {
      name: "echo",
      description: "The echo tool.",
      inputSchema: { type: "object" },
      marker: "the one I was registered as",
      async execute(this: { marker: string }, input: unknown): Promise<unknown> {
        calls += 1;
        return `${this.marker}:${String(input)}`;
      },
    };
    registry.register(tool as unknown as Tool);

    // Replacing the property after registration does not redirect a dispatch:
    // the executor was taken over when the tool was taken over.
    (tool as { execute: unknown }).execute = async () => {
      throw new Error("a replacement that must never run");
    };

    const result = await registry.execute("echo", "x", context);
    expect(result).toEqual({ ok: true, value: "the one I was registered as:x" });
    expect(calls).toBe(1);

    const registration = registry.registration("echo");
    expect(registration?.key).toBe("echo");
    expect(registration?.tool).toBe(tool);
    await expect(registration?.invoke("y", context)).resolves.toBe("the one I was registered as:y");
  });

  it("gives every registration its own identity", () => {
    const registry = createToolRegistry();
    registry.register(toolFrom("echo", async () => "ok"));
    const first = registry.registration("echo");
    registry.register(toolFrom("other", async () => "ok"));
    const second = registry.registration("echo");

    expect(first?.identity).toBeDefined();
    expect(first?.identity).toBe(second?.identity);
    expect(first?.identity).not.toBe(second?.tool);
  });
});

// ---------------------------------------------------------------------------
// Ownership: a cloned value keeps every legal JSON key.
// ---------------------------------------------------------------------------

describe("JSON ownership", () => {
  it("keeps an own __proto__ key as data instead of letting it become the prototype", () => {
    const source: Record<string, unknown> = {};
    Object.defineProperty(source, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    source["plain"] = 1;

    const owned = ownJsonValue(source, "a test value") as Record<string, unknown>;

    expect(Object.getPrototypeOf(owned)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(owned, "__proto__")).toBe(true);
    expect(owned["__proto__"]).toEqual({ polluted: true });
    // The dangerous reading: if the key had gone through the setter, the copy's
    // prototype would be the payload and reading it back would see the key
    // itself as an inherited property.
    expect((owned as { polluted?: boolean }).polluted).toBeUndefined();
    expect(stableJSON(owned)).toBe(stableJSON(source));
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("keeps a nested null-prototype object's keys", () => {
    const nested = Object.create(null) as Record<string, unknown>;
    nested["keep"] = "me";
    const source = { outer: nested };

    const owned = ownJsonValue(source, "a test value") as { outer: Record<string, unknown> };

    expect(owned.outer["keep"]).toBe("me");
    expect(JSON.stringify(owned)).toBe('{"outer":{"keep":"me"}}');
  });

  it("still refuses accessors rather than running them", () => {
    let ran = 0;
    const source = {
      get trap() {
        ran += 1;
        return 1;
      },
    };

    expect(() => ownJsonValue(source, "a test value")).toThrow();
    expect(ran).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The managed loop: whole-group preparation and what it records.
// ---------------------------------------------------------------------------

/** A boundary that prepares every call it is given, with test-visible bookkeeping. */
function testBoundary(options: {
  readonly outcome?: (prepared: PreparedToolExecution) => PreparedDispatchOutcome;
  readonly refuse?: (input: PrepareToolBatchInput) => string | undefined;
}): {
  readonly boundary: ToolExecutionBoundary;
  readonly batches: PrepareToolBatchInput[];
  readonly executed: PreparedToolExecution[];
} {
  const batches: PrepareToolBatchInput[] = [];
  const executed: PreparedToolExecution[] = [];
  let counter = 0;

  const boundary: ToolExecutionBoundary = {
    prepareBatch(input: PrepareToolBatchInput): readonly PreparedToolExecution[] {
      batches.push(input);
      const refusal = options.refuse?.(input);
      if (refusal !== undefined) throw new ManagedDeclarationError(refusal);
      return input.calls.map((call, callIndex) => {
        counter += 1;
        return Object.freeze({
          executionId: `exec-${counter}`,
          call: Object.freeze({ callId: call.callId, name: call.name, input: call.input }),
          position: { turnId: input.position.turnId, stepIndex: input.position.stepIndex, callIndex },
          registryGeneration: 1,
        });
      });
    },
    async executePrepared(prepared: PreparedToolExecution): Promise<PreparedDispatchOutcome> {
      executed.push(prepared);
      return (
        options.outcome?.(prepared) ?? {
          executed: true,
          result: { ok: true, value: `ran ${prepared.call.name}` },
        }
      );
    },
  };

  return { boundary, batches, executed };
}

function toolCallReply(callId: string, name: string, input: unknown): readonly ModelEvent[] {
  return [{ type: "tool-call", call: { callId, name, input } }, { type: "done" }];
}

describe("managed group preparation", () => {
  it("prepares the whole step before its declaration, and records the prepared calls", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const registry = createToolRegistry();
    registry.register(toolFrom("echo", async () => "unmanaged"));
    const { boundary, batches } = testBoundary({});
    const client = createFakeModelClient([
      toolCallReply("c1", "echo", { a: 1 }),
      [{ type: "text-delta", text: "done" }, { type: "done" }],
    ]);

    const outcome = await loopFor(client, registry, boundary).runTurn({ session, turnId: TURN, context });

    expect(outcome).toEqual({ reason: "completed", text: "done" });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.position).toEqual({ turnId: TURN, stepIndex: 0 });
    expect(batches[0]?.calls).toHaveLength(1);

    const events = eventsOf(session);
    const assistant = events.find((event) => event.type === "message/assistant");
    expect(assistant?.type === "message/assistant" && assistant.data.toolCalls[0]?.callId).toBe("c1");
    const result = events.find((event) => event.type === "tool/result");
    expect(result?.type === "tool/result" && result.data.disposition).toBe("executed");
    expect(result?.type === "tool/result" && result.data.content).toBe("ran echo");
  });

  it("refuses the whole group when the batch cannot be prepared", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const registry = createToolRegistry();
    let executions = 0;
    registry.register(
      toolFrom("echo", async () => {
        executions += 1;
        return "ran";
      }),
    );
    const { boundary, executed } = testBoundary({ refuse: () => "the second call is not representable" });
    const client = createFakeModelClient([
      [
        { type: "tool-call", call: { callId: "c1", name: "echo", input: { a: 1 } } },
        { type: "tool-call", call: { callId: "c2", name: "echo", input: { b: 2 } } },
        { type: "done" },
      ],
      [{ type: "text-delta", text: "never reached" }, { type: "done" }],
    ]);

    const outcome = await loopFor(client, registry, boundary).runTurn({ session, turnId: TURN, context });

    expect(outcome.reason).toBe("error");
    expect(executions).toBe(0);
    expect(executed).toEqual([]);
    const types = eventsOf(session).map((event) => event.type);
    expect(types).toEqual(["turn/start", "message/user"]);
  });

  it("keeps the registry's standalone execution when no boundary is composed", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const registry = createToolRegistry();
    registry.register(toolFrom("echo", async (input) => `saw ${JSON.stringify(input)}`));
    const client = createFakeModelClient([
      toolCallReply("c1", "echo", { a: 1 }),
      [{ type: "text-delta", text: "done" }, { type: "done" }],
    ]);

    const outcome = await loopFor(client, registry).runTurn({ session, turnId: TURN, context });

    expect(outcome.reason).toBe("completed");
    const result = eventsOf(session).find((event) => event.type === "tool/result");
    expect(result?.type === "tool/result" && result.data.content).toBe('saw {"a":1}');
    // No boundary, no execution identity and no disposition claim.
    expect(result?.type === "tool/result" && "disposition" in result.data).toBe(false);
  });

  it("reports a boundary that refused a call as a recorded, unanswered-by-a-tool result", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const registry = createToolRegistry();
    registry.register(toolFrom("echo", async () => "unmanaged"));
    const { boundary } = testBoundary({
      outcome: () => ({
        executed: false,
        reason: "policy-denied",
        result: { ok: false, error: "tool not executed: the host's policy denied this call" },
      }),
    });
    const client = createFakeModelClient([
      toolCallReply("c1", "echo", { a: 1 }),
      [{ type: "text-delta", text: "continued" }, { type: "done" }],
    ]);

    const outcome = await loopFor(client, registry, boundary).runTurn({ session, turnId: TURN, context });

    // A not-executed observation is not a failure: the conversation continues.
    expect(outcome).toEqual({ reason: "completed", text: "continued" });
    const result = eventsOf(session).find((event) => event.type === "tool/result");
    expect(result?.type === "tool/result" && result.data.disposition).toBe("not-executed");
    expect(result?.type === "tool/result" && result.data.ok).toBe(false);
  });

  it("carries the execution id from preparation to both events", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const registry = createToolRegistry();
    registry.register(toolFrom("echo", async () => "x"));
    const { boundary } = testBoundary({});
    const client = createFakeModelClient([
      toolCallReply("c1", "echo", {}),
      [{ type: "text-delta", text: "done" }, { type: "done" }],
    ]);
    const emitted: { type: string; executionId?: string }[] = [];

    await createAgentLoop({
      modelClient: client,
      tools: registry,
      contextBuilder: createDefaultContextBuilder(),
      executionBoundary: boundary,
    }).runTurn({ session, turnId: TURN, context, emit: (event) => emitted.push(event) });

    const call = emitted.find((event) => event.type === "tool/call");
    const result = emitted.find((event) => event.type === "tool/result");
    expect(call?.executionId).toBe("exec-1");
    expect(result?.executionId).toBe("exec-1");
  });

  it("does not let a boundary's unexpected throw leave a declared call unanswered", async () => {
    const session = createSession("s-1");
    openTurn(session, "hi");
    const registry = createToolRegistry();
    registry.register(toolFrom("echo", async () => "x"));
    const boundary: ToolExecutionBoundary = {
      prepareBatch: (input) =>
        input.calls.map((call, callIndex) => ({
          executionId: "exec-1",
          call,
          position: { turnId: input.position.turnId, stepIndex: input.position.stepIndex, callIndex },
          registryGeneration: 1,
        })),
      executePrepared: async () => {
        throw new Error("the boundary broke its own contract");
      },
    };
    const client = createFakeModelClient([
      toolCallReply("c1", "echo", {}),
      [{ type: "text-delta", text: "done" }, { type: "done" }],
    ]);

    await loopFor(client, registry, boundary).runTurn({ session, turnId: TURN, context });

    const result = eventsOf(session).find((event) => event.type === "tool/result");
    expect(result?.type === "tool/result" && result.data.ok).toBe(false);
    expect(result?.type === "tool/result" && result.data.content).toBe("the boundary broke its own contract");
    // Nothing is claimed about a dispatch this side did not see.
    expect(result?.type === "tool/result" && "disposition" in result.data).toBe(false);
  });
});

/** A result the loop must not rewrite. */
const _typedResult: ToolExecutionResult = { ok: true, value: 1 };
void _typedResult;
