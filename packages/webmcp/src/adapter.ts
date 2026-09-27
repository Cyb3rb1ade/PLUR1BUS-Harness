// The one module that knows about WebMCP API revisions (spec D55: "isolates API differences behind one
// adapter"). Two shapes exist in the wild:
//
//  - current CG draft (webmachinelearning.github.io/webmcp, Draft CG Report 2026-09-26):
//      document.modelContext.registerTool(tool, { signal, exposedTo? }) -> Promise<undefined>
//      unregistration by aborting `signal`; no unregisterTool/provideContext;
//      execute(input, { signal }); duplicate names reject with InvalidStateError;
//      the resolved value is JSON-serialised by the browser.
//  - early shape (Chrome 146 behind a flag; navigator.modelContext, deprecated in Chromium 150):
//      navigator.modelContext.registerTool(tool) (sync; some builds returned { unregister() }),
//      unregisterTool(name), provideContext({ tools }), clearContext();
//      execute(input, client) with client.requestUserInteraction(cb).
//
// Everything else in the package speaks the canonical shapes in types.ts.
import type { ExecuteContext, ToolResult, WebMcpTool } from "./types.ts";

/** Structural view of a browser's ModelContext, loose enough for both revisions. */
export interface ModelContextLike {
  registerTool?: (tool: NativeTool, options?: { signal?: AbortSignal }) => unknown;
  unregisterTool?: (name: string) => unknown;
  provideContext?: (context: { tools: NativeTool[] }) => unknown;
  clearContext?: () => unknown;
  getTools?: (options?: { fromOrigins?: string[] }) => Promise<unknown[]>;
}

/** The object handed to the browser. */
export interface NativeTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  execute(input: unknown, arg?: unknown): Promise<ToolResult>;
}

/** Finds the page's ModelContext: `document.modelContext` (current draft) first, then the deprecated
 *  `navigator.modelContext`. Returns undefined when neither exists (no WebMCP in this browser). */
export function getModelContext(scope: unknown = globalThis): ModelContextLike | undefined {
  const g = scope as { document?: { modelContext?: unknown }; navigator?: { modelContext?: unknown } } | undefined;
  const mc = g?.document?.modelContext ?? g?.navigator?.modelContext;
  return mc && typeof mc === "object" ? (mc as ModelContextLike) : undefined;
}

/** Normalises execute's second argument across revisions. */
export function normalizeExecuteContext(arg: unknown): ExecuteContext {
  const out: ExecuteContext = {};
  if (!arg || typeof arg !== "object") return out;
  const a = arg as { signal?: unknown; requestUserInteraction?: unknown };
  if (typeof AbortSignal !== "undefined" && a.signal instanceof AbortSignal) out.signal = a.signal;
  if (typeof a.requestUserInteraction === "function") {
    const fn = a.requestUserInteraction as (cb: () => unknown) => unknown;
    out.requestUserInteraction = async <T>(cb: () => Promise<T> | T): Promise<T> => (await fn.call(arg, cb)) as T;
  }
  return out;
}

export function toNativeTool(tool: WebMcpTool): NativeTool {
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { ...tool.annotations } as Record<string, boolean>,
    execute: (input: unknown, arg?: unknown) => tool.execute(input ?? {}, normalizeExecuteContext(arg)),
  };
}

/** Registers one tool through `registerTool`, whichever revision. Returns the undo function, or
 *  undefined when this ModelContext has no `registerTool`. Never throws; a synchronous throw or an
 *  async rejection (e.g. InvalidStateError for a duplicate name) is reported through `onError`. */
export function nativeRegister(mc: ModelContextLike, tool: NativeTool, onError: (err: unknown) => void): (() => void) | undefined {
  if (typeof mc.registerTool !== "function") return undefined;
  const controller = new AbortController();
  let ret: unknown;
  try {
    ret = mc.registerTool(tool, { signal: controller.signal });
  } catch (err) {
    onError(err);
    return () => {};
  }
  if (ret && typeof (ret as Promise<unknown>).then === "function") {
    (ret as Promise<unknown>).then(undefined, onError);
  }
  const handle = ret && typeof (ret as { unregister?: unknown }).unregister === "function" ? (ret as { unregister(): unknown }) : undefined;
  return () => {
    controller.abort(); // current draft
    try {
      if (handle) handle.unregister(); // early builds that returned a registration object
      else if (typeof mc.unregisterTool === "function") mc.unregisterTool(tool.name); // early shape
    } catch {
      /* already gone */
    }
  };
}

/** Replaces the whole tool set through the early `provideContext` API. Returns false when absent. */
export function nativeProvide(mc: ModelContextLike, tools: NativeTool[]): boolean {
  if (typeof mc.provideContext !== "function") return false;
  try {
    if (tools.length === 0 && typeof mc.clearContext === "function") mc.clearContext();
    else mc.provideContext({ tools });
  } catch {
    /* best effort */
  }
  return true;
}

/** Normalises what `executeTool`/a page tool returned into an MCP tool result. The current draft
 *  hands back a JSON string; the early shape handed back the callback's value unchanged. */
export function normalizePageToolResult(value: unknown): ToolResult {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { content: [{ type: "text", text: v as string }] };
    }
  }
  if (v && typeof v === "object" && Array.isArray((v as { content?: unknown }).content)) {
    const r = v as { content: unknown[]; isError?: unknown };
    const content = r.content.map((c) =>
      c && typeof c === "object" && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string"
        ? { type: "text" as const, text: (c as { text: string }).text }
        : { type: "text" as const, text: JSON.stringify(c) ?? "null" },
    );
    return r.isError === true ? { content, isError: true } : { content };
  }
  return { content: [{ type: "text", text: v === undefined ? "" : (JSON.stringify(v) ?? String(v)) }] };
}
