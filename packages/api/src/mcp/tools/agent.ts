import { createSecretRedaction, redactProtocolValue } from "../../../../core/src/secrets/redaction.ts";
import { ApiError } from "../../errors.ts";
import type { McpToolContext, McpToolDef } from "../types.ts";
import type { McpToolGroup } from "./group.ts";

export interface AgentToolGroupOptions {
  secretRedaction?: ReturnType<typeof createSecretRedaction> | undefined;
}

export class AgentToolGroup implements McpToolGroup {
  readonly name = "agent";
  private readonly secretRedaction: ReturnType<typeof createSecretRedaction>;

  constructor(options: AgentToolGroupOptions = {}) {
    this.secretRedaction = options.secretRedaction ?? createSecretRedaction();
  }

  buildTools(ctx: McpToolContext): readonly McpToolDef[] {
    const askTool: McpToolDef = {
      name: "agent_ask",
      description: "Runs an external turn with the bound harness agent.",
      group: "agent",
      inputSchema: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string", description: "The task or prompt for the agent." },
          attachments: { type: "array", items: { type: "string" }, description: "Optional attachment paths or IDs." },
        },
      },
      handler: async (args, toolCtx) => {
        const message = typeof args.message === "string" ? args.message.trim() : "";
        if (!message) throw new Error("message is required");
        const agentId = toolCtx?.agentId ?? ctx.agentId;
        const core = toolCtx?.core ?? ctx.core;

        if (!core || typeof (core as any).call !== "function") {
          throw new ApiError(503, "E_CORE_UNAVAILABLE", "Core service unavailable", { reason: "core-unavailable" });
        }

        const tokenId = toolCtx?.tokenId ?? ctx.tokenId;
        const res = await (core as any).call("external.turn.start", {
          agentId,
          message,
          audience: "mcp",
          ...(tokenId !== undefined ? { tokenId } : {}),
          wait: true,
        });
        return redactProtocolValue(res, "mcp", this.secretRedaction);
      },
    };

    const statusTool: McpToolDef = {
      name: "agent_status",
      description: "Returns the current state and capabilities of the bound harness agent.",
      group: "agent",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (_args, toolCtx) => {
        const agentId = toolCtx?.agentId ?? ctx.agentId;
        const core = toolCtx?.core ?? ctx.core;

        if (!core || typeof (core as any).call !== "function") {
          throw new ApiError(503, "E_CORE_UNAVAILABLE", "Core service unavailable", { reason: "core-unavailable" });
        }

        const res = await (core as any).call("agent.read", { agentId });
        return redactProtocolValue(res, "mcp", this.secretRedaction);
      },
    };

    return [askTool, statusTool];
  }
}
