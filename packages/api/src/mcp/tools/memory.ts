import { createSecretRedaction, redactProtocolOutput } from "../../../../core/src/secrets/redaction.ts";
import type { McpToolContext, McpToolDef } from "../types.ts";
import type { McpToolGroup } from "./group.ts";

export interface MemoryToolGroupOptions {
  secretRedaction?: ReturnType<typeof createSecretRedaction>;
  includeStore?: boolean;
}

export class MemoryToolGroup implements McpToolGroup {
  readonly name = "memory";
  private readonly secretRedaction = createSecretRedaction();
  private readonly includeStore: boolean;

  constructor(options: MemoryToolGroupOptions = {}) {
    this.includeStore = options.includeStore ?? false;
    if (options.secretRedaction) {
      this.secretRedaction = options.secretRedaction;
    }
  }

  buildTools(ctx: McpToolContext): readonly McpToolDef[] {
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
        const agentId = toolCtx?.agentId ?? ctx.agentId;
        const core = toolCtx?.core ?? ctx.core;

        if (!core || typeof (core as any).call !== "function") {
          // If no live core is attached (e.g. standalone test), return empty memory result
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
          params.capChars = args.capChars;
        }
        if (typeof args.filter === "object" && args.filter !== null) {
          params.filter = args.filter;
        }
        if (typeof args.disclose === "string") {
          params.disclose = args.disclose;
        }
        if (typeof args.project === "string") {
          params.project = args.project;
        }

        const result = await (core as any).call("memory.recall", params);
        const serialized = JSON.stringify(result);
        const redacted = redactProtocolOutput(serialized, "mcp", this.secretRedaction);
        return JSON.parse(redacted);
      },
    };

    tools.push(recallTool);

    if (this.includeStore) {
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
            throw new Error("Core memory storage unavailable");
          }

          const caller = toolCtx?.rbac?.userId ?? ctx.rbac?.userId ?? "mcp-caller";
          const scope = args.scope === "workspace" ? "workspace" : "user";
          const params: Record<string, unknown> = {
            caller,
            agentId,
            text,
            scope,
          };
          if (typeof args.session === "string" && args.session) {
            params.session = args.session;
          }

          const res = await (core as any).call("memory.capture", params);
          return res;
        },
      };

      tools.push(storeTool);
    }

    return tools;
  }
}
