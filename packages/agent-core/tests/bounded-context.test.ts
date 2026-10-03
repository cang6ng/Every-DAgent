/**
 * M2 acceptance, at the Core's own boundary: what a request may cost, what
 * history survives, and what a builder is not allowed to change.
 *
 * The numbers here are deliberately small. A budget test that used a real
 * 128k window would be testing arithmetic nobody can check by reading; these
 * use a window in the low kilobytes, so "one cost unit over" is a number the
 * test computes and the reader can follow.
 */

import { describe, expect, it } from "vitest";

import { createDefaultContextBuilder } from "../src/context/context-builder.js";
import { estimateRequestCost } from "../src/context/context-estimator.js";
import { assertModelRequestFits, ownModelRequest } from "../src/context/context-guard.js";
import {
  defineModelBudget,
  DEFAULT_MODEL_FRAMING,
  validateModelLimits,
} from "../src/context/model-budget.js";
import type { ModelLimits } from "../src/context/model-budget.js";
import { isLegalTruncation, selectBoundedContext, truncationMarker } from "../src/context/context-selection.js";
import { jsonDepthOf, stableJSON, utf8Bytes } from "../src/context/stable-json.js";
import { ContextBudgetError, InvalidModelRequestError, ModelBudgetError, ModelLimitsError } from "../src/errors.js";
import type { ModelMessage, ToolCall } from "../src/model/message.js";
import type { ModelRequest, ToolSchema } from "../src/model/model-client.js";
import { createSession } from "../src/session/session.js";
import type { Session } from "../src/session/session.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";

const context = { sessionId: "s", signal: new AbortController().signal };

/**
 * A wide capability used only to *measure* with: what a request costs does not
 * depend on the budget it is measured against, so every boundary test can price
 * the request it is about to squeeze and then choose the window from that number.
 */
const PROBE = limitsForInput(64 * 1024);

/** What a representation would cost with this test's framing and reserve. */
function costOf(
  messages: readonly ModelMessage[],
  tools: readonly ToolSchema[] = [],
  systemPrompt?: string,
): number {
  return estimateRequestCost(
    {
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      messages,
      tools,
      maxOutputTokens: budgetFor(PROBE).reservedOutput,
    },
    PROBE,
  );
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** A capability whose input budget is exactly `maxInputCost`. */
function limitsForInput(maxInputCost: number, maxOutputTokens = 1024): ModelLimits {
  // R = min(4096, 1024) = 1024 and S = max(1024, ceil(0.1 * C)); the windows here
  // stay under the 10 KiB where the floor wins, so S is the floor.
  const safety = 1024;
  const contextWindow = maxInputCost + maxOutputTokens + safety;
  return { contextWindow, maxOutputTokens, framing: DEFAULT_MODEL_FRAMING };
}

function budgetFor(limits: ModelLimits) {
  return defineModelBudget(limits);
}

/** One finished turn, written the way the Runtime writes one. */
function finishTurn(session: Session, turnId: string, text: string, answer = ""): void {
  session.append({ type: "turn/start", turnId, data: {} });
  session.append({ type: "message/user", turnId, data: { text } });
  session.append({ type: "message/assistant", turnId, data: { text: answer, toolCalls: [] } });
  session.append({ type: "turn/end", turnId, data: { reason: "completed" } });
}

/** A session with finished turns behind it and one open turn in front. */
function sessionWith(history: readonly { text: string; answer?: string }[], current: string): {
  readonly session: Session;
  readonly turnId: string;
} {
  const session = createSession("s");
  history.forEach((turn, index) => finishTurn(session, `h${index}`, turn.text, turn.answer ?? ""));
  const turnId = "current";
  session.append({ type: "turn/start", turnId, data: {} });
  session.append({ type: "message/user", turnId, data: { text: current } });
  return { session, turnId };
}

/** One open turn carrying a completed tool round trip. */
function sessionWithToolRoundTrip(text: string, content: string): {
  readonly session: Session;
  readonly turnId: string;
} {
  const session = createSession("s");
  const turnId = "current";
  session.append({ type: "turn/start", turnId, data: {} });
  session.append({ type: "message/user", turnId, data: { text } });
  session.append({
    type: "message/assistant",
    turnId,
    data: { text: "", toolCalls: [{ callId: "c1", name: "echo", input: { text } }] },
  });
  session.append({ type: "tool/call", turnId, data: { callId: "c1", name: "echo", input: { text } } });
  session.append({ type: "tool/result", turnId, data: { callId: "c1", name: "echo", ok: true, content } });
  return { session, turnId };
}

/** What one tool round trip with this content costs, before anything is cut. */
function roundTripCost(text: string, content: string): number {
  return costOf([
    { role: "user", text },
    { role: "assistant", text: "", toolCalls: [{ callId: "c1", name: "echo", input: { text } }] },
    { role: "tool", results: [{ callId: "c1", name: "echo", ok: true, content }] },
  ]);
}

function select(
  session: Session,
  turnId: string,
  limits: ModelLimits,
  fixed = { tools: [], systemPrompt: undefined as string | undefined },
): ModelRequest {
  return selectBoundedContext({ events: session.events(), turnId, fixed, limits, budget: budgetFor(limits) });
}

// ---------------------------------------------------------------------------
// The budget itself.
// ---------------------------------------------------------------------------

describe("model budget arithmetic", () => {
  it("derives R and S from the frozen rules", () => {
    expect(defineModelBudget({ contextWindow: 128 * 1024, maxOutputTokens: 100_000, framing: DEFAULT_MODEL_FRAMING })).toEqual({
      contextWindow: 128 * 1024,
      reservedOutput: 4096,
      safetyMargin: 13108,
      maxInputCost: 128 * 1024 - 4096 - 13108,
    });
  });

  it("reserves less than the model's maximum when the model is small", () => {
    expect(defineModelBudget({ contextWindow: 8192, maxOutputTokens: 100, framing: DEFAULT_MODEL_FRAMING }).reservedOutput).toBe(100);
  });

  it("refuses a capability that would make every request fit", () => {
    for (const bad of [
      { contextWindow: Number.POSITIVE_INFINITY, maxOutputTokens: 4096, framing: DEFAULT_MODEL_FRAMING },
      { contextWindow: Number.NaN, maxOutputTokens: 4096, framing: DEFAULT_MODEL_FRAMING },
      { contextWindow: 0, maxOutputTokens: 4096, framing: DEFAULT_MODEL_FRAMING },
      { contextWindow: -1, maxOutputTokens: 4096, framing: DEFAULT_MODEL_FRAMING },
      { contextWindow: 1024.5, maxOutputTokens: 4096, framing: DEFAULT_MODEL_FRAMING },
      { contextWindow: 2 ** 60, maxOutputTokens: 4096, framing: DEFAULT_MODEL_FRAMING },
      { contextWindow: 8192, maxOutputTokens: 0, framing: DEFAULT_MODEL_FRAMING },
      { contextWindow: 8192, maxOutputTokens: 4096, framing: { ...DEFAULT_MODEL_FRAMING, request: -1 } },
      { contextWindow: 8192, maxOutputTokens: 4096, framing: { ...DEFAULT_MODEL_FRAMING, message: Number.NaN } },
    ]) {
      expect(() => validateModelLimits(bad)).toThrow(ModelLimitsError);
    }
  });

  it("refuses limits with no room left for input", () => {
    // R + S alone is 2048, so a 2048-wide window leaves nothing.
    expect(() => defineModelBudget({ contextWindow: 2048, maxOutputTokens: 1024, framing: DEFAULT_MODEL_FRAMING })).toThrow(
      ModelBudgetError,
    );
  });

  it("refuses a budget that reserves less than the profile's floor", () => {
    expect(() =>
      defineModelBudget({ contextWindow: 128 * 1024, maxOutputTokens: 8192, minOutputTokens: 8192, framing: DEFAULT_MODEL_FRAMING }),
    ).toThrow(ModelBudgetError);
  });
});

// ---------------------------------------------------------------------------
// The estimator.
// ---------------------------------------------------------------------------

describe("conservative UTF-8 estimator", () => {
  const limits = limitsForInput(64 * 1024);

  function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
    return {
      messages: [{ role: "user", text: "hi" }],
      tools: [],
      maxOutputTokens: budgetFor(limits).reservedOutput,
      ...overrides,
    };
  }

  it("is deterministic for one frozen request", () => {
    const one = request({ systemPrompt: "You are terse.", tools: [{ name: "t", description: "d", inputSchema: { z: 1, a: 2 } }] });

    expect(estimateRequestCost(one, limits)).toBe(estimateRequestCost(one, limits));
  });

  it("charges more for more content", () => {
    const small = estimateRequestCost(request(), limits);
    const large = estimateRequestCost(request({ messages: [{ role: "user", text: "hi".repeat(100) }] }), limits);

    expect(large).toBeGreaterThan(small);
  });

  it("charges the second escaping layer a tool call's arguments pick up", () => {
    const quoted = 'a "quoted" \\ string';
    const plain: ModelRequest = request({
      messages: [
        {
          role: "assistant",
          text: "",
          toolCalls: [{ callId: "c1", name: "t", input: { text: "plain text" } }],
        },
      ],
    });
    const escaped: ModelRequest = request({
      messages: [
        {
          role: "assistant",
          text: "",
          toolCalls: [{ callId: "c1", name: "t", input: { text: quoted } }],
        },
      ],
    });

    // The quoted argument costs its own bytes plus the escaping of them, so it
    // is strictly dearer than the same number of ordinary characters would be.
    expect(estimateRequestCost(escaped, limits)).toBeGreaterThan(estimateRequestCost(plain, limits));
    expect(estimateRequestCost(escaped, limits) - estimateRequestCost(plain, limits)).toBeGreaterThan(utf8Bytes(quoted) - 11);
  });

  it("counts the structure a request declares, not only its text", () => {
    const withoutTools = estimateRequestCost(request(), limits);
    const withTools = estimateRequestCost(
      request({ tools: [{ name: "t", description: "", inputSchema: {} }] }),
      limits,
    );

    // A tool definition costs its own bytes plus its declared framing.
    expect(withTools - withoutTools).toBeGreaterThanOrEqual(DEFAULT_MODEL_FRAMING.toolDefinition);
  });

  it("measures a frozen request's own fields, including its output reserve", () => {
    const small = estimateRequestCost(request({ maxOutputTokens: 1 }), limits);
    const large = estimateRequestCost(request({ maxOutputTokens: 999_999 }), limits);

    expect(large).toBeGreaterThan(small);
  });
});

describe("stable JSON", () => {
  it("does not depend on property order", () => {
    expect(stableJSON({ b: 1, a: [{ y: 2, x: 3 }] })).toBe(stableJSON({ a: [{ x: 3, y: 2 }], b: 1 }));
  });

  it("escapes the way JSON does, control characters included", () => {
    expect(stableJSON({ text: 'a"b\\c\nd\u0000' })).toBe('{"text":"a\\"b\\\\c\\nd\\u0000"}');
  });

  it("reports the depth of a value", () => {
    expect(jsonDepthOf(1)).toBe(0);
    expect(jsonDepthOf({ a: 1 })).toBe(1);
    expect(jsonDepthOf({ a: { b: [1, { c: 2 }] } })).toBe(4);
  });

  it("refuses what JSON cannot carry", () => {
    for (const bad of [
      { a: Number.NaN },
      { a: Number.POSITIVE_INFINITY },
      { a: -0 },
      { a: () => 1 },
      { a: new Date(0) },
      { a: new Map() },
      [1, , 3],
      [1, undefined, 3],
    ]) {
      expect(() => stableJSON(bad)).toThrow(InvalidModelRequestError);
    }
  });

  it("omits an undefined property the way JSON does", () => {
    // An absent value is a value nobody sent; a *hole* is a position nobody
    // filled, and the two are refused differently on purpose.
    expect(stableJSON({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("refuses a cycle rather than walking it", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;

    expect(() => stableJSON(loop)).toThrow(/cycle/);
  });

  it("refuses a getter instead of running it", () => {
    let ran = false;
    const hostile = {
      get a(): number {
        ran = true;
        return 1;
      },
    };

    expect(() => stableJSON(hostile)).toThrow(/run to be read/);
    expect(ran).toBe(false);
  });

  it("does not call a value's own toJSON", () => {
    let called = false;
    const value = {
      toJSON(): number {
        called = true;
        return 1;
      },
      b: 2,
    };

    // `toJSON` is a function, and a function is not JSON: the traversal refuses
    // the value outright rather than asking it what it would like to be.
    expect(() => stableJSON(value)).toThrow(InvalidModelRequestError);
    expect(called).toBe(false);

    // A `Date` is the case this matters for: calling its `toJSON` would invent a
    // string nobody wrote, and not calling it would send an empty object.
    expect(() => stableJSON({ at: new Date(0) })).toThrow(/prototype/);
  });
});

// ---------------------------------------------------------------------------
// Selection.
// ---------------------------------------------------------------------------

describe("complete-turn selection", () => {
  it("keeps whole turns and drops the ones that do not fit, newest first", () => {
    const { session, turnId } = sessionWith(
      [{ text: "one", answer: "a1" }, { text: "two", answer: "a2" }, { text: "three", answer: "a3" }],
      "four",
    );
    const limits = limitsForInput(4096);

    // A budget that fits everything says so.
    const generous = select(session, turnId, limits);
    expect(generous.messages.map((message) => (message.role === "user" ? message.text : ""))).toEqual([
      "one",
      "",
      "two",
      "",
      "three",
      "",
      "four",
    ]);

    // A budget that fits the current turn plus the newest one keeps them in
    // conversation order.
    // Room for exactly the current turn and the newest historical turn: the
    // boundary is measured from the very messages that will be selected, so
    // "and one more turn" is a number this test really holds the selector to.
    const oneTurn = costOf([
      { role: "user", text: "three" },
      { role: "assistant", text: "a3", toolCalls: [] },
      { role: "user", text: "four" },
    ]);
    const oneOnly = select(session, turnId, limitsForInput(oneTurn));

    expect(oneOnly.messages.map((message) => (message.role === "user" ? message.text : ""))).toEqual([
      "three",
      "",
      "four",
    ]);
  });

  it("sends no history at all when the newest old turn does not fit", () => {
    const { session, turnId } = sessionWith([{ text: "x".repeat(4000) }], "four");
    const limits = limitsForInput(2048);

    const request = select(session, turnId, limits);

    expect(request.messages.map((message) => (message.role === "user" ? message.text : ""))).toEqual(["four"]);
  });

  it("never skips a turn that did not fit to reach an older one", () => {
    const { session, turnId } = sessionWith(
      [{ text: "small and old" }, { text: "x".repeat(4000) }, { text: "small and recent" }],
      "four",
    );
    const limits = limitsForInput(2048);

    const request = select(session, turnId, limits);

    // The recent small turn is kept; the large one ends the selection, and the
    // smaller turn behind it is not reachable past it.
    expect(request.messages.map((message) => (message.role === "user" ? message.text : ""))).toEqual([
      "small and recent",
      "",
      "four",
    ]);
  });

  it("keeps each historical tool call and its result together", () => {
    const session = createSession("s");
    const turnId = "current";
    // A finished turn with a tool round trip, then the open turn.
    session.append({ type: "turn/start", turnId: "h0", data: {} });
    session.append({ type: "message/user", turnId: "h0", data: { text: "what is 21 x 2" } });
    session.append({
      type: "message/assistant",
      turnId: "h0",
      data: { text: "", toolCalls: [{ callId: "c1", name: "calculator", input: { a: 21, b: 2 } }] },
    });
    session.append({ type: "tool/call", turnId: "h0", data: { callId: "c1", name: "calculator", input: { a: 21, b: 2 } } });
    session.append({ type: "tool/result", turnId: "h0", data: { callId: "c1", name: "calculator", ok: true, content: "42" } });
    session.append({ type: "message/assistant", turnId: "h0", data: { text: "It is 42.", toolCalls: [] } });
    session.append({ type: "turn/end", turnId: "h0", data: { reason: "completed" } });
    session.append({ type: "turn/start", turnId, data: {} });
    session.append({ type: "message/user", turnId, data: { text: "and 3 x 4?" } });

    const request = select(session, turnId, limitsForInput(4096));

    expect(request.messages).toEqual([
      { role: "user", text: "what is 21 x 2" },
      { role: "assistant", text: "", toolCalls: [{ callId: "c1", name: "calculator", input: { a: 21, b: 2 } }] },
      { role: "tool", results: [{ callId: "c1", name: "calculator", ok: true, content: "42" }] },
      { role: "assistant", text: "It is 42.", toolCalls: [] },
      { role: "user", text: "and 3 x 4?" },
    ]);
  });

  it("selects the same window for the same history, limits and tools", () => {
    const history = [{ text: "one" }, { text: "two" }, { text: "three" }];
    const limits = limitsForInput(512);

    const first = select(sessionWith(history, "four").session, "current", limits);
    const second = select(sessionWith(history, "four").session, "current", limits);

    expect(second.messages).toEqual(first.messages);
    expect(second.maxOutputTokens).toBe(first.maxOutputTokens);
  });

  it("refuses a session whose turn cannot be built for", () => {
    const session = createSession("s");
    finishTurn(session, "h0", "done");

    expect(() => select(session, "h0", limitsForInput(4096))).toThrow(InvalidModelRequestError);
    expect(() => select(session, "missing", limitsForInput(4096))).toThrow(/no open turn/);
  });

  it("refuses a log whose tool history is not a complete pairing", () => {
    const session = createSession("s");
    const turnId = "current";
    session.append({ type: "turn/start", turnId, data: {} });
    session.append({ type: "message/user", turnId, data: { text: "hi" } });
    session.append({
      type: "message/assistant",
      turnId,
      data: { text: "", toolCalls: [{ callId: "c1", name: "echo", input: {} }] },
    });
    session.append({ type: "tool/call", turnId, data: { callId: "c1", name: "echo", input: {} } });
    // The result never arrives: the provider would reject this history.

    expect(() => select(session, turnId, limitsForInput(4096))).toThrow(/unanswered/);
  });
});

describe("current-turn tool result truncation", () => {
  it("shortens the oldest result first and keeps the newest intact", () => {
    const session = createSession("s");
    const turnId = "current";
    session.append({ type: "turn/start", turnId, data: {} });
    session.append({ type: "message/user", turnId, data: { text: "read both" } });
    session.append({
      type: "message/assistant",
      turnId,
      data: {
        text: "",
        toolCalls: [
          { callId: "c1", name: "read", input: { path: "a" } },
          { callId: "c2", name: "read", input: { path: "b" } },
        ],
      },
    });
    for (const [callId, content] of [["c1", "A".repeat(4000)], ["c2", "B".repeat(4000)]] as const) {
      session.append({ type: "tool/call", turnId, data: { callId, name: "read", input: {} } });
      session.append({ type: "tool/result", turnId, data: { callId, name: "read", ok: true, content } });
    }

    // Room for the current turn with one result's worth of text gone, and no more.
    const fullCost = costOf([
      { role: "user", text: "read both" },
      {
        role: "assistant",
        text: "",
        toolCalls: [
          { callId: "c1", name: "read", input: { path: "a" } },
          { callId: "c2", name: "read", input: { path: "b" } },
        ],
      },
      { role: "tool", results: [{ callId: "c1", name: "read", ok: true, content: "A".repeat(4000) }] },
      { role: "tool", results: [{ callId: "c2", name: "read", ok: true, content: "B".repeat(4000) }] },
    ]);
    expect(select(session, turnId, limitsForInput(fullCost)).messages).toHaveLength(4);

    const tight = select(session, turnId, limitsForInput(fullCost - 2000));
    const results = tight.messages.flatMap((message) => (message.role === "tool" ? message.results : []));

    expect(results).toHaveLength(2);
    expect(results[0]?.content.startsWith("A".repeat(100))).toBe(true);
    expect(results[0]?.content).toContain(truncationMarker(4000));
    // And it is the oldest result that gave up the bytes, not both.
    expect(isLegalTruncation("A".repeat(4000), results[0]?.content ?? "")).toBe(true);
    // The newest observation is the one the model is about to reason about.
    expect(results[1]?.content).toBe("B".repeat(4000));
  });

  it("falls back to a marker alone when even a prefix does not fit", () => {
    const content = "Z".repeat(4000);
    const { session, turnId } = sessionWithToolRoundTrip("hi", content);
    const markerOnly = costOf([
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [{ callId: "c1", name: "echo", input: { text: "hi" } }] },
      { role: "tool", results: [{ callId: "c1", name: "echo", ok: true, content: truncationMarker(4000) }] },
    ]);
    const tight = select(session, turnId, limitsForInput(markerOnly));
    const result = tight.messages.flatMap((message) => (message.role === "tool" ? message.results : []))[0];

    expect(result?.content).toBe(truncationMarker(4000));
    expect(result?.callId).toBe("c1");
    expect(result?.name).toBe("echo");
    expect(result?.ok).toBe(true);
  });

  it("leaves a result alone when its marker would cost more than the content", () => {
    const { session, turnId } = sessionWithToolRoundTrip("hi", "ok");

    const request = select(session, turnId, limitsForInput(4096));

    expect(request.messages.flatMap((message) => (message.role === "tool" ? message.results : []))[0]?.content).toBe("ok");
  });

  it("cuts on a code point, never through one", () => {
    // A prefix cut in the middle of a surrogate pair would replace half a
    // character with a replacement character, which is a different observation.
    const content = "🙂".repeat(1000);
    const { session, turnId } = sessionWithToolRoundTrip("hi", content);
    const tight = select(session, turnId, limitsForInput(roundTripCost("hi", content) - 1500));
    const truncated = tight.messages.flatMap((message) => (message.role === "tool" ? message.results : []))[0]?.content ?? "";

    expect(truncated).toContain(truncationMarker(4000));
    expect(isLegalTruncation(content, truncated)).toBe(true);
    const prefix = truncated.slice(0, truncated.length - truncationMarker(4000).length);
    expect(prefix.length % 2).toBe(0);
    expect(prefix).not.toContain("\uFFFD");
  });

  it("survives ASCII, CJK, emoji, quotes, control characters and lone surrogates", () => {
    for (const content of [
      "a".repeat(4000),
      "中文".repeat(1000),
      "\"quoted\" \\\\ and \n newlines".repeat(100),
      "\u0000\u0001\u001f".repeat(500),
      `lone surrogate: \uD800${"x".repeat(2000)}`,
    ]) {
      const { session, turnId } = sessionWithToolRoundTrip("hi", content);
      const tight = select(session, turnId, limitsForInput(roundTripCost("hi", content) - 800));
      const truncated = tight.messages.flatMap((message) => (message.role === "tool" ? message.results : []))[0]?.content ?? "";

      expect(truncated).toContain("model-only truncated");
      expect(isLegalTruncation(content, truncated)).toBe(true);
    }
  });

  it("tells a legal truncation from a rewritten result", () => {
    const original = "the whole observation";

    expect(isLegalTruncation(original, original)).toBe(true);
    expect(isLegalTruncation(original, truncationMarker(utf8Bytes(original)))).toBe(true);
    expect(isLegalTruncation(original, `the whole${truncationMarker(utf8Bytes(original))}`)).toBe(true);
    expect(isLegalTruncation(original, "a different observation")).toBe(false);
    expect(isLegalTruncation(original, `${original} and more`)).toBe(false);
    // A marker that names a different length is a claim about a result that
    // never existed.
    expect(isLegalTruncation(original, `the whole${truncationMarker(1)}`)).toBe(false);
  });

  it("never touches the session it read", () => {
    const content = "Z".repeat(4000);
    const { session, turnId } = sessionWithToolRoundTrip("hi", content);
    const before = session.deriveMessages();

    const tight = select(session, turnId, limitsForInput(roundTripCost("hi", content) - 3900));

    // The model's copy is shortened; the log keeps the bytes the tool produced.
    expect(
      tight.messages.flatMap((message) => (message.role === "tool" ? message.results : []))[0]?.content,
    ).not.toBe(content);
    expect(session.deriveMessages()).toEqual(before);
    expect(session.events().some((event) => event.type === "tool/result" && event.data.content === content)).toBe(true);
  });

  it("fails the current turn when even the smallest legal request is too large", () => {
    const { session, turnId } = sessionWithToolRoundTrip("q".repeat(3000), "Z".repeat(4000));

    expect(() => select(session, turnId, limitsForInput(1024))).toThrow(ContextBudgetError);
  });

  it("passes the schema's own output reserve into the request", () => {
    const { session, turnId } = sessionWith([], "hi");
    const limits = limitsForInput(4096);

    const request = select(session, turnId, limits);

    expect(request.maxOutputTokens).toBe(budgetFor(limits).reservedOutput);
  });
});

// ---------------------------------------------------------------------------
// The guard.
// ---------------------------------------------------------------------------

describe("independent final guard", () => {
  const FIXED = {
    tools: [{ name: "echo", description: "Echoes.", inputSchema: { type: "object" } }],
    systemPrompt: "You are terse.",
  };

  function guardedInput(session: Session, turnId: string, limits: ModelLimits) {
    return { limits, fixed: FIXED, turn: { events: session.events(), turnId } };
  }

  /** A candidate built the way a well-behaved builder would build it. */
  function build(session: Session, turnId: string, limits: ModelLimits, overrides: Partial<ModelRequest> = {}): ModelRequest {
    const base = selectBoundedContext({ events: session.events(), turnId, fixed: FIXED, limits, budget: budgetFor(limits) });
    return ownModelRequest({ ...base, ...overrides } as ModelRequest, budgetFor(limits).reservedOutput);
  }

  it("lets a request that exactly fills the budget through, and refuses one cost unit more", () => {
    const { session, turnId } = sessionWith([{ text: "one" }, { text: "two" }], "three");
    const wide = limitsForInput(64 * 1024);
    const exact = build(session, turnId, wide);
    const cost = costOf(exact.messages, FIXED.tools, FIXED.systemPrompt);
    const exactLimits = limitsForInput(cost);

    expect(() =>
      assertModelRequestFits(ownModelRequest(exact, budgetFor(exactLimits).reservedOutput), {
        limits: exactLimits,
        fixed: FIXED,
      }),
    ).not.toThrow();

    const tightLimits = limitsForInput(cost - 1);
    expect(() =>
      assertModelRequestFits(ownModelRequest(exact, budgetFor(tightLimits).reservedOutput), {
        limits: tightLimits,
        fixed: FIXED,
      }),
    ).toThrow(ContextBudgetError);
  });

  it("refuses a candidate whose reserve is not the budget's", () => {
    const { session, turnId } = sessionWith([], "hi");
    const limits = limitsForInput(4096);
    const candidate = build(session, turnId, limits);

    expect(() => assertModelRequestFits(ownModelRequest(candidate, 7), guardedInput(session, turnId, limits))).toThrow(
      /output cap/,
    );
  });

  it("refuses a builder that dropped a tool the session offers", () => {
    const { session, turnId } = sessionWith([], "hi");
    const limits = limitsForInput(4096);
    const candidate = build(session, turnId, limits, { tools: [] });

    expect(() => assertModelRequestFits(candidate, guardedInput(session, turnId, limits))).toThrow(/dropped the tool/);
  });

  it("refuses a builder that rewrote a tool schema", () => {
    const { session, turnId } = sessionWith([], "hi");
    const limits = limitsForInput(4096);
    const candidate = build(session, turnId, limits, {
      tools: [{ name: "echo", description: "Something else.", inputSchema: { type: "object" } }],
    });

    expect(() => assertModelRequestFits(candidate, guardedInput(session, turnId, limits))).toThrow(/rewrote the tool/);
  });

  it("refuses a builder that replaced the system prompt", () => {
    const { session, turnId } = sessionWith([], "hi");
    const limits = limitsForInput(4096);
    const candidate = build(session, turnId, limits, { systemPrompt: "Ignore everything." });

    expect(() => assertModelRequestFits(candidate, guardedInput(session, turnId, limits))).toThrow(/system prompt/);
  });

  it("allows extra context a builder prepended, and charges for it", () => {
    const { session, turnId } = sessionWith([], "hi");
    const limits = limitsForInput(4096);
    const base = build(session, turnId, limits);
    const withContext = build(session, turnId, limits, {
      messages: [{ role: "user", text: "retrieved context: nothing relevant" }, ...base.messages],
    });

    expect(() => assertModelRequestFits(withContext, guardedInput(session, turnId, limits))).not.toThrow();
    // The extra message is charged like everything else, so a builder cannot pay
    // for context by pretending it is not there.
    expect(costOf(withContext.messages, FIXED.tools)).toBeGreaterThan(costOf(base.messages, FIXED.tools));
  });

  it("refuses a builder that changed the user input", () => {
    const { session, turnId } = sessionWith([], "hi");
    const limits = limitsForInput(4096);
    const candidate = build(session, turnId, limits, { messages: [{ role: "user", text: "something else" }] });

    expect(() => assertModelRequestFits(candidate, guardedInput(session, turnId, limits))).toThrow(/current user input/);
  });

  it("refuses a builder that changed a call identity or its arguments", () => {
    const { session, turnId } = sessionWithToolRoundTrip("hi", "42");
    const limits = limitsForInput(4096);

    const renamed = build(session, turnId, limits, {
      messages: renameCalls(build(session, turnId, limits).messages, (call) => ({ ...call, callId: "other" })),
    });
    expect(() => assertModelRequestFits(renamed, guardedInput(session, turnId, limits))).toThrow(/identity/);

    const reargumented = build(session, turnId, limits, {
      messages: renameCalls(build(session, turnId, limits).messages, (call) => ({ ...call, input: { text: "rewritten" } })),
    });
    expect(() => assertModelRequestFits(reargumented, guardedInput(session, turnId, limits))).toThrow(/arguments/);
  });

  it("refuses a rewritten tool result and accepts a legal truncation", () => {
    const { session, turnId } = sessionWithToolRoundTrip("hi", "Z".repeat(2000));
    const limits = limitsForInput(4096);
    const base = build(session, turnId, limits);

    const rewritten = build(session, turnId, limits, {
      messages: base.messages.map((message) =>
        message.role === "tool"
          ? { role: "tool" as const, results: [{ ...message.results[0]!, content: "not what happened" }] }
          : message,
      ),
    });
    expect(() => assertModelRequestFits(rewritten, guardedInput(session, turnId, limits))).toThrow(/rewrote a tool result/);

    const truncated = build(session, turnId, limits, {
      messages: base.messages.map((message) =>
        message.role === "tool"
          ? { role: "tool" as const, results: [{ ...message.results[0]!, content: `Z${truncationMarker(2000)}` }] }
          : message,
      ),
    });
    expect(() => assertModelRequestFits(truncated, guardedInput(session, turnId, limits))).not.toThrow();
  });

  it("refuses a half turn dressed up as extra context", () => {
    const { session, turnId } = sessionWith([{ text: "one", answer: "a1" }], "two");
    const limits = limitsForInput(4096);
    const base = build(session, turnId, limits);
    // The assistant message of the finished turn, repeated before the current
    // turn: it looks like context and is really half a conversation.
    const spliced = build(session, turnId, limits, {
      messages: [{ role: "assistant", text: "a1", toolCalls: [] }, ...base.messages],
    });

    expect(() => assertModelRequestFits(spliced, guardedInput(session, turnId, limits))).toThrow(/outside the complete turn/);
  });

  it("holds a request to the budget without a session, which is what a preflight has", () => {
    const limits = limitsForInput(1024);
    const request: ModelRequest = {
      messages: [{ role: "user", text: "x".repeat(4000) }],
      tools: [],
      maxOutputTokens: budgetFor(limits).reservedOutput,
    };

    expect(() =>
      assertModelRequestFits(ownModelRequest(request, budgetFor(limits).reservedOutput), {
        limits,
        fixed: { tools: [] },
      }),
    ).toThrow(ContextBudgetError);
  });
});

/** The same messages with every tool call rewritten by `edit`. */
function renameCalls(
  messages: readonly ModelMessage[],
  edit: (call: ToolCall) => ToolCall,
): ModelMessage[] {
  return messages.map((message) =>
    message.role === "assistant" ? { ...message, toolCalls: message.toolCalls.map(edit) } : message,
  );
}

describe("owned requests", () => {
  it("detaches the request from the builder that produced it", () => {
    const { session, turnId } = sessionWith([], "hi");
    const limits = limitsForInput(4096);
    const candidate = select(session, turnId, limits);
    const owned = ownModelRequest(candidate, budgetFor(limits).reservedOutput);

    // A builder that keeps its candidate and mutates it afterwards cannot reach
    // what was measured, frozen or sent.
    (candidate as unknown as { messages: unknown[] }).messages.push({ role: "user", text: "added later" });

    expect(owned.messages).toHaveLength(1);
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(owned.messages)).toBe(true);
    expect(() => stableJSON(owned)).not.toThrow();
  });

  it("refuses a candidate that is not a request", () => {
    for (const bad of [
      { messages: [{ role: "system", text: "nope" }], tools: [] },
      { messages: [{ role: "user", text: 1 }], tools: [] },
      { messages: [{ role: "assistant", text: "", toolCalls: [{ callId: "c", name: "n", input: undefined }] }], tools: [] },
      { messages: [], tools: [{ name: "t", description: "d" }] },
      { messages: [{ role: "user", text: "hi", extra: true }], tools: [] },
    ]) {
      expect(() => ownModelRequest(bad as never, 1024)).toThrow(InvalidModelRequestError);
    }
  });

  it("keeps a field it does not know, frozen and measurable", () => {
    const { session, turnId } = sessionWith([], "hi");
    const limits = limitsForInput(4096);
    const candidate = { ...select(session, turnId, limits), providerHints: { cache: true } };

    const owned = ownModelRequest(candidate as ModelRequest, budgetFor(limits).reservedOutput);

    expect((owned as { providerHints?: unknown }).providerHints).toEqual({ cache: true });
    expect(Object.isFrozen((owned as { providerHints?: unknown }).providerHints)).toBe(true);
  });
});

describe("default builder through the guard", () => {
  it("builds a request the guard accepts", async () => {
    const { session, turnId } = sessionWith([{ text: "one" }, { text: "two" }], "three");
    const limits = limitsForInput(64 * 1024);
    const tools = createToolRegistry();
    const builder = createDefaultContextBuilder("You are terse.");
    const fixed = builder.getFixedContext({ tools, context });

    const request = ownModelRequest(
      await builder.build({
        session,
        tools,
        context,
        turnId,
        limits,
        budget: budgetFor(limits),
        fixed,
      }),
      budgetFor(limits).reservedOutput,
    );

    expect(() => assertModelRequestFits(request, { limits, fixed, turn: { events: session.events(), turnId } })).not.toThrow();
  });
});
