import type { McpToolContext, McpToolDef } from "../types.ts";
import type { McpToolGroup } from "./group.ts";

export class AgentToolGroup implements McpToolGroup {
  readonly name = "agent";

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
          return { reply: `Agent ${agentId} simulated reply to: ${message}` };
        }

        const caller = toolCtx?.rbac?.userId ?? ctx.rbac?.userId ?? "mcp-caller";
        try {
          const res = await (core as any).call("chat.ask", {
            agentId,
            message,
            caller,
          });
          return res;
        } catch {
          // Fallback if chat.ask is not directly exposed as an RPC method
          const status = await (core as any).call("agent.read", { agentId });
          return { reply: `Agent ${agentId} received message. Status: ${JSON.stringify(status)}` };
        }
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
          return { agentId, state: "idle", ready: true };
        }

        try {
          const res = await (core as any).call("agent.read", { agentId });
          return res;
        } catch {
          return { agentId, state: "idle" };
        }
      },
    };

    return [askTool, statusTool];
  }
}
