/**
 * The trusted tool policy seam: what a composition says about the tools a host
 * may run, and how the host holds it.
 *
 * The policy is *trusted input*, in the same sense the model catalogue and the
 * endpoint allowlist are: it comes from the composition root, it is validated
 * once at startup, and from that moment the host holds its own frozen copy —
 * the caller keeps nothing that could change what it hands a tool. Nothing a
 * plugin or a tool says about itself is consulted here: a tool that wants
 * permission asks the composition, never itself.
 *
 * The default is the important half. A host composed without a policy
 * classifies nothing, and an unclassified tool is `deny` — not "ask", not
 * "allow until configured". Running a tool the trusted side never spoke about
 * is exactly the thing an approval gate exists to prevent, so silence is a
 * refusal rather than a gap to be filled in later.
 *
 * One decision function, three possible answers, no fourth: `allow`
 * (authorized outright), `deny` (never runs), `require-approval` (runs only
 * after a client's approval, within the host's deadline). Anything else — a
 * throw, a promise, an object, a missing answer — is a policy that failed to
 * decide, and a call it could not decide does not execute. The callback is
 * synchronous by contract; awaiting it would make "which decision applied"
 * depend on scheduling, and a policy has no business being asynchronous.
 */

import type { Tool } from "@every-dagent/agent-core";
import type { JsonValue } from "@every-dagent/protocol";

/** The three decisions an execution may be given. */
export type ToolPolicyDecision = "allow" | "deny" | "require-approval";

/**
 * What one call shows the policy.
 *
 * It is deliberately the smallest set of facts a decision could need, and it
 * carries no capability of any kind: no executor, no receiver, no registry, no
 * repository, no connection, no resolver. A policy that could reach one of
 * those would be able to *perform* what it is only entitled to *decide*.
 *
 * `toolIdentity` is an opaque, host-minted identity of the exact registration
 * the call resolved to. Two tools with the same name have different
 * identities, and a policy that wants to speak about one of them can.
 */
export interface ToolPolicyView {
  readonly toolIdentity: string;
  readonly toolName: string;
  /** The owned, safe arguments — the same frozen value the execution was prepared with. */
  readonly input: JsonValue;
  readonly executionId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly callIndex: number;
}

/**
 * What a trusted composition hands the host.
 *
 * `tools` is an optional catalogue of exact tool objects this policy speaks
 * about. Given, the host classifies only those — a call on any other tool is
 * denied without asking, because a policy that enumerated its subject matter
 * has not vouched for anything else. Absent, the policy speaks about every
 * registered tool and `decide` alone answers.
 *
 * `decide` is consulted only for a call on a tool the policy classifies.
 */
export interface ToolPolicy {
  /** The host-lifetime immutable revision; validated at startup and never reloaded. */
  readonly revision: number;
  /** The exact tool objects this policy speaks about; absent means "every tool". */
  readonly tools?: readonly Tool[];
  decide(view: ToolPolicyView): ToolPolicyDecision;
}

/**
 * The host's own copy of a policy: validated, frozen, and captured by value.
 *
 * `catalogue` is a frozen `Set` of the exact tool objects, `decide` is the
 * function reference taken once — so a caller that later rewrites the policy
 * object it passed in changes nothing about this host's decisions.
 */
export interface CapturedToolPolicy {
  readonly revision: number;
  readonly catalogue: ReadonlySet<Tool> | undefined;
  readonly decide: (view: ToolPolicyView) => unknown;
}

/**
 * Validates one policy and takes the host's copy of it.
 *
 * Left out entirely, the host runs with a policy that classifies nothing —
 * which denies every call. Anything present but unusable stops the host from
 * being constructed: a revision that is not a whole number, a `tools` list
 * with a duplicate, an entry that is not a tool, or a missing decision
 * function are configuration mistakes, and configuration mistakes are the one
 * class of error this host refuses to start with.
 */
export function captureToolPolicy(policy: ToolPolicy | undefined): CapturedToolPolicy {
  if (policy === undefined) {
    return Object.freeze({ revision: 0, catalogue: Object.freeze(new Set<Tool>()), decide: () => "deny" });
  }
  if (typeof policy !== "object" || policy === null) {
    throw new Error("the trusted tool policy is not an object");
  }
  const revision = policy.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("the trusted tool policy's revision is not a whole, non-negative number");
  }
  if (typeof policy.decide !== "function") {
    throw new Error("the trusted tool policy has no decision function");
  }

  let catalogue: ReadonlySet<Tool> | undefined;
  if (policy.tools !== undefined) {
    if (!Array.isArray(policy.tools)) throw new Error("the trusted tool policy's tool catalogue is not a list");
    const tools = new Set<Tool>();
    for (const tool of policy.tools) {
      if (typeof tool !== "object" || tool === null) {
        throw new Error("the trusted tool policy names a tool that is not an object");
      }
      if (tools.has(tool)) {
        throw new Error("the trusted tool policy names the same tool twice");
      }
      tools.add(tool);
    }
    catalogue = Object.freeze(tools);
  }

  return Object.freeze({ revision, catalogue, decide: policy.decide });
}

/** What one policy consultation produced: a decision, or the fact that it failed. */
export type PolicyCallOutcome =
  | { readonly ok: true; readonly decision: ToolPolicyDecision }
  | { readonly ok: false };

/**
 * Runs the policy's callback and refuses everything that is not a decision.
 *
 * The callback may misbehave in any way a function can — throw, return a
 * promise (a decision that is not there yet is not a decision), return an
 * object, return nothing — and every one of those endings means the same
 * thing: no decision was made, and a call with no decision does not run.
 */
export function consultPolicy(decide: (view: ToolPolicyView) => unknown, view: ToolPolicyView): PolicyCallOutcome {
  let answer: unknown;
  try {
    answer = decide(view);
  } catch {
    return { ok: false };
  }
  if (answer === "allow" || answer === "deny" || answer === "require-approval") {
    return { ok: true, decision: answer };
  }
  return { ok: false };
}
