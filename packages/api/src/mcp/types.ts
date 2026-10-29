import type { RbacPrincipal as Principal } from "../rbac-bridge.ts";
import type { ApiTokenRecord } from "../ports.ts";
import type { AuditEmitter } from "../audit.ts";

export const MCP_MAX_BODY_BYTES = 256 * 1024;
export const MCP_DEFAULT_TOOL_TTL_MS = 60_000;

export const SUPPORTED_MCP_SERVER_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

export type McpProtocolVersion = (typeof SUPPORTED_MCP_SERVER_VERSIONS)[number];

export const MCP_SERVER_INFO = { name: "plur1bus-harness", version: "0.1.0" } as const;

export interface McpToolContext {
  agentId: string;
  tokenId?: string;
  rbac?: Principal;
  signal?: AbortSignal;
  core?: unknown;
  audit?: AuditEmitter;
  actor?: string;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  group?: string;
  handler: (args: Record<string, unknown>, ctx?: McpToolContext) => Promise<unknown>;
}

export interface McpServerConfig {
  tools: McpToolDef[];
  ttlMs?: number;
  agentId?: string;
  tokenId?: string;
  rbac?: Principal;
  core?: unknown;
  audit?: AuditEmitter;
  actor?: string;
}
