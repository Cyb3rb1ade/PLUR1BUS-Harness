export interface AgentMcpConfig {
  exposed?: boolean;
  groups?: readonly string[];
}

export interface McpServerConfigLike {
  mcpServer?: {
    enabled?: boolean;
  };
  agents?: Record<
    string,
    {
      mcpServer?: AgentMcpConfig;
    }
  >;
}

export const DEFAULT_MCP_TOOL_GROUPS: readonly string[] = ["memory", "agent", "skills"];

/**
 * Returns true if the top-level harness MCP server is enabled in configuration.
 */
export function isMcpServerEnabled(config?: McpServerConfigLike): boolean {
  return config?.mcpServer?.enabled === true;
}

/**
 * Returns true if both the top-level MCP server is enabled and the specified agent is explicitly exposed.
 */
export function isAgentMcpExposed(config: McpServerConfigLike | undefined, agentId: string): boolean {
  if (!isMcpServerEnabled(config)) return false;
  return config?.agents?.[agentId]?.mcpServer?.exposed === true;
}

/**
 * Returns the configured MCP tool groups for an agent (falling back to standard memory, agent, skills).
 */
export function getAgentMcpGroups(config: McpServerConfigLike | undefined, agentId: string): readonly string[] {
  const agentGroups = config?.agents?.[agentId]?.mcpServer?.groups;
  if (Array.isArray(agentGroups) && agentGroups.length > 0) {
    return agentGroups;
  }
  return DEFAULT_MCP_TOOL_GROUPS;
}
