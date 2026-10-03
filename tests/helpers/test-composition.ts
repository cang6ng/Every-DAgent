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
}

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
