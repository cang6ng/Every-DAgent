/**
 * A trusted composition for tests: the seam, wired to a scripted model.
 *
 * The host no longer accepts a pre-built model client, and that is the point —
 * a test drives the same entry a product composition does. What this fixture
 * supplies is the *composition* half: it accepts a small, explicit catalogue of
 * provider/model pairs, hands the effective model settings to the caller so a
 * test can assert what the host actually configured, and returns the scripted
 * client.
 *
 * It is a fixture and lives with the fixtures: no host source module imports
 * it, so it cannot become a product path that skips validation.
 */

import type { ContextBuilder, ModelClient } from "@every-dagent/agent-core";
import type {
  ComposeInput,
  ComposedExecution,
  HostSettings,
  ModelSettingsCheck,
  ToolPolicy,
  ToolPolicyView,
  TrustedComposition,
} from "@every-dagent/host";
import type { JsonValue } from "@every-dagent/protocol";

/** One provider/model pair this composition vouches for. */
export interface TestCatalogEntry {
  readonly provider: string;
  readonly model: string;
}

export interface TestCompositionOptions {
  readonly modelClient: ModelClient;
  readonly contextBuilder?: ContextBuilder;
  /**
   * The catalogue this composition accepts. Defaults to accepting any value
   * shaped like `{ provider: string, model: string }` — tests that assert
   * catalogue refusals pass their own.
   */
  readonly catalog?: readonly TestCatalogEntry[];
  /** Called with every accepted value, so a test can see what was configured. */
  readonly onValidate?: (value: JsonValue) => void;
  /** Called when the host composes execution, with the effective settings. */
  readonly onCompose?: (input: ComposeInput) => void;
  /** Return a refusal reason instead of composing. */
  readonly refuseCompose?: string;
  /** The composition's own release path, for lifecycle assertions. */
  readonly dispose?: () => void | Promise<void>;
  /**
   * What this fixture composition decides about tool calls.
   *
   * The default is a policy that speaks about every tool and allows it: this
   * fixture stands in for the trusted composition root, and a test that does
   * not care about policy should see the tools it configured run. A test that
   * *does* care passes its own — with an explicit catalogue, a `require-approval`
   * decision, or a refusal — exactly as a real composition would. `null` is the
   * third case: a composition that deliberately classifies nothing, which is
   * what an unconfigured product composition carries.
   */
  readonly toolPolicy?: ToolPolicy | null;
}

/**
 * The fixture's default policy: every tool this composition was composed with
 * is allowed.
 *
 * It is deliberately not the product default (a host composed without a policy
 * denies everything); it is the *fixture* saying, on the trusted side, that the
 * tools a test handed it may run.
 */
export const TEST_TOOL_POLICY: ToolPolicy = Object.freeze({
  revision: 1,
  decide: (_view: ToolPolicyView): "allow" => "allow",
});

/** The bootstrap a test host starts from unless it says otherwise. */
export const TEST_BOOTSTRAP = Object.freeze({
  host: Object.freeze({
    systemPrompt: "",
    loop: Object.freeze({ maxSteps: 12, maxModelAttempts: 3 }),
  }),
  model: Object.freeze({ provider: "test", model: "test-model" }),
});

/** Whether a value is the closed model-settings shape this fixture accepts. */
function modelShape(value: unknown): { readonly provider: string; readonly model: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const provider = record["provider"];
  const model = record["model"];
  if (typeof provider !== "string" || provider.length === 0) return undefined;
  if (typeof model !== "string" || model.length === 0) return undefined;
  return { provider, model };
}

export function testComposition(options: TestCompositionOptions): TrustedComposition {
  const catalog = options.catalog;
  return {
    toolPolicy: options.toolPolicy === null ? undefined : (options.toolPolicy ?? TEST_TOOL_POLICY),
    validateModel(value: JsonValue): ModelSettingsCheck {
      const shaped = modelShape(value);
      if (shaped === undefined) return { ok: false, reason: "model-settings-shape" };
      if (catalog !== undefined) {
        const known = catalog.some(
          (entry) => entry.provider === shaped.provider && entry.model === shaped.model,
        );
        if (!known) return { ok: false, reason: "unknown-provider-model" };
      }
      options.onValidate?.(value);
      return { ok: true };
    },
    async compose(input: ComposeInput): Promise<ComposedExecution> {
      options.onCompose?.(input);
      if (options.refuseCompose !== undefined) {
        throw new Error(`the test composition refused to compose: ${options.refuseCompose}`);
      }
      return {
        modelClient: options.modelClient,
        ...(options.contextBuilder === undefined ? {} : { contextBuilder: options.contextBuilder }),
        ...(options.dispose === undefined ? {} : { dispose: options.dispose }),
      };
    },
  };
}

/** The effective host settings a test host runs with unless it says otherwise. */
export function testHostSettings(): HostSettings {
  return TEST_BOOTSTRAP.host;
}
