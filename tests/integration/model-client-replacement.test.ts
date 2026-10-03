/**
 * Acceptance C: the model client is replaceable.
 *
 * Two implementations of completely different shapes — an object whose
 * `stream` replays a fixed script, and a class whose generator derives its
 * answer from the conversation — are injected into the same host composition
 * and driven through the same client acceptance function. Nothing else
 * changes: the same host, the same registry, the same protocol, the same
 * client. The provider itself is never called; the pi-ai adapter's own
 * contract tests stay where they are.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { ModelClient, ModelEvent, ModelRequest } from "@every-dagent/agent-core";
import { createClient } from "@every-dagent/client";
import { createCalculatorPlugin } from "@every-dagent/plugin-calculator";

import { scriptedModel, textReply, toolReply } from "../helpers/demo-fixtures.js";
import { TEST_MODEL_LIMITS } from "../helpers/model-limits.js";
import { createHostPlatform, runSettled, waitFor } from "../helpers/platform.js";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

interface Outcome {
  readonly kinds: readonly string[];
  readonly toolResult: { readonly ok: boolean; readonly content: string } | null;
  readonly assistantText: string;
}

/**
 * The one acceptance every model client has to pass, unchanged.
 *
 * A session, one submission, one tool call, one answer — read back through the
 * client's presentation, so the evidence is what a UI would see.
 */
async function accept(modelClient: ModelClient, submissionId: string): Promise<Outcome> {
  const platform = createHostPlatform({ modelClient, plugins: [createCalculatorPlugin()] });
  open.push({ close: () => platform.shutdown() });

  const client = createClient({ connect: () => platform.connect() });
  await client.connect();
  await client.plugins.enable({ pluginId: "calculator" });
  const { session } = await client.sessions.create();
  const started = await client.runs.start({ sessionId: session.sessionId, submissionId, text: "6*7 是多少" });

  await waitFor(() => runSettled(client.getSnapshot(), started.run.runId), {
    what: "the run to settle",
    timeoutMs: 5000,
  });

  // The settled turn is read the v2 way: one bounded page of committed history.
  const canonical = (await client.sessions.history({ sessionId: session.sessionId })).page.items;
  const result = canonical.find((item) => item.kind === "tool-result");
  // A step that only asked for a tool records an empty assistant message, so
  // the answered one is the last assistant item, not the first.
  const assistant = [...canonical].reverse().find((item) => item.kind === "assistant");
  client.disconnect();

  return {
    kinds: canonical.map((item) => item.kind),
    toolResult: result === undefined ? null : { ok: result.ok, content: result.content },
    assistantText: assistant?.text ?? "",
  };
}

/** Shape one: an object literal replaying a script of assembled events. */
function scripted(): ModelClient {
  return scriptedModel([
    toolReply("call-1", "calculator", { a: 6, b: 7 }),
    textReply("the product is 42"),
  ]).client;
}

/** Shape two: a class whose generator derives the tool call from the message. */
class DerivingModelClient implements ModelClient {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    this.calls += 1;
    const last = request.messages[request.messages.length - 1];
    if (last !== undefined && last.role === "user") {
      const [left, right] = last.text.replace(" 是多少", "").split("*");
      yield { type: "tool-call", call: { callId: `derived-${this.calls}`, name: "calculator", input: { a: Number(left), b: Number(right) } } };
      yield { type: "done" };
      return;
    }
    const content = last !== undefined && last.role === "tool" ? last.results[0]?.content ?? "" : "";
    yield { type: "text-delta", text: `the product is ${content}` };
    yield { type: "done" };
  }
}

describe("two model client shapes through one acceptance", () => {
  it("produces the same observable run for both", async () => {
    const first = await accept(scripted(), "sub-scripted");
    const second = await accept(new DerivingModelClient(), "sub-derived");

    // The platform did not notice the difference: same canonical structure,
    // same tool outcome, and each client's own words for the answer.
    expect(first.kinds).toEqual(["user", "assistant", "tool-call", "tool-result", "assistant"]);
    expect(second.kinds).toEqual(first.kinds);
    expect(first.toolResult).toEqual({ ok: true, content: "42" });
    expect(second.toolResult).toEqual(first.toolResult);
    expect(first.assistantText).toBe("the product is 42");
    expect(second.assistantText).toBe("the product is 42");
  });
});
