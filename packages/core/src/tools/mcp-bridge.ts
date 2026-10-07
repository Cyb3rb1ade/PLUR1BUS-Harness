// D109 §7: third-party MCP tools reach an agent only as registered tools, so the dispatcher's `policy.decide` gates every call.
// `McpRegistry.callTool` runs a server's tool with no policy of its own (ADR-014 left that to the turn loop); this bridge is the one
// place that calls it for an agent, and only from a `ToolDef.execute` that the dispatcher invokes after the gate.
//
// Classification (§2, §7): capability `net.submit` ("MCP `external` tools"); the effect is `external` unless the server's annotations
// RAISE it (`fromMcp`: a `readOnlyHint` never lowers it); the call counts as outside the roots (fail closed: approval). The caller
// identity is the dispatch context's agent and principal, never anything from the arguments.
import { fromMcp, type Effect, type McpAnnotations } from "../policy/effects.ts";
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
}
export type McpSkipReason = "schema" | "name" | "too-long" | "collision";
export interface McpBridgeResult { tools: ToolDef[]; skipped: { tool: string; reason: McpSkipReason }[] }

const MAX_NAME = 64;
const MAX_DESCRIPTION = 1000;

function safe(part: string): string | null {
  const s = part.toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
  return /[a-z0-9]/.test(s) ? s : null;
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
    if (seen.has(name)) { skipped.push({ tool: d.name, reason: "collision" }); continue; }
    seen.add(name);
    const ann = (d.annotations ?? {}) as McpAnnotations;
    const effect: Effect = fromMcp(undefined, ann);
    // `external` already outranks `local-destructive`, so a destructive hint raises through the call's flags instead: irreversible (risk +1).
    const destructive = ann.destructiveHint === true;
    const upstream = d.name;
    tools.push({
      name,
      description: (d.description ?? d.title ?? d.name).slice(0, MAX_DESCRIPTION),
      inputSchema: d.inputSchema,
      capability: "net.submit",
      effect,
      risk: destructive || effect !== "external" ? "high" : "medium",
      trust: o.trust ?? "untrusted",
      limits: { timeoutMs: 65_000, maxResultBytes: HARD_MAX_RESULT_BYTES },
      classify: () => ({ flags: { outsideRoots: true, ...(destructive ? { irreversible: true } : {}) } }),
      execute: (args, ctx) => port.callTool(server, upstream, (args ?? {}) as Record<string, unknown>, { agentId: ctx.agentId, principal: ctx.principal }, ctx.signal),
    });
  }
  return { tools, skipped };
}

