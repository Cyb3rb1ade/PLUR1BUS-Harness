import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { buildToolHeaderExtractor, encodeMcpHeaderValue } from "./headers.ts";
import {
  MCP_DEFAULT_TOOL_TTL_MS,
  MCP_MAX_BODY_BYTES,
  MCP_SERVER_INFO,
  type McpServerConfig,
  type McpToolContext,
  type McpToolDef,
  SUPPORTED_MCP_SERVER_VERSIONS,
} from "./types.ts";

export class PayloadTooLargeError extends Error {}
export class InvalidJsonError extends Error {}

export async function readMcpBody(
  req: IncomingMessage,
  maxBytes = MCP_MAX_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new PayloadTooLargeError("Payload exceeds 256 KiB");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonError("Invalid JSON");
  }
}

export function getSingleHeader(req: IncomingMessage, lowerName: string): string | undefined {
  const raw = req.headers[lowerName];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function sendJsonRpcError(
  res: ServerResponse,
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (res.headersSent) return;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data ? { data } : {}) },
    }),
  );
}

export function sendJsonRpcResult(
  res: ServerResponse,
  id: string | number | null,
  result: Record<string, unknown>,
): void {
  if (res.headersSent) return;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result,
    }),
  );
}

export interface McpRequestHandlerOptions {
  config?: McpServerConfig;
  req: IncomingMessage;
  res: ServerResponse;
  preReadBody?: unknown;
  signal?: AbortSignal;
}

export class McpServerCore {
  private readonly sortedTools: McpToolDef[];
  private readonly toolByName = new Map<string, McpToolDef>();
  private readonly headerExtractors = new Map<string, (args: Record<string, unknown>) => Record<string, string>>();
  private readonly ttlMs: number;
  private readonly config: McpServerConfig;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.sortedTools = [...config.tools].sort((a, b) => a.name.localeCompare(b.name));
    for (const tool of this.sortedTools) {
      this.toolByName.set(tool.name, tool);
      this.headerExtractors.set(tool.name, buildToolHeaderExtractor(tool.inputSchema));
    }
    this.ttlMs = config.ttlMs ?? MCP_DEFAULT_TOOL_TTL_MS;
  }

  getTools(): readonly McpToolDef[] {
    return this.sortedTools;
  }

  async executeTool(
    name: string,
    args: Record<string, unknown> = {},
    toolCtx?: McpToolContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    const tool = this.toolByName.get(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    }
    const effectiveCtx = toolCtx ?? this.config.context;
    try {
      const result = await tool.handler(args, effectiveCtx);
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return {
        content: [{ type: "text", text }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : "Tool execution failed" }],
        isError: true,
      };
    }
  }

  private createLegacyMcpServer(toolCtx?: McpToolContext): McpServer {
    const mcpServer = new McpServer(MCP_SERVER_INFO, {
      capabilities: { tools: {} },
    });
    mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.sortedTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: "object"; properties?: Record<string, object>; required?: string[] },
      })),
    }));
    mcpServer.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const tool = this.toolByName.get(name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
      }
      try {
        const result = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>, toolCtx);
        const text = typeof result === "string" ? result : JSON.stringify(result);
        return {
          content: [{ type: "text", text }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : "Tool execution failed" }],
          isError: true,
        };
      }
    });
    return mcpServer;
  }

  async handleRequest(options: McpRequestHandlerOptions): Promise<void> {
    const { req, res, signal } = options;

    // 405 for GET and DELETE
    if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405, {
        Allow: "POST",
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, {
        Allow: "POST",
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    let parsedBody: unknown = options.preReadBody;
    if (parsedBody === undefined) {
      try {
        parsedBody = await readMcpBody(req);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "payload_too_large" }));
          return;
        }
        sendJsonRpcError(res, null, -32700, "Parse error");
        return;
      }
    }

    // Batch requests or non-object payloads -> -32600
    if (Array.isArray(parsedBody) || typeof parsedBody !== "object" || parsedBody === null) {
      sendJsonRpcError(res, null, -32600, "Invalid Request: batch or non-object payload");
      return;
    }

    const rpc = parsedBody as {
      jsonrpc?: unknown;
      id?: string | number | null;
      method?: unknown;
      params?: unknown;
    };

    if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string" || !rpc.method) {
      sendJsonRpcError(res, rpc.id ?? null, -32600, "Invalid JSON-RPC 2.0 request");
      return;
    }

    // Notifications (no id field) -> 202 with empty body
    if (!("id" in rpc) || rpc.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }

    const requestId = rpc.id;
    const params =
      typeof rpc.params === "object" && rpc.params !== null && !Array.isArray(rpc.params)
        ? (rpc.params as Record<string, unknown>)
        : {};
    const meta =
      typeof params._meta === "object" && params._meta !== null && !Array.isArray(params._meta)
        ? (params._meta as Record<string, unknown>)
        : undefined;

    const headerVersion = getSingleHeader(req, "mcp-protocol-version");
    const metaVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
    const initVersion = rpc.method === "initialize" ? params.protocolVersion : undefined;

    for (const candidate of [headerVersion, metaVersion, initVersion]) {
      if (
        candidate !== undefined &&
        (typeof candidate !== "string" ||
          !(SUPPORTED_MCP_SERVER_VERSIONS as readonly string[]).includes(candidate))
      ) {
        sendJsonRpcError(res, requestId, -32022, "Unsupported MCP protocol version", {
          supported: [...SUPPORTED_MCP_SERVER_VERSIONS],
        });
        return;
      }
    }

    const isModernRequest =
      headerVersion === "2026-07-28" ||
      metaVersion === "2026-07-28" ||
      rpc.method === "server/discover";

    const toolCtx: McpToolContext = {
      agentId: this.config.agentId ?? "main",
      tokenId: this.config.tokenId,
      rbac: this.config.rbac,
      signal,
      core: this.config.core,
    };

    if (isModernRequest) {
      if (headerVersion !== "2026-07-28" || metaVersion !== "2026-07-28") {
        sendJsonRpcError(res, requestId, -32020, "Modern MCP requires matching 2026-07-28 version in header and _meta");
        return;
      }
      const mcpMethodHeader = getSingleHeader(req, "mcp-method");
      if (mcpMethodHeader !== rpc.method) {
        sendJsonRpcError(res, requestId, -32020, "Mcp-Method header missing or mismatched");
        return;
      }

      if (rpc.method === "server/discover") {
        sendJsonRpcResult(res, requestId, {
          resultType: "complete",
          ttlMs: this.ttlMs,
          cacheScope: "private",
          supportedVersions: ["2026-07-28", "2025-11-25"],
          capabilities: { tools: {} },
          _meta: {
            "io.modelcontextprotocol/serverInfo": MCP_SERVER_INFO,
          },
        });
        return;
      }

      if (rpc.method === "tools/list") {
        sendJsonRpcResult(res, requestId, {
          resultType: "complete",
          ttlMs: this.ttlMs,
          cacheScope: "private",
          tools: this.sortedTools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        return;
      }

      if (rpc.method === "tools/call") {
        const toolName = typeof params.name === "string" ? params.name : "";
        const expectedNameHeader = encodeMcpHeaderValue(toolName);
        if (getSingleHeader(req, "mcp-name") !== expectedNameHeader) {
          sendJsonRpcError(res, requestId, -32020, "Mcp-Name header missing or mismatched");
          return;
        }

        const tool = this.toolByName.get(toolName);
        if (!tool) {
          sendJsonRpcError(res, requestId, ErrorCode.MethodNotFound, `Tool not found: ${toolName}`);
          return;
        }

        const args =
          typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};

        const extractor = this.headerExtractors.get(toolName);
        if (extractor) {
          let expectedParamHeaders: Record<string, string>;
          try {
            expectedParamHeaders = extractor(args);
          } catch {
            sendJsonRpcError(res, requestId, -32020, "Invalid tool header parameter");
            return;
          }
          for (const [headerKey, expectedVal] of Object.entries(expectedParamHeaders)) {
            if (getSingleHeader(req, headerKey) !== expectedVal) {
              sendJsonRpcError(res, requestId, -32020, `Mismatched ${headerKey} header`);
              return;
            }
          }
          for (const key of Object.keys(req.headers)) {
            if (key.startsWith("mcp-param-") && !(key in expectedParamHeaders)) {
              sendJsonRpcError(res, requestId, -32020, `Unexpected ${key} header`);
              return;
            }
          }
        }

        try {
          const out = await tool.handler(args, toolCtx);
          sendJsonRpcResult(res, requestId, {
            resultType: "complete",
            content: [{ type: "text", text: JSON.stringify(out) }],
            isError: false,
          });
          return;
        } catch (err) {
          const text = err instanceof Error ? err.message : "Tool call failed";
          sendJsonRpcResult(res, requestId, {
            resultType: "complete",
            content: [{ type: "text", text }],
            isError: true,
          });
          return;
        }
      }

      sendJsonRpcError(res, requestId, ErrorCode.MethodNotFound, `Method not found: ${rpc.method}`);
      return;
    }

    // Legacy era (2025-11-25 and older): dispatch to v1 McpServer
    const legacyServer = this.createLegacyMcpServer(toolCtx);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await legacyServer.connect(transport as unknown as Transport);
    try {
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      await legacyServer.close();
    }
  }
}
