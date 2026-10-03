import { errorMessageOf, TurnResourceFault } from "../errors.js";
import type { RuntimeContext } from "../runtime/runtime-context.js";
import type { Tool, ToolExecutionResult } from "./tool.js";

export interface ToolRegistry {
  /**
   * @returns a disposer that unregisters this exact registration. Idempotent,
   * and safe against a name that was unregistered and registered again.
   */
  register(tool: Tool): () => void;
  get(name: string): Tool | undefined;
  list(): Tool[];
  /** Never rejects: every failure comes back as `{ ok: false }`. */
  execute(name: string, input: unknown, context: RuntimeContext): Promise<ToolExecutionResult>;
}

export function createToolRegistry(): ToolRegistry {
  return new MapToolRegistry();
}

class MapToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): () => void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);

    let disposed = false;
    return () => {
      // Guarded so that a stale disposer cannot evict a later registration of
      // the same name.
      if (disposed) return;
      disposed = true;
      this.tools.delete(tool.name);
    };
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  async execute(name: string, input: unknown, context: RuntimeContext): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return { ok: false, error: `unknown tool "${name}"` };
    }

    try {
      return { ok: true, value: await tool.execute(input, context) };
    } catch (error) {
      // A tool that says the turn itself can no longer be recorded honestly is
      // not a tool that failed: answering it with `ok: false` would report a
      // side effect as a clean miss, so the fault travels out through the one
      // catch every tool call goes through.
      if (error instanceof TurnResourceFault) throw error;
      return { ok: false, error: errorMessageOf(error) };
    }
  }
}
