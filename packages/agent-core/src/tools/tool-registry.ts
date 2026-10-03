import { errorMessageOf, TurnResourceFault } from "../errors.js";
import type { RuntimeContext } from "../runtime/runtime-context.js";
import type { Tool, ToolExecutionResult } from "./tool.js";

/**
 * One registration, as the registry keeps it.
 *
 * The entry is the registry's own record of a registration, and every field in
 * it is captured once, at `register`: the key the tool was registered under,
 * an identity object that belongs to this registration and no other, the tool
 * itself, and the concrete executor read from its `execute` property *then*.
 *
 * That last field is what makes a prepared execution bindable. A plugin is free
 * to rebuild or replace `execute` on the object it registered — nothing in the
 * plugin system forbids it — so a dispatcher that reads `tool.execute` at
 * dispatch time would be running whatever the last writer left there. This
 * entry's `invoke` closes over the function and its receiver as they were at
 * registration, and is the only thing a managed dispatch may call.
 */
export interface ToolRegistration {
  /** The name this registration answers to; a re-registration under it is a new entry. */
  readonly key: string;
  /**
   * This registration's identity. A delete-and-register cycle under the same
   * key produces a different object, which is what lets a prepared execution
   * prove it belongs to the mapping it was prepared against.
   */
  readonly identity: object;
  /** The tool object as it was registered. */
  readonly tool: Tool;
  /**
   * The concrete executor captured at registration, called with the tool as
   * its receiver. Never resolved again from the tool object.
   */
  invoke(input: unknown, context: RuntimeContext): Promise<unknown>;
}

export interface ToolRegistry {
  /**
   * @returns a disposer that unregisters this exact registration. Idempotent,
   * and safe against a name that was unregistered and registered again.
   */
  register(tool: Tool): () => void;
  get(name: string): Tool | undefined;
  list(): Tool[];
  /**
   * The registration one name currently resolves to, or `undefined`.
   *
   * This is the managed execution seam's one lookup: a caller takes the entry
   * (identity, tool, bound executor) and holds it, rather than reading through
   * the registry again at dispatch time.
   */
  registration(name: string): ToolRegistration | undefined;
  /**
   * A monotonic count of this registry's real mapping changes.
   *
   * It starts at zero and advances by one for every successful registration and
   * every successful deletion of a registration that existed. A duplicate
   * registration, a refused one, an idempotent second disposer call and a stale
   * disposer that deletes nothing all leave it unchanged — the number counts
   * what the registry *is*, not what was attempted.
   */
  readonly generation: number;
  /** Never rejects: every failure comes back as `{ ok: false }`. */
  execute(name: string, input: unknown, context: RuntimeContext): Promise<ToolExecutionResult>;
}

export function createToolRegistry(): ToolRegistry {
  return new MapToolRegistry();
}

const MAX_GENERATION = Number.MAX_SAFE_INTEGER;

class MapToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>();
  private current = 0;

  get generation(): number {
    return this.current;
  }

  register(tool: Tool): () => void {
    // The key is read exactly once: a tool whose `name` is mutated afterwards
    // is still registered — and still disposed — under the name it arrived
    // with, the same way any other caller-visible fact is captured at the
    // boundary rather than re-read later.
    const key = tool.name;
    if (this.tools.has(key)) {
      throw new Error(`tool "${key}" is already registered`);
    }
    // The implementation is taken over here, exactly once: from this moment the
    // registration owns the function it will call, so a tool that replaces its
    // own `execute` — a plugin re-binding an object it kept — cannot redirect a
    // dispatch that was already bound to it.
    const execute: unknown = tool.execute;
    const registration: ToolRegistration = {
      key,
      identity: {},
      tool,
      invoke: (input: unknown, context: RuntimeContext): Promise<unknown> => {
        if (typeof execute !== "function") {
          throw new Error(`tool "${key}" has no executable implementation`);
        }
        // The receiver is preserved: `execute` was written for its tool.
        return (execute as Tool["execute"]).call(tool, input, context);
      },
    };
    this.advance();
    this.tools.set(key, registration);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      // Matched by identity, not by name: a stale disposer must not evict a
      // later registration of the same name, and a no-op deletion is not a
      // mapping change.
      if (this.tools.get(key) !== registration) return;
      this.advance();
      this.tools.delete(key);
    };
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  list(): Tool[] {
    return [...this.tools.values()].map((registration) => registration.tool);
  }

  registration(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  async execute(name: string, input: unknown, context: RuntimeContext): Promise<ToolExecutionResult> {
    const registration = this.tools.get(name);
    if (registration === undefined) {
      return { ok: false, error: `unknown tool "${name}"` };
    }

    try {
      return { ok: true, value: await registration.invoke(input, context) };
    } catch (error) {
      // A tool that says the turn itself can no longer be recorded honestly is
      // not a tool that failed: answering it with `ok: false` would report a
      // side effect as a clean miss, so the fault travels out through the one
      // catch every tool call goes through.
      if (error instanceof TurnResourceFault) throw error;
      return { ok: false, error: errorMessageOf(error) };
    }
  }

  /**
   * Advances the generation, or refuses before any mutation when the count can
   * no longer be incremented honestly.
   *
   * A wrapped or clamped generation would let a prepared execution match a
   * mapping it does not belong to, so running out of room stops the change
   * instead of loosening the comparison.
   */
  private advance(): void {
    if (this.current >= MAX_GENERATION) {
      throw new Error("the tool registry's generation is exhausted");
    }
    this.current += 1;
  }
}
