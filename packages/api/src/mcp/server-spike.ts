/**
 * M6A-A0.2 spike: dual-era MCP HTTP server supporting the modern 2026-07-28
 * stateless protocol and the legacy 2025-11-25 protocol via McpServer +
 * StreamableHTTPServerTransport (sessionIdGenerator: undefined) on node:http.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

/** Maximum JSON-RPC request body size on /mcp (256 KiB). */
export const MCP_MAX_BODY_BYTES = 256 * 1024;
/** Default tool list cache TTL in milliseconds for modern MCP responses. */
export const MCP_DEFAULT_TOOL_TTL_MS = 60_000;
/** Supported MCP protocol versions across modern and legacy eras. */
export const SUPPORTED_MCP_SERVER_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

/** Server implementation metadata advertised in MCP discovery/initialize. */
export const MCP_SERVER_INFO = { name: "plur1bus-harness", version: "0.1.0" } as const;

const MAX_SCHEMA_NODES = 4096;
const MAX_SCHEMA_DEPTH = 32;
const HEADER_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Tool definition for the MCP server spike. */
export interface McpSpikeToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Options for starting the dual-era MCP spike server. */
export interface CreateMcpSpikeServerOptions {
  token: string;
  tools: McpSpikeToolDef[];
  ttlMs?: number;
}

/** Handle for a running MCP spike server. */
export interface McpSpikeServerHandle {
  url: string;
  close: () => Promise<void>;
}

/**
 * Encodes an MCP header value using RFC 2047-style base64 framing when needed.
 */
export function encodeMcpHeaderValue(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) &&
    value.trim() === value &&
    !(value.startsWith("=?base64?") && value.endsWith("?="))
    ? value
    : `=?base64?${Buffer.from(value).toString("base64")}?=`;
}

interface HeaderAnnotation {
  name: string;
  path: string[];
  type: string;
}

/**
 * Builds an extractor that computes expected `Mcp-Param-*` headers for a tool inputSchema.
 */
export function buildToolHeaderExtractor(
  schema: Record<string, unknown>,
): (args: Record<string, unknown>) => Record<string, string> {
  const annotations: HeaderAnnotation[] = [];
  const names = new Set<string>();
  let nodes = 0;

  function walk(value: unknown, path: string[], reachable: boolean, depth: number): void {
    if (++nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) {
      throw new Error("MCP schema complexity limit");
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, path, false, depth + 1);
      return;
    }
    const obj = value as Record<string, unknown>;
    if ("x-mcp-header" in obj) {
      const name = obj["x-mcp-header"];
      const type = obj.type;
      if (
        !reachable ||
        !path.length ||
        typeof name !== "string" ||
        !HEADER_TOKEN_RE.test(name) ||
        typeof type !== "string" ||
        !["integer", "boolean", "string"].includes(type) ||
        names.has(name.toLowerCase())
      ) {
        throw new Error("MCP invalid tool header annotation");
      }
      names.add(name.toLowerCase());
      annotations.push({ name, path, type });
    }
    for (const [key, item] of Object.entries(obj)) {
      if (key === "properties" && item && typeof item === "object" && !Array.isArray(item)) {
        for (const [prop, sub] of Object.entries(item)) {
          walk(sub, [...path, prop], reachable, depth + 1);
        }
      } else if (typeof item === "object") {
        walk(item, path, false, depth + 1);
      }
    }
  }

  walk(schema, [], true, 0);

  return (args: Record<string, unknown>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const ann of annotations) {
      let cur: unknown = args;
      for (const part of ann.path) {
        cur =
          cur !== null && typeof cur === "object" && Object.hasOwn(cur, part)
            ? (cur as Record<string, unknown>)[part]
            : undefined;
      }
      if (cur === undefined || cur === null) continue;
      if (
        ann.type === "integer"
          ? typeof cur !== "number" || !Number.isSafeInteger(cur)
          : typeof cur !== ann.type
      ) {
        throw new Error("MCP tool header parameter type invalid");
      }
      out[`mcp-param-${ann.name.toLowerCase()}`] = encodeMcpHeaderValue(String(cur));
    }
    return out;
  };
}

class PayloadTooLargeError extends Error {}
class InvalidJsonError extends Error {}

async function readMcpBody(req: IncomingMessage, maxBytes = MCP_MAX_BODY_BYTES): Promise<unknown> {
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
    // Deliberately map syntax error to JSON-RPC -32700 parse error.
    throw new InvalidJsonError("Invalid JSON");
  }
}

function getSingleHeader(req: IncomingMessage, lowerName: string): string | undefined {
  const raw = req.headers[lowerName];
  return Array.isArray(raw) ? raw[0] : raw;
}

function sendJsonRpcError(
  res: ServerResponse,
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data ? { data } : {}) },
    }),
  );
}

/**
 * Starts a dual-era MCP server on a loopback HTTP port for spike verification.
 */
export async function createMcpSpikeServer(
  options: CreateMcpSpikeServerOptions,
): Promise<McpSpikeServerHandle> {
  const sortedTools = [...options.tools].sort((a, b) => a.name.localeCompare(b.name));
  const toolByName = new Map<string, McpSpikeToolDef>();
  const headerExtractors = new Map<string, (args: Record<string, unknown>) => Record<string, string>>();
  for (const tool of sortedTools) {
    toolByName.set(tool.name, tool);
    headerExtractors.set(tool.name, buildToolHeaderExtractor(tool.inputSchema));
  }
  const ttlMs = options.ttlMs ?? MCP_DEFAULT_TOOL_TTL_MS;

  const createLegacyMcpServer = (): McpServer => {
    const mcpServer = new McpServer(MCP_SERVER_INFO, {
      capabilities: { tools: {} },
    });
    mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: sortedTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: "object"; properties?: Record<string, object>; required?: string[] },
      })),
    }));
    mcpServer.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const tool = toolByName.get(name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
      }
      try {
        const result = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
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
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    // Auth check before method/body handling
    if (req.headers.authorization !== `Bearer ${options.token}`) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="mcp"',
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Stateless HTTP: GET and DELETE return 405 with Allow: POST
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

    let parsedBody: unknown;
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

    // Batch requests (arrays) or non-object payloads -> -32600
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

    // Notifications (no `id` field) -> 202 with empty body
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

    // Check if any supplied version is outside the supported list
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

    if (isModernRequest) {
      // Validate modern era mandatory _meta and headers
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            result: {
              resultType: "complete",
              ttlMs,
              cacheScope: "private",
              supportedVersions: ["2026-07-28", "2025-11-25"],
              capabilities: { tools: {} },
              _meta: {
                "io.modelcontextprotocol/serverInfo": MCP_SERVER_INFO,
              },
            },
          }),
        );
        return;
      }

      if (rpc.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            result: {
              resultType: "complete",
              ttlMs,
              cacheScope: "private",
              tools: sortedTools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            },
          }),
        );
        return;
      }

      if (rpc.method === "tools/call") {
        const toolName = typeof params.name === "string" ? params.name : "";
        const expectedNameHeader = encodeMcpHeaderValue(toolName);
        if (getSingleHeader(req, "mcp-name") !== expectedNameHeader) {
          sendJsonRpcError(res, requestId, -32020, "Mcp-Name header missing or mismatched");
          return;
        }
        const tool = toolByName.get(toolName);
        if (!tool) {
          sendJsonRpcError(res, requestId, ErrorCode.MethodNotFound, `Tool not found: ${toolName}`);
          return;
        }
        const args =
          typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        let expectedParamHeaders: Record<string, string>;
        try {
          expectedParamHeaders = headerExtractors.get(toolName)!(args);
        } catch {
          // Deliberately reject invalid header parameter types with -32020.
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

        try {
          const out = await tool.handler(args);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: requestId,
              result: {
                resultType: "complete",
                content: [{ type: "text", text: JSON.stringify(out) }],
                isError: false,
              },
            }),
          );
        } catch (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: requestId,
              result: {
                resultType: "complete",
                content: [
                  {
                    type: "text",
                    text: err instanceof Error ? err.message : "Tool execution failed",
                  },
                ],
                isError: true,
              },
            }),
          );
        }
        return;
      }

      sendJsonRpcError(res, requestId, ErrorCode.MethodNotFound, `Method not found: ${rpc.method}`);
      return;
    }

    // Legacy era (2025-11-25): stateless StreamableHTTPServerTransport per request (sessionIdGenerator omitted -> undefined)
    const mcpServer = createLegacyMcpServer();
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await mcpServer.connect(transport as unknown as Transport);
    try {
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      await mcpServer.close();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    url: baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
