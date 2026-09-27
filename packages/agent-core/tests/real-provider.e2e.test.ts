import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import { createAgentLoop } from "../src/loop/agent-loop.js";
import { createPiAiModelClient } from "../src/model/pi-ai-client.js";
import { createAgentRuntime } from "../src/runtime/agent-runtime.js";
import { createSession } from "../src/session/session.js";
import { createCalculatorTool } from "../src/tools/calculator.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";

/**
 * One turn against a real provider over the network, through pi-ai.
 *
 * Skipped unless the credential it needs is in the environment: a credential is the
 * host's business, and a missing one has to show up as "not run" rather than as a
 * pass. Nothing here reads or reports the credential — it is handed to the adapter
 * as it is, and only the answer's shape is asserted.
 */
const apiKey = process.env.DEEPSEEK_API_KEY;
const provider = process.env.E2E_PROVIDER ?? "deepseek";
const modelId = process.env.E2E_MODEL ?? "deepseek-flash";

describe.skipIf(apiKey === undefined)("real provider smoke", () => {
  it("answers a plain turn with the real model", { timeout: 180_000 }, async () => {
    const models = builtinModels();
    const model = models.getModel(provider, modelId);
    expect(model, `pi-ai's catalog has no ${provider}/${modelId}`).toBeDefined();

    const session = createSession("e2e-smoke");
    const runtime = createAgentRuntime({
      loop: createAgentLoop({
        modelClient: createPiAiModelClient({ models, model: model!, apiKey, maxTokens: 256 }),
        tools: createToolRegistry(),
        contextBuilder: createDefaultContextBuilder(
          "You are a terse assistant. Answer in one short sentence.",
        ),
      }),
    });

    const result = await runtime.run({ session, text: "What is 21 times 2? Answer with the number." });

    if (result.reason !== "completed") {
      // Why a real endpoint refused is the whole reason to run this by hand.
      console.log(`[real provider smoke] ${provider}/${modelId} ended as ${result.reason}: ${result.error}`);
    }

    expect(result.reason).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(session.events().map((event) => event.type)).toEqual([
      "turn/start",
      "message/user",
      "message/assistant",
      "turn/end",
    ]);

    const answer = result.text.trim();
    console.log(`[real provider smoke] ${provider}/${modelId} answered (${answer.length} chars): ${answer.slice(0, 120)}`);
  });

  it("runs the DoD round trip: a real model calls the calculator tool", { timeout: 180_000 }, async () => {
    const models = builtinModels();
    const model = models.getModel(provider, modelId);
    expect(model, `pi-ai's catalog has no ${provider}/${modelId}`).toBeDefined();

    const tools = createToolRegistry();
    tools.register(createCalculatorTool());
    const session = createSession("e2e-calculator");
    const runtime = createAgentRuntime({
      loop: createAgentLoop({
        // Reasoning models spend output tokens before the answer, so the cap leaves
        // room for that; hitting it would be reported as a truncation, not an answer.
        modelClient: createPiAiModelClient({ models, model: model!, apiKey, maxTokens: 1024 }),
        tools,
        contextBuilder: createDefaultContextBuilder(
          "You are a calculator. Use the calculator tool for arithmetic instead of computing yourself.",
        ),
      }),
    });

    const result = await runtime.run({
      session,
      text: "Use the calculator tool to calculate 21 * 2.",
    });

    if (result.reason !== "completed") {
      console.log(`[real provider E2E] ${provider}/${modelId} ended as ${result.reason}: ${result.error}`);
    }

    expect(result.reason).toBe("completed");
    // The tool ran with the numbers the model actually sent — the one piece of evidence
    // a model's own answer cannot fake — and the log holds the value it returned. The
    // operands are checked as a set: which one the model calls `a` is its own choice,
    // and the tool multiplies either way.
    const call = session.events().find((event) => event.type === "tool/call");
    const operands = Object.values((call?.data.input ?? {}) as Record<string, unknown>);
    expect(call?.data.name).toBe("calculator");
    expect([...operands].sort()).toEqual([2, 21]);
    const toolResult = session.events().find((event) => event.type === "tool/result");
    expect(toolResult?.data).toMatchObject({ ok: true, content: "42" });
    expect(result.text).toMatch(/\b42\b/);
    // At least the step that asked for the tool and the one that answered.
    expect(
      session.events().filter((event) => event.type === "message/assistant").length,
    ).toBeGreaterThanOrEqual(2);

    console.log(`[real provider E2E] ${provider}/${modelId} called calculator(${JSON.stringify(call?.data.input)}) → ${String(toolResult?.data.content)}; answer: ${result.text.trim().slice(0, 120)}`);
  });
});
