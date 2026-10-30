import { createSecretRedaction, redactProtocolValue } from "../../../../core/src/secrets/redaction.ts";
import { ApiError } from "../../errors.ts";
import type { McpToolContext, McpToolDef } from "../types.ts";
import type { McpToolGroup } from "./group.ts";

export interface MemoryToolGroupOptions {
  secretRedaction?: ReturnType<typeof createSecretRedaction> | undefined;
  includeStore?: boolean | undefined;
}

export class MemoryToolGroup implements McpToolGroup {
  readonly name = "memory";
  private readonly secretRedaction: ReturnType<typeof createSecretRedaction>;
  private readonly includeStore: boolean;

  constructor(options: MemoryToolGroupOptions = {}) {
    this.includeStore = options.includeStore ?? true;
    this.secretRedaction = options.secretRedaction ?? createSecretRedaction();
  }

  buildTools(ctx: McpToolContext): readonly McpToolDef[] {
    const binding = (ctx.rbac as any)?.binding;
    if (binding?.groups && !binding.groups.includes("memory")) {
      return [];
    }

    const boundMemory = binding?.memory;
    const tools: McpToolDef[] = [];

    const recallTool: McpToolDef = {
      name: "memory_recall",
      description: "Recalls relevant memory blocks for the bound agent context.",
      group: "memory",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search query text." },
          capChars: { type: "integer", description: "Optional character budget for recalled blocks." },
          filter: { type: "object", description: "Optional memory filter." },
          disclose: { type: "string", enum: ["always", "never", "user-only"], description: "Optional disclosure policy." },
          project: { type: "string", description: "Optional project scope ID." },
        },
      },
      handler: async (args, toolCtx) => {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) throw new Error("query is required");

        const effectiveBinding = (toolCtx?.rbac as any)?.binding ?? binding;
        const memoryBinding = effectiveBinding?.memory;
        if (args.disclose === "never" || memoryBinding?.disclose === "never") {
          return { blocks: [], query, text: "", joined: "", degraded: { reason: "disclose-never", capability: "recall" } };
        }

        const agentId = toolCtx?.agentId ?? ctx.agentId;
        const core = toolCtx?.core ?? ctx.core;

        if (!core || typeof (core as any).call !== "function") {
          return { blocks: [], query, degraded: { reason: "core-unavailable" } };
        }

        const userId = toolCtx?.rbac?.userId ?? ctx.rbac?.userId ?? "mcp-caller";
        const caller = { channel: "mcp", accountId: userId, userId };
        const params: Record<string, unknown> = {
          caller,
          agentId,
          query,
          joined: true,
        };
        if (typeof args.capChars === "number") {
          params.budget = { capChars: args.capChars };
        }

        const result = await (core as any).call("memory.recall", params);
        return redactProtocolValue(result, "mcp", this.secretRedaction);
      },
    };

    tools.push(recallTool);

    const allowCapture = boundMemory?.capture !== false;
    if (this.includeStore && allowCapture) {
      const storeTool: McpToolDef = {
        name: "memory_store",
        description: "Captures a new memory fact in authorized scope.",
        group: "memory",
        inputSchema: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", description: "Memory content to store." },
            session: { type: "string", description: "Optional session key." },
            scope: { type: "string", enum: ["user", "workspace"], description: "Memory storage scope." },
          },
        },
        handler: async (args, toolCtx) => {
          const text = typeof args.text === "string" ? args.text.trim() : "";
          if (!text) throw new Error("text is required");
          const agentId = toolCtx?.agentId ?? ctx.agentId;
          const core = toolCtx?.core ?? ctx.core;

          if (!core || typeof (core as any).call !== "function") {
            throw new ApiError(503, "E_CORE_UNAVAILABLE", "Core memory storage unavailable", { reason: "core-unavailable" });
          }

          const userId = toolCtx?.rbac?.userId ?? ctx.rbac?.userId ?? "mcp-caller";
          const caller = { channel: "mcp", accountId: userId, userId };
          const params: Record<string, unknown> = {
            caller,
            agentId,
            messages: [{ role: "user", content: text }],
            wait: true,
          };
          if (typeof args.session === "string" && args.session) {
            params.sessionKey = args.session;
          }

          const res = await (core as any).call("memory.capture", params);
          return redactProtocolValue(res, "mcp", this.secretRedaction);
        },
      };

      tools.push(storeTool);
    }

    return tools;
  }
}
