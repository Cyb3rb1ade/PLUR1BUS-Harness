import type { RouteSpec, HandlerInput, HandlerOutput, HandlerDeps } from "../routes.ts";
import { MCP_MAX_BODY_BYTES } from "./types.ts";
import { isAgentMcpExposed, getAgentMcpGroups, type McpServerConfigLike } from "./activation.ts";
import { createDefaultToolRegistry } from "./tools/index.ts";
import { McpServerCore } from "./server.ts";
import { errors } from "../errors.ts";

export const MCP_ROUTES: readonly RouteSpec[] = [
  {
    id: "mcp.server",
    method: "POST",
    path: "/mcp",
    tag: "mcp",
    summary: "MCP server endpoint supporting 2026-07-28 and 2025-11-25 eras",
    auth: "any",
    authz: "delegated",
    csrf: false,
    rate: "rpc",
    transport: "protocol",
    protocol: {
      audience: "mcp",
      maxBodyBytes: MCP_MAX_BODY_BYTES,
      bodyTimeoutMs: 10_000,
      handlerTimeoutMs: 60_000,
    },
    stability: "experimental",
    since: "1.0.0",
    successStatus: 200,
    success: {
      description: "MCP JSON-RPC response or SSE stream",
      schema: { type: "object", additionalProperties: true },
    },
  },
];

export function buildMcpHandlers(d: HandlerDeps): Record<string, (i: HandlerInput) => Promise<HandlerOutput>> {
  return {
    "mcp.server": async (i: HandlerInput): Promise<HandlerOutput> => {
      if (!i.tokenRecord || !i.tokenRecord.binding) {
        throw errors.unauthenticated("authentication required");
      }
      const binding = i.tokenRecord.binding;
      if (binding.audience !== "mcp") {
        throw errors.forbidden("token-audience-mismatch");
      }
      const agentId = binding.agentId;
      const tokenId = i.tokenRecord.id;
      const actor = i.principal?.id ?? tokenId;

      // Resolve config
      const mcpConfig = typeof d.mcpConfig === "function" ? await d.mcpConfig() : d.mcpConfig;
      if (!isAgentMcpExposed(mcpConfig, agentId)) {
        d.audit.emit("mcp.server.denied", actor, `agent:${agentId}`, {
          tokenId,
          tool: "-",
          agentId,
          reason: "agent-not-exposed",
        });
        throw errors.forbidden("agent-not-exposed", "Agent is not exposed over MCP");
      }

      const groups = getAgentMcpGroups(mcpConfig, agentId);
      const tokenGroups = (i.tokenRecord?.binding as any)?.groups as readonly string[] | undefined;
      const effectiveGroups = tokenGroups ? groups.filter(g => tokenGroups.includes(g)) : groups;
      const registry = createDefaultToolRegistry({ secretRedaction: d.secretRedaction });
      const tools = registry.buildTools(effectiveGroups, {
        agentId,
        tokenId,
        rbac: i.rbac,
        core: d.core,
        audit: d.audit,
        actor,
      });

      const server = new McpServerCore({
        tools,
        agentId,
        tokenId,
        rbac: i.rbac,
        core: d.core,
        audit: d.audit,
        actor,
      });

      let preReadBody: unknown;
      if (i.rawBody && i.rawBody.length > 0) {
        try {
          preReadBody = JSON.parse(i.rawBody.toString("utf8"));
        } catch {
          // let server handle parse error
        }
      }

      await server.handleRequest({
        req: i.req!,
        res: i.res!,
        preReadBody,
        rawBody: i.rawBody,
      });

      return { streamed: true };
    },
  };
}
