/**
 * M6A-A0.2 spike server: wraps McpServerCore with a standalone node:http listener
 * for spike tests.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  McpServerCore,
  readMcpBody,
  sendJsonRpcError,
  sendJsonRpcResult,
} from "./server.ts";
import {
  encodeMcpHeaderValue,
  decodeMcpHeaderValue,
  buildToolHeaderExtractor,
} from "./headers.ts";
import {
  MCP_DEFAULT_TOOL_TTL_MS,
  MCP_MAX_BODY_BYTES,
  MCP_SERVER_INFO,
  type McpProtocolVersion,
  type McpServerConfig,
  type McpToolContext,
  type McpToolDef,
  SUPPORTED_MCP_SERVER_VERSIONS,
} from "./types.ts";

export {
  encodeMcpHeaderValue,
  decodeMcpHeaderValue,
  buildToolHeaderExtractor,
  MCP_DEFAULT_TOOL_TTL_MS,
  MCP_MAX_BODY_BYTES,
  MCP_SERVER_INFO,
  McpServerCore,
  readMcpBody,
  sendJsonRpcError,
  sendJsonRpcResult,
  SUPPORTED_MCP_SERVER_VERSIONS,
};
export type { McpProtocolVersion, McpServerConfig, McpToolContext, McpToolDef };

export interface McpSpikeToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface CreateMcpSpikeServerOptions {
  token: string;
  tools: McpSpikeToolDef[];
  ttlMs?: number;
}

export interface McpSpikeServerHandle {
  url: string;
  close: () => Promise<void>;
}

export async function createMcpSpikeServer(
  options: CreateMcpSpikeServerOptions,
): Promise<McpSpikeServerHandle> {
  const core = new McpServerCore({
    tools: options.tools,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    if (req.headers.authorization !== `Bearer ${options.token}`) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="mcp"',
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    await core.handleRequest({
      config: {
        tools: options.tools,
        ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      },
      req,
      res,
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
