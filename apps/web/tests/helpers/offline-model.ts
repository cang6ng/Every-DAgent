/**
 * The offline model behind the shell's acceptance run.
 *
 * It is a real `ModelClient` — the same contract the pi-ai adapter implements —
 * and it is deliberately not a script: the reply is chosen from what the last
 * user message asks for, so a test can drive every path (plain text, a tool
 * call, a run that keeps asking for steps until the budget runs out, a partial
 * reply that then fails, one that waits for a gate while the host stays busy)
 * by typing the right thing into the page.
 *
 * It never contacts a provider and holds no credential; it exists so the
 * browser acceptance can exercise a real host, registry, loop and runtime
 * without one. It is a test composition and lives with the tests, never in the
 * product bundle.
 */

import type { ModelClient, ModelEvent, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";

import { DANGEROUS_INPUT } from "../../../../tests/fixtures/text-stats-plugin.js";

export const MARKER = {
  /** Ask for the calculator tool (a*b), then answer. */
  calculator: "算一下",
  /** Ask for the text-stats tool, then answer. */
  stats: "统计一下",
  /** Ask for the text-stats tool with input whose *result* is dangerous text. */
  dangerousResult: DANGEROUS_INPUT,
  /** Ask for a tool that keeps asking: the step budget runs out. */
  manySteps: "一直做",
  /** Stream a partial answer, then fail. */
  fail: "然后失败",
  /** Wait for the gate before answering; the host stays busy meanwhile. */
  slow: "慢慢来",
  /** Call the calculator with an input that cannot be shown as JSON. */
  exotic: "奇怪输入",
  /** Anything else: echo a fixed sentence. */
} as const;

export interface OfflineModel {
  readonly client: ModelClient;
  /** Every request the loop built, in order. */
  readonly requests: ModelRequest[];
  /** Releases every reply currently waiting on the `slow` marker. */
  openGate(): void;
  /** How many replies are waiting right now. */
  waiting(): number;
  /**
   * Arms the dangerous-result hold: the next `dangerousResult` run parks at its
   * second step — after its tool result exists and is on its way to the page,
   * before anything settles — until `releaseDangerousResult`.
   *
   * This is acceptance-fixture machinery, not a product capability: it is the
   * one deterministic moment in which a page can be asked about the live card
   * rather than the history it becomes.
   */
  holdNextDangerousResult(): void;
  /** Releases a parked dangerous-result run so it can finish. */
  releaseDangerousResult(): void;
  /** Whether a dangerous-result run is parked right now. */
  dangerousResultParked(): boolean;
}

function lastUserText(request: ModelRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message !== undefined && message.role === "user") return message.text;
  }
  return "";
}

function sawToolResult(request: ModelRequest, name: string): boolean {
  return request.messages.some(
    (message) => message.role === "tool" && message.results.some((result) => result.name === name),
  );
}

export function offlineModel(): OfflineModel {
  const requests: ModelRequest[] = [];
  const gates = new Set<() => void>();
  let callId = 0;
  let holdDangerous = false;
  let dangerousParked = false;
  let releaseParked: (() => void) | null = null;

  function nextCallId(): string {
    callId += 1;
    return `demo-${callId}`;
  }

  /** The dangerous-result hold, as an await the abort signal can also end. */
  async function parkIfArmed(context: RuntimeContext): Promise<void> {
    if (!holdDangerous) return;
    holdDangerous = false;
    dangerousParked = true;
    const released = new Promise<void>((resolveParked) => {
      releaseParked = resolveParked;
    });
    const aborted = new Promise<void>((resolveAborted) => {
      if (context.signal.aborted) {
        resolveAborted();
        return;
      }
      context.signal.addEventListener("abort", () => resolveAborted(), { once: true });
    });
    await Promise.race([released, aborted]);
    dangerousParked = false;
    releaseParked = null;
  }

  async function* reply(request: ModelRequest, context: RuntimeContext): AsyncGenerator<ModelEvent> {
    const text = lastUserText(request);

    if (text.includes(MARKER.slow)) {
      yield { type: "text-delta", text: "正在思考…" };
      const gate = new Promise<void>((resolveGate) => {
        gates.add(resolveGate);
      });
      const aborted = new Promise<void>((resolveAborted) => {
        if (context.signal.aborted) {
          resolveAborted();
          return;
        }
        context.signal.addEventListener("abort", () => resolveAborted(), { once: true });
      });
      await Promise.race([gate, aborted]);
      if (context.signal.aborted) {
        // A cancelled run stops producing, but this model only settles when the
        // test releases it: the window in which the page must show "cancel
        // requested" as its own state, not as a stop.
        await gate;
      }
    }

    if (text.includes(MARKER.fail)) {
      // A partial answer first, then a real failure: the shell has to show a
      // draft that never becomes history.
      yield { type: "text-delta", text: "这是不会进入历史的半句" };
      await new Promise<void>((resolveTick) => {
        setTimeout(resolveTick, 5);
      });
      throw new Error("the offline model was asked to fail");
    }

    if (text.includes(MARKER.manySteps)) {
      // Keep asking for the calculator without ever finishing: the loop spends
      // its whole step budget and the run ends `limited`.
      yield { type: "tool-call", call: { callId: nextCallId(), name: "calculator", input: { a: 2, b: 3 } } };
      yield { type: "done" };
      return;
    }

    if (text.includes(MARKER.calculator) && !sawToolResult(request, "calculator")) {
      yield { type: "tool-call", call: { callId: nextCallId(), name: "calculator", input: { a: 6, b: 7 } } };
      yield { type: "done" };
      return;
    }

    if (text.includes(MARKER.stats) && !sawToolResult(request, "text-stats")) {
      yield { type: "tool-call", call: { callId: nextCallId(), name: "text-stats", input: { text: "hello world" } } };
      yield { type: "done" };
      return;
    }

    if (text.includes(MARKER.dangerousResult)) {
      if (!sawToolResult(request, "text-stats")) {
        // The tool really runs and really answers with its dangerous text; the
        // answer after it stays free of that text, so a page that showed the
        // payload could only have got it from the tool result.
        yield { type: "tool-call", call: { callId: nextCallId(), name: "text-stats", input: { text: DANGEROUS_INPUT } } };
        yield { type: "done" };
        return;
      }
      // The observation exists and is on its way to the live presentation. When
      // the acceptance armed the hold, the run parks here — the one moment the
      // live card can be asserted before it becomes history.
      await parkIfArmed(context);
      yield { type: "text-delta", text: "统计完成。" };
      yield { type: "done" };
      return;
    }

    if (text.includes(MARKER.exotic) && !sawToolResult(request, "calculator")) {
      // `NaN` is not JSON; the host must project the input as unavailable
      // rather than inventing a value for it. The real tool still receives it.
      yield { type: "tool-call", call: { callId: nextCallId(), name: "calculator", input: { a: Number.NaN, b: 1 } } };
      yield { type: "done" };
      return;
    }

    if (text.includes(MARKER.calculator)) {
      const last = request.messages[request.messages.length - 1];
      const result = last !== undefined && last.role === "tool" ? last.results[0]?.content ?? "" : "";
      yield { type: "text-delta", text: `计算结果是 ${result}。` };
      yield { type: "done" };
      return;
    }

    if (text.includes(MARKER.stats)) {
      const last = request.messages[request.messages.length - 1];
      const result = last !== undefined && last.role === "tool" ? last.results[0]?.content ?? "" : "";
      yield { type: "text-delta", text: `统计结果是 ${result}。` };
      yield { type: "done" };
      return;
    }

    yield { type: "text-delta", text: `收到：${text}` };
    yield { type: "done" };
  }

  return {
    client: {
      stream(request: ModelRequest, context: RuntimeContext): AsyncIterable<ModelEvent> {
        requests.push(request);
        return reply(request, context);
      },
    },
    requests,
    openGate(): void {
      for (const resolveGate of [...gates]) resolveGate();
      gates.clear();
    },
    waiting(): number {
      return gates.size;
    },
    holdNextDangerousResult(): void {
      holdDangerous = true;
    },
    releaseDangerousResult(): void {
      const release = releaseParked;
      releaseParked = null;
      release?.();
    },
    dangerousResultParked(): boolean {
      return dangerousParked;
    },
  };
}
