import { describe, expect, it } from "vitest";

import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import type { RuntimeContext } from "../src/runtime/runtime-context.js";
import { createSession } from "../src/session/session.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import type { Tool } from "../src/tools/tool.js";

const context: RuntimeContext = { sessionId: "session-1", signal: new AbortController().signal };

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

describe("createDefaultContextBuilder", () => {
  it("carries the configured system prompt", async () => {
    const request = await createDefaultContextBuilder("You are a helpful agent.").build({
      session: createSession("s"),
      tools: createToolRegistry(),
      context,
    });

    expect(request.systemPrompt).toBe("You are a helpful agent.");
  });

  it("leaves the system prompt undefined when none was configured", async () => {
    const request = await createDefaultContextBuilder().build({
      session: createSession("s"),
      tools: createToolRegistry(),
      context,
    });

    expect(request.systemPrompt).toBeUndefined();
  });

  it("projects the session log into messages", async () => {
    const session = createSession("s");
    session.append({ type: "message/user", turnId: "t1", data: { text: "hi" } });

    const request = await createDefaultContextBuilder().build({
      session,
      tools: createToolRegistry(),
      context,
    });

    expect(request.messages).toEqual(session.deriveMessages());
  });

  it("exposes only name, description and inputSchema to the model", async () => {
    const tools = createToolRegistry();
    const tool = stubTool("calculator");
    tools.register(tool);

    const request = await createDefaultContextBuilder().build({
      session: createSession("s"),
      tools,
      context,
    });

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

    const before = await builder.build({ session: createSession("s"), tools, context });
    tools.register(stubTool("second"));
    const after = await builder.build({ session: createSession("s"), tools, context });

    expect(before.tools.map((schema) => schema.name)).toEqual(["first"]);
    expect(after.tools.map((schema) => schema.name)).toEqual(["first", "second"]);
  });

  it("handles an empty session and an empty registry", async () => {
    const request = await createDefaultContextBuilder().build({
      session: createSession("s"),
      tools: createToolRegistry(),
      context,
    });

    expect(request.messages).toEqual([]);
    expect(request.tools).toEqual([]);
  });
});
