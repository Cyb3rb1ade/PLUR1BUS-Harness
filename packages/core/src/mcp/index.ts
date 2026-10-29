export { McpRegistry, type RegistryOptions, type McpCallerScope } from "./registry.ts";
export { McpClientError, type McpErrorCode } from "./errors.ts";
export { validateDefinition } from "./config.ts";
export { createRedactor, REDACTED, type Redactor } from "./redact.ts";
export { systemClock, type Clock } from "./clock.ts";
export * from "./types.ts";

export { McpConnection, type ConnectionDeps, type McpConnectionState, type McpRequestOptions, type McpResource, type McpResourceTemplate, type McpPrompt } from "./connection.ts";
export { SUPPORTED_MCP_VERSIONS, type McpProtocolVersion, type McpProtocol } from "./protocol.ts";
export { type McpClientPorts, type McpPortContext } from "./ports.ts";
export { SecretBearerAuthProvider, PkceAuthProvider, type McpAuthProvider, type McpAuthChallenge, type McpPkcePort } from "./auth.ts";

/** Composition factory; the registry stays lazy and keeps all transport ownership in mcp/. */
import { McpRegistry as Registry } from './registry.ts';
import type { RegistryOptions } from './registry.ts';
import { McpClientError as ClientError } from './errors.ts';
import type { McpCaller } from './types.ts';
export function createMcpRegistry(options: RegistryOptions): Registry { return new Registry(options); }

/** Identity adapter: approval's person is separate from MCP's canonical visibility principal. */
export function scopedMcpPort(port: import("../tools/mcp-bridge.ts").McpToolPort, principal: string,
  mayExecute?: (server: string, caller: McpCaller) => boolean): import("../tools/mcp-bridge.ts").McpToolPort {
  const invoke = port.callTool.bind(port);
  return {
    listTools: (server, caller, options) => port.listTools(server, { ...caller, principal }, options),
    callTool: async (server, tool, args, caller, signal) => {
      if (mayExecute && !mayExecute(server, caller)) {
        throw new ClientError('not-allowed', 'MCP server is no longer enabled for this agent', { server });
      }
      return invoke(server, tool, args, { ...caller, principal }, signal);
    },
  };
}
