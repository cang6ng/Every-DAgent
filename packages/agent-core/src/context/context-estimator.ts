/**
 * What a request costs, before a provider ever sees it.
 *
 * The estimate is deliberately not a token count. It is a *conservative
 * semantic cost*: the UTF-8 bytes of a stable JSON representation of everything
 * the request carries, plus the extra escaping a provider adds when it embeds
 * tool arguments as JSON text inside JSON, plus the adapter's declared framing
 * for the structure around the content. It is finite, deterministic and
 * provider-neutral, and those three properties are what make it something a
 * guard can hold a request to:
 *
 * - every part of the request is measured, because the representation is built
 *   from the request itself and not from a list of fields this file remembers
 *   to include;
 * - the same frozen request always costs the same, so a selection made once can
 *   be re-checked later without rebuilding it;
 * - nothing here knows what a model is. A provider whose real tokenizer is
 *   cheaper than this estimate simply has room left over, and the safety margin
 *   exists because a provider whose tokenizer is more expensive cannot be
 *   modelled from here at all.
 */

import type { ModelFramingCost, ModelLimits } from "./model-budget.js";
import type { ModelMessage, ToolCall } from "../model/message.js";
import type { ModelRequest } from "../model/model-client.js";
import { neutralBytes, stableJSON, utf8Bytes } from "./stable-json.js";

/**
 * The extra escaping one tool call's arguments cost on the wire.
 *
 * pi-ai's OpenAI-compatible path sends arguments as a JSON *string* inside the
 * request body, so every quote and backslash in the arguments is escaped twice.
 * The fixed framing cannot cover that — it depends on the arguments themselves
 * — so it is computed per call: the difference between the arguments' own text
 * and that text as a JSON string token, which is exactly what the second layer
 * adds.
 */
function argumentEscapingBytes(call: ToolCall): number {
  const text = stableJSON(call.input);
  return escapedTokenBytes(text) - utf8Bytes(text);
}

/**
 * The byte length of `text` as a JSON string token, quotes included.
 *
 * Counted rather than built: this runs inside a binary search over candidate
 * prefixes, and the point of measuring a bound is not to allocate the thing the
 * bound protects against.
 */
function escapedTokenBytes(text: string): number {
  let bytes = 2;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

/** The structural elements one request declares, for the framing count. */
interface FramingCounts {
  readonly systems: number;
  readonly messages: number;
  readonly toolDefinitions: number;
  readonly toolCalls: number;
  readonly toolResults: number;
}

function countsOf(request: ModelRequest): FramingCounts {
  let messages = 0;
  let toolCalls = 0;
  let toolResults = 0;

  for (const message of request.messages as readonly ModelMessage[]) {
    messages += 1;
    if (message.role === "assistant") toolCalls += message.toolCalls.length;
    else if (message.role === "tool") toolResults += message.results.length;
  }

  return {
    systems: request.systemPrompt === undefined ? 0 : 1,
    messages,
    toolDefinitions: request.tools.length,
    toolCalls,
    toolResults,
  };
}

function framingCost(framing: ModelFramingCost, counts: FramingCounts): number {
  return (
    framing.request +
    counts.systems * framing.system +
    counts.messages * framing.message +
    counts.toolDefinitions * framing.toolDefinition +
    counts.toolCalls * framing.toolCall +
    counts.toolResults * framing.toolResult
  );
}

/**
 * What one request costs, as an upper bound this program is willing to defend.
 *
 * The content term is the request's own stable JSON, so a custom builder that
 * adds a field this Core has never heard of is charged for it, and one that
 * removes a field is charged less — there is nothing to forget to measure. The
 * escaping term covers the second encoding layer tool arguments pick up. The
 * framing term covers the structure a provider's own body adds around all of it.
 */
export function estimateRequestCost(request: ModelRequest, limits: ModelLimits): number {
  let cost = neutralBytes(request);

  for (const message of request.messages as readonly ModelMessage[]) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls) cost += argumentEscapingBytes(call);
  }

  return cost + framingCost(limits.framing, countsOf(request));
}
