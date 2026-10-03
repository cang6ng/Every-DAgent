import { describe, expect, it } from "vitest";

import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import type { ContextBuilder, ContextBuilderInput } from "../src/context/context-builder.js";
import { defineModelBudget } from "../src/context/model-budget.js";
import type { RuntimeContext } from "../src/runtime/runtime-context.js";
import { createSession } from "../src/session/session.js";
import type { Session } from "../src/session/session.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import type { ToolRegistry } from "../src/tools/tool-registry.js";
import type { Tool } from "../src/tools/tool.js";
import { TEST_MODEL_LIMITS } from "./helpers/test-model-limits.js";

const context: RuntimeContext = { sessionId: "session-1", signal: new AbortController().signal };
const TURN = "t1";

function stubTool(name: string): Tool {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    async execute() {
      return null;
    },
  };
}

/** A session with the one turn the builder is allowed to be asked about. */
function framedSession(text = "hi"): Session {
  const session = createSession("s");
  session.append({ type: "turn/start", turnId: TURN, data: {} });
  session.append({ type: "message/user", turnId: TURN, data: { text } });
  return session;
}

/** Everything the loop hands a builder, with the fixed context read as it is per step. */
function inputFor(builder: ContextBuilder, session: Session, tools: ToolRegistry): ContextBuilderInput {
  return {
    session,
    tools,
    context,
    turnId: TURN,
    limits: TEST_MODEL_LIMITS,
    budget: defineModelBudget(TEST_MODEL_LIMITS),
    fixed: builder.getFixedContext({ tools, context }),
  };
}

describe("createDefaultContextBuilder", () => {
  it("carries the configured system prompt", async () => {
    const builder = createDefaultContextBuilder("You are a helpful agent.");
    const request = await builder.build(inputFor(builder, framedSession(), createToolRegistry()));

    expect(request.systemPrompt).toBe("You are a helpful agent.");
  });

  it("leaves the system prompt undefined when none was configured", async () => {
    const builder = createDefaultContextBuilder();
    const request = await builder.build(inputFor(builder, framedSession(), createToolRegistry()));

    expect(request.systemPrompt).toBeUndefined();
  });

  it("projects the loaded log into messages", async () => {
    const builder = createDefaultContextBuilder();
    const session = framedSession();

    const request = await builder.build(inputFor(builder, session, createToolRegistry()));

    expect(request.messages).toEqual(session.deriveMessages());
  });

  it("carries the budget's reserved output as the request's own cap", async () => {
    const builder = createDefaultContextBuilder();
    const session = framedSession();

    const request = await builder.build(inputFor(builder, session, createToolRegistry()));

    expect(request.maxOutputTokens).toBe(defineModelBudget(TEST_MODEL_LIMITS).reservedOutput);
  });

  it("exposes only name, description and inputSchema to the model", async () => {
    const builder = createDefaultContextBuilder();
    const tools = createToolRegistry();
    const tool = stubTool("calculator");
    tools.register(tool);

    const request = await builder.build(inputFor(builder, framedSession(), tools));

    expect(request.tools).toHaveLength(1);
    expect(Object.keys(request.tools[0]).sort()).toEqual(["description", "inputSchema", "name"]);
    expect(request.tools[0]).not.toBe(tool);
    expect(request.tools[0]).toEqual({
      name: "calculator",
      description: "The calculator tool.",
      inputSchema: { type: "object" },
    });
  });

  it("re-reads the registry on every build", async () => {
    const builder = createDefaultContextBuilder();
    const tools = createToolRegistry();
    tools.register(stubTool("first"));

    const before = await builder.build(inputFor(builder, framedSession(), tools));
    tools.register(stubTool("second"));
    const after = await builder.build(inputFor(builder, framedSession(), tools));

    expect(before.tools.map((schema) => schema.name)).toEqual(["first"]);
    expect(after.tools.map((schema) => schema.name)).toEqual(["first", "second"]);
  });

  it("reads the fixed context without a session, a provider or an await", () => {
    const builder = createDefaultContextBuilder("You are a helpful agent.");
    const tools = createToolRegistry();
    tools.register(stubTool("calculator"));

    const fixed = builder.getFixedContext({ tools, context });

    expect(fixed).toEqual({
      systemPrompt: "You are a helpful agent.",
      tools: [
        { name: "calculator", description: "The calculator tool.", inputSchema: { type: "object" } },
      ],
    });
  });
});
