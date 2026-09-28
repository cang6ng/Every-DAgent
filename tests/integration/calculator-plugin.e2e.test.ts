import { describe, expect, it } from "vitest";

import {
  createAgentLoop,
  createAgentRuntime,
  createDefaultContextBuilder,
  createSession,
  createToolRegistry,
} from "@every-dagent/agent-core";
import type {
  ContextBuilder,
  ModelClient,
  ModelEvent,
  ModelRequest,
  Session,
  SessionEvent,
} from "@every-dagent/agent-core";
import { createCalculatorPlugin } from "@every-dagent/plugin-calculator";
import { createPluginManager } from "@every-dagent/plugin-system";

import { unsettledToolCalls } from "../helpers/session-lifecycle.js";

const SYSTEM_PROMPT = "You are a calculator. Use the calculator tool for arithmetic.";

/**
 * A scripted ModelClient built here rather than reused from a package's tests:
 * this file is the composition root, so it only reaches the packages through
 * their public entries. It replays one script per step and keeps the requests
 * so a test can assert what the model was actually shown.
 */
function scriptedModelClient(scripts: readonly ModelEvent[][]): {
  readonly client: ModelClient;
  readonly requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let step = 0;

  const client: ModelClient = {
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(request);
      const script = scripts[step];
      step += 1;
      if (script === undefined) {
        throw new Error("the scripted model client ran out of responses");
      }
      for (const event of script) {
        yield event;
      }
    },
  };

  return { client, requests };
}

/** The DoD script: call the tool, then answer from the result it was given. */
function calculatorScript(callId: string, a: number, b: number, answer: string): ModelEvent[][] {
  return [
    [
      { type: "tool-call", call: { callId, name: "calculator", input: { a, b } } },
      { type: "done" },
    ],
    [
      { type: "text-delta", text: answer },
      { type: "done" },
    ],
  ];
}

function eventOf<T extends SessionEvent["type"]>(
  session: Session,
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return session.events().flatMap((event) =>
    event.type === type ? [event as Extract<SessionEvent, { type: T }>] : [],
  );
}

describe("calculator plugin end to end (no real model)", () => {
  it("turns a plugin tool into a real tool result inside a turn", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    const contextBuilder = createDefaultContextBuilder(SYSTEM_PROMPT);
    const plugin = createCalculatorPlugin();

    manager.register(plugin);

    // Registered, but not enabled: the tool is not part of the shared registry.
    expect(registry.get("calculator")).toBeUndefined();
    expect(manager.get("calculator")?.status).toBe("disabled");

    await manager.enable("calculator");

    const enabledTool = registry.get("calculator");
    expect(enabledTool).toBeDefined();
    expect(registry.list().filter((tool) => tool.name === "calculator")).toHaveLength(1);

    const { client, requests } = scriptedModelClient(
      calculatorScript("call-1", 21, 2, "The result is 42."),
    );
    const runtime = createAgentRuntime({
      loop: createAgentLoop({ modelClient: client, tools: registry, contextBuilder }),
    });
    const session = createSession("plugin-e2e");

    const result = await runtime.run({
      session,
      text: "Use the calculator tool to calculate 21 x 2.",
    });

    expect(result.reason).toBe("completed");
    expect(result.text).toBe("The result is 42.");

    // The model was offered the plugin's tool schema on the first step.
    expect(requests[0]?.tools.map((schema) => schema.name)).toEqual(["calculator"]);

    // The turn really called the tool: the call and its result are both logged,
    // with the arguments the model sent and the product the tool produced.
    const calls = eventOf(session, "tool/call");
    const results = eventOf(session, "tool/result");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.data).toEqual({ callId: "call-1", name: "calculator", input: { a: 21, b: 2 } });
    expect(results).toHaveLength(1);
    expect(results[0]?.data).toEqual({
      callId: "call-1",
      name: "calculator",
      ok: true,
      content: "42",
    });

    // The next request carries that result, so the answer came from the tool.
    expect(requests[1]?.messages).toEqual([
      { role: "user", text: "Use the calculator tool to calculate 21 x 2." },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ callId: "call-1", name: "calculator", input: { a: 21, b: 2 } }],
      },
      {
        role: "tool",
        results: [{ callId: "call-1", name: "calculator", ok: true, content: "42" }],
      },
    ]);
    expect(unsettledToolCalls(session)).toEqual([]);

    // Disable only after the turn is over: the host owns that ordering.
    await manager.disable("calculator");

    expect(registry.get("calculator")).toBeUndefined();
    expect(registry.list()).toEqual([]);
    expect(manager.get("calculator")?.status).toBe("disabled");
  });

  it("hides the disabled tool from a new request and from direct execution", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    const contextBuilder: ContextBuilder = createDefaultContextBuilder(SYSTEM_PROMPT);
    const runtimeContext = { sessionId: "plugin-e2e", signal: new AbortController().signal };
    const session = createSession("plugin-e2e");

    manager.register(createCalculatorPlugin());

    const requestWithout = await contextBuilder.build({ session, tools: registry, context: runtimeContext });
    expect(requestWithout.tools).toEqual([]);

    await manager.enable("calculator");
    const requestWith = await contextBuilder.build({ session, tools: registry, context: runtimeContext });
    expect(requestWith.tools.map((schema) => schema.name)).toEqual(["calculator"]);

    await manager.disable("calculator");

    const requestAfter = await contextBuilder.build({ session, tools: registry, context: runtimeContext });
    expect(requestAfter.tools).toEqual([]);

    await expect(
      registry.execute("calculator", { a: 21, b: 2 }, runtimeContext),
    ).resolves.toEqual({ ok: false, error: 'unknown tool "calculator"' });
  });

  it("activates a clean new scope when the plugin is enabled again", async () => {
    const registry = createToolRegistry();
    const manager = createPluginManager({ tools: registry });
    const contextBuilder = createDefaultContextBuilder(SYSTEM_PROMPT);

    manager.register(createCalculatorPlugin());
    await manager.enable("calculator");
    const firstTool = registry.get("calculator");
    await manager.disable("calculator");

    await manager.enable("calculator");
    const secondTool = registry.get("calculator");

    expect(secondTool).toBeDefined();
    expect(secondTool).not.toBe(firstTool);
    expect(registry.list().filter((tool) => tool.name === "calculator")).toHaveLength(1);

    const { client, requests } = scriptedModelClient(calculatorScript("call-2", 6, 5, "6 x 5 = 30."));
    const runtime = createAgentRuntime({
      loop: createAgentLoop({ modelClient: client, tools: registry, contextBuilder }),
    });
    const session = createSession("plugin-e2e-reenable");

    const result = await runtime.run({ session, text: "Use the calculator tool to calculate 6 x 5." });

    expect(result.text).toBe("6 x 5 = 30.");
    expect(eventOf(session, "tool/result")[0]?.data).toMatchObject({
      callId: "call-2",
      ok: true,
      content: "30",
    });
    expect(unsettledToolCalls(session)).toEqual([]);
    expect(requests[0]?.tools.map((schema) => schema.name)).toEqual(["calculator"]);

    await manager.disable("calculator");
    expect(registry.list()).toEqual([]);
  });
});
