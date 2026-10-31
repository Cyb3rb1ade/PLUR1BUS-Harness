// D109 §7: third-party MCP tools reach an agent only as registered tools, so the dispatcher's `policy.decide` gates every call.
// `McpRegistry.callTool` runs a server's tool with no policy of its own (ADR-014 left that to the turn loop); this bridge is the one
// place that calls it for an agent, and only from a `ToolDef.execute` that the dispatcher invokes after the gate.
//
// Classification uses the installed extension's declared effect when present. Unspecified tools remain external;
// server annotations only raise effects. MCP-specific capabilities keep filesystem/shell grants from authorizing
// an unrelated server. Caller identity comes from the dispatch context, never tool arguments.
import { fromExtensionEffect, fromMcp, maxEffect, type Effect, type McpAnnotations } from "../policy/effects.ts";
import type { McpCaller, McpToolDescriptor, McpToolResult } from "../mcp/types.ts";
import type { ToolDef, ToolTrust } from "./registry.ts";
import { HARD_MAX_RESULT_BYTES } from "./registry.ts";

/** The slice of `McpRegistry` the bridge needs (a test double implements it). */
export interface McpToolPort {
  listTools(server: string, caller: McpCaller, o?: { refresh?: boolean; signal?: AbortSignal }): Promise<readonly McpToolDescriptor[]>;
  callTool(server: string, tool: string, args: Record<string, unknown>, caller: McpCaller, signal?: AbortSignal): Promise<McpToolResult>;
}

export interface McpBridgeOptions {
  /** Origin trust (D19). Default `untrusted`. */
  trust?: ToolTrust;
  signal?: AbortSignal;
  refresh?: boolean;
  /** Host-verified installed manifest declarations; never accepted from a server's own descriptors. */
  declaration?: McpExtensionDeclaration;
}
/** The subset of an installed extension's capabilities needed to classify its tools. */
export interface McpExtensionDeclaration {
  tools: readonly { name: string; effect: "read" | "write" | "destructive" }[];
  network: "none" | "declared";
}
export type McpSkipReason = "schema" | "name" | "too-long" | "collision";
export interface McpBridgeResult { tools: ToolDef[]; skipped: { tool: string; reason: McpSkipReason }[] }

const MAX_NAME = 64;
const MAX_DESCRIPTION = 1000;

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 24;

/**
 * A server's input schema is third-party input that this process evaluates and sends to the model on every turn. Returns a
 * clone without `pattern` (a server-chosen regular expression such as `^(a+)+$` would run in this process on
 * model-chosen text and could freeze it; the server validates its own arguments anyway), or null when the schema is too
 * large or too deep to be a plausible tool description.
 */
export function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> | null {
  let json: string | undefined;
  try { json = JSON.stringify(schema); } catch { return null; }
  if (json === undefined || json.length > MAX_SCHEMA_BYTES) return null;
  let tooDeep = false;
  const strip = (v: unknown, depth: number): unknown => {
    if (depth > MAX_SCHEMA_DEPTH) { tooDeep = true; return null; }
    if (Array.isArray(v)) return v.map((x) => strip(x, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!(k === "pattern" && typeof x === "string")) out[k] = strip(x, depth + 1);
      return out;
    }
    return v;
  };
  const clean = strip(JSON.parse(json), 0);
  return tooDeep ? null : (clean as Record<string, unknown>);
}

function safe(part: string): string | null {
  const s = part.toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
  return /[a-z0-9]/.test(s) ? s : null;
}

function declaredEffect(declaration: McpExtensionDeclaration | undefined, name: string): Effect | undefined {
  let effect: Effect | undefined;
  for (const tool of declaration?.tools ?? []) {
    if (tool.name !== name) continue;
    const next = fromExtensionEffect(tool.effect, declaration!.network);
    // A repeated declaration must never let the first, weaker entry lower the effective permission.
    effect = effect === undefined ? next : maxEffect(effect, next);
  }
  return effect;
}

function capabilityFor(effect: Effect): string {
  switch (effect) {
    case "read": return "mcp.tool.read";
    case "local-write": return "mcp.tool.write";
    case "local-destructive": return "mcp.tool.destructive";
    case "external":
    case "network.a2a":
    case "money": return "net.submit";
  }
}

export async function mcpToolDefs(port: McpToolPort, server: string, caller: McpCaller, o: McpBridgeOptions = {}): Promise<McpBridgeResult> {
  const descriptors = await port.listTools(server, caller, { ...(o.refresh ? { refresh: true } : {}), ...(o.signal ? { signal: o.signal } : {}) });
  const serverPart = safe(server);
  const tools: ToolDef[] = [];
  const skipped: McpBridgeResult["skipped"] = [];
  const seen = new Set<string>();
  for (const d of descriptors) {
    const toolPart = typeof d.name === "string" ? safe(d.name) : null;
    if (!serverPart || !toolPart) { skipped.push({ tool: String(d.name), reason: "name" }); continue; }
    const name = `mcp.${serverPart}.${toolPart}`;
    if (name.length > MAX_NAME) { skipped.push({ tool: d.name, reason: "too-long" }); continue; }
    if (!d.inputSchema || typeof d.inputSchema !== "object" || d.inputSchema.type !== "object") { skipped.push({ tool: d.name, reason: "schema" }); continue; }
    const inputSchema = sanitizeSchema(d.inputSchema);
    if (!inputSchema) { skipped.push({ tool: d.name, reason: "schema" }); continue; }
    if (seen.has(name)) { skipped.push({ tool: d.name, reason: "collision" }); continue; }
    seen.add(name);
    const ann = (d.annotations ?? {}) as McpAnnotations;
    const effect = fromMcp(declaredEffect(o.declaration, d.name), ann);
    // Network writes rank above local destruction; retain the irreversible flag in either case.
    const destructive = ann.destructiveHint === true ||
      o.declaration?.tools.some(tool => tool.name === d.name && tool.effect === "destructive") === true;
    const upstream = d.name;
    tools.push({
      name,
      description: (d.description ?? d.title ?? d.name).slice(0, MAX_DESCRIPTION),
      inputSchema,
      capability: capabilityFor(effect),
      effect,
      risk: destructive || effect === "local-destructive" ? "high" : effect === "read" ? "low" : "medium",
      trust: o.trust ?? "untrusted",
      limits: { timeoutMs: 65_000, maxResultBytes: HARD_MAX_RESULT_BYTES },
      classify: () => ({ flags: { outsideRoots: true, ...(destructive ? { irreversible: true } : {}) } }),
      execute: (args, ctx) => port.callTool(server, upstream, (args ?? {}) as Record<string, unknown>, { agentId: ctx.agentId, principal: ctx.principal }, ctx.signal),
    });
  }
  return { tools, skipped };
}

