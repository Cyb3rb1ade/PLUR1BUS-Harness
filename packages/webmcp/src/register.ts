// Registers provider tools with the page's ModelContext. Feature-detected: a browser without WebMCP
// gets a no-op handle (D55: "The page feature-detects navigator.modelContext and does nothing
// without it").
import { nativeProvide, nativeRegister, toNativeTool, type ModelContextLike, type NativeTool } from "./adapter.ts";
import type { WebMcpTool } from "./types.ts";

export interface Registration {
  unregister(): void;
}
export interface RegisterOptions {
  /** Called when the browser refuses a tool (sync throw or async rejection, e.g. a duplicate name
   *  registered by other page code). The tool is then treated as not registered. */
  onError?: (toolName: string, err: unknown) => void;
}

interface Entry {
  native: NativeTool;
  undo: (() => void) | undefined; // undefined = provideContext mode
  owner: symbol;
}

// Per ModelContext, the tools this package registered (by name). Makes registration idempotent: a
// second register of the same name replaces the first instead of colliding with it.
const registry = new WeakMap<object, Map<string, Entry>>();

function provideAll(mc: ModelContextLike, entries: Map<string, Entry>): void {
  nativeProvide(
    mc,
    [...entries.values()].filter((e) => e.undo === undefined).map((e) => e.native),
  );
}

export function registerPlur1busTools(modelContext: ModelContextLike | undefined | null, tools: readonly WebMcpTool[], options: RegisterOptions = {}): Registration {
  const mc = modelContext;
  if (!mc || typeof mc !== "object" || (typeof mc.registerTool !== "function" && typeof mc.provideContext !== "function")) {
    return { unregister() {} };
  }
  let entries = registry.get(mc);
  if (!entries) {
    entries = new Map();
    registry.set(mc, entries);
  }
  const map = entries;
  const owner = Symbol("registration");
  const useRegister = typeof mc.registerTool === "function";
  let provideDirty = false;

  for (const tool of tools) {
    const previous = map.get(tool.name);
    if (previous) {
      map.delete(tool.name);
      if (previous.undo) previous.undo();
      else provideDirty = true;
    }
    const native = toNativeTool(tool);
    if (useRegister) {
      const entry: Entry = { native, undo: () => {}, owner };
      map.set(tool.name, entry);
      const undo = nativeRegister(mc, native, (err) => {
        if (map.get(tool.name) === entry) map.delete(tool.name);
        options.onError?.(tool.name, err);
      });
      if (undo) entry.undo = undo;
    } else {
      map.set(tool.name, { native, undo: undefined, owner });
      provideDirty = true;
    }
  }
  if (provideDirty) provideAll(mc, map);

  let done = false;
  return {
    unregister() {
      if (done) return;
      done = true;
      let dirty = false;
      for (const [name, entry] of [...map]) {
        if (entry.owner !== owner) continue; // replaced by a later registration: not ours any more
        map.delete(name);
        if (entry.undo) entry.undo();
        else dirty = true;
      }
      if (dirty) provideAll(mc, map);
    },
  };
}
