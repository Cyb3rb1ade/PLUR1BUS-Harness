export interface AgentA2aConfig {
  exposed?: boolean;
  name?: string;
  description?: string;
}

export interface A2aServerConfigLike {
  a2aServer?: {
    enabled?: boolean;
    legacy03?: boolean;
  };
  agents?: Record<
    string,
    {
      a2aServer?: AgentA2aConfig;
    }
  >;
}

/**
 * Returns true if the top-level harness A2A server is enabled in configuration.
 */
export function isA2aServerEnabled(config?: A2aServerConfigLike): boolean {
  return config?.a2aServer?.enabled === true;
}

/**
 * Returns true if both the top-level A2A server is enabled and the specified agent is explicitly exposed.
 */
export function isAgentA2aExposed(config: A2aServerConfigLike | undefined, agentId: string): boolean {
  if (!isA2aServerEnabled(config)) return false;
  return config?.agents?.[agentId]?.a2aServer?.exposed === true;
}

/**
 * Returns true if the legacy 0.3 protocol opt-in is enabled.
 */
export function isLegacy03Enabled(config?: A2aServerConfigLike): boolean {
  return config?.a2aServer?.legacy03 === true;
}
