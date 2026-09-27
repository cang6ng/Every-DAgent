import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import { createAgentLoop } from "../src/loop/agent-loop.js";
import { createPiAiModelClient } from "../src/model/pi-ai-client.js";
import { createAgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { RuntimeContext } from "../src/runtime/runtime-context.js";
import { createSession } from "../src/session/session.js";
import { createCalculatorTool } from "../src/tools/calculator.js";
import type { Tool } from "../src/tools/tool.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { unsettledToolCalls } from "./helpers/session-lifecycle.js";

const SYSTEM_PROMPT = "You are a calculator. Use the calculator tool for arithmetic.";
const context: RuntimeContext = { sessionId: "s-1", signal: new AbortController().signal };

/** The real pi-ai registry with a scripted provider, wired to the real Core. */
function fauxCalculatorRuntime(responses: AssistantMessage[]): {
  readonly runtime: AgentRuntime;
  readonly faux: ReturnType<typeof fauxProvider>;
} {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);

  const tools = createToolRegistry();
  tools.register(createCalculatorTool());

  return {
    faux,
    runtime: createAgentRuntime({
      loop: createAgentLoop({
        modelClient: createPiAiModelClient({ models, model: faux.getModel() }),
        tools,
        contextBuilder: createDefaultContextBuilder(SYSTEM_PROMPT),
      }),
    }),
  };
}

describe("calculator tool", () => {
  it("multiplies the numbers it is asked for", async () => {
    const tool: Tool = createCalculatorTool();

    await expect(tool.execute({ a: 21, b: 2 }, context)).resolves.toBe(42);
    // A second product, so the test pins multiplication rather than "42 for {21, 2}".
    await expect(tool.execute({ a: 5, b: 6 }, context)).resolves.toBe(30);
  });

  it("throws on anything that is not two numbers", async () => {
    const tool: Tool = createCalculatorTool();

    // Throwing is the contract for bad input: the registry turns it into an
    // observation instead of an exception.
    await expect(tool.execute({ a: "21", b: 2 }, context)).rejects.toThrow(
      /expects \{ a: number, b: number \}/,
    );
  });

  it("refuses a product it cannot hand the model as a number", async () => {
    const tool: Tool = createCalculatorTool();

    // JSON cannot represent an infinite number; a "successful" result of null would be
    // worse than a failure the model can see.
    await expect(tool.execute({ a: 1e308, b: 10 }, context)).rejects.toThrow(/not a finite number/);
  });

  it("declares the arguments the model has to send", () => {
    const tool = createCalculatorTool();

    expect(tool.name).toBe("calculator");
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    });
  });
});

describe("calculator round trip with the faux provider (no real model)", () => {
  it("answers what the DoD asks for: 21 x 2 through a tool call", async () => {
    const { runtime, faux } = fauxCalculatorRuntime([
      fauxAssistantMessage([fauxToolCall("calculator", { a: 21, b: 2 })], { stopReason: "toolUse" }),
      fauxAssistantMessage("The result is 42."),
    ]);
    const session = createSession("s-1");

    const result = await runtime.run({
      session,
      text: "Use the calculator tool to calculate 21 x 2.",
    });

    expect(result).toMatchObject({ text: "The result is 42.", reason: "completed" });
    expect(faux.state.callCount).toBe(2);
    expect(session.events().map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "message/assistant",
      "tool/call",
      "tool/result",
      "message/assistant",
      "turn/end",
    ]);
    // The tool really ran, with the numbers the model sent, and the log records the
    // value it returned — not something the model said.
    const call = session.events().find((event) => event.type === "tool/call");
    expect(call?.data).toMatchObject({ name: "calculator", input: { a: 21, b: 2 } });
    const toolResult = session.events().find((event) => event.type === "tool/result");
    expect(toolResult?.data).toMatchObject({ ok: true, content: "42" });
    expect(unsettledToolCalls(session)).toEqual([]);
  });

  it("turns arguments the tool refuses into an observation the model can answer", async () => {
    const { runtime } = fauxCalculatorRuntime([
      fauxAssistantMessage([fauxToolCall("calculator", { a: "twenty-one", b: 2 })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("I could not multiply that."),
    ]);
    const session = createSession("s-1");

    const result = await runtime.run({ session, text: "what is twenty-one times two" });

    expect(result).toMatchObject({ text: "I could not multiply that.", reason: "completed" });
    const toolResult = session.events().find((event) => event.type === "tool/result");
    expect(toolResult?.data).toMatchObject({
      ok: false,
      content: "calculator expects { a: number, b: number }",
    });
  });
});
