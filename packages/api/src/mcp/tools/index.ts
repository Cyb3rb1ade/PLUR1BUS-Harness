import { AgentToolGroup, type AgentToolGroupOptions } from "./agent.ts";
import { McpToolRegistry } from "./group.ts";
import { MemoryToolGroup, type MemoryToolGroupOptions } from "./memory.ts";
import { SkillsToolGroup, type SkillsToolGroupOptions } from "./skills.ts";
import type { createSecretRedaction } from "../../../../core/src/secrets/redaction.ts";

export * from "./group.ts";
export * from "./memory.ts";
export * from "./agent.ts";
export * from "./skills.ts";

export interface CreateDefaultRegistryOptions {
  memory?: MemoryToolGroupOptions | undefined;
  agent?: AgentToolGroupOptions | undefined;
  skills?: SkillsToolGroupOptions | undefined;
  secretRedaction?: ReturnType<typeof createSecretRedaction> | undefined;
}

/**
 * Creates and initializes the standard MCP tool registry with memory, agent, and skills groups.
 */
export function createDefaultToolRegistry(options: CreateDefaultRegistryOptions = {}): McpToolRegistry {
  const secretRedaction = options.secretRedaction;
  const registry = new McpToolRegistry();
  registry.registerGroup(new MemoryToolGroup({ ...options.memory, ...(secretRedaction ? { secretRedaction } : {}) }));
  registry.registerGroup(new AgentToolGroup({ ...options.agent, ...(secretRedaction ? { secretRedaction } : {}) }));
  registry.registerGroup(new SkillsToolGroup(options.skills));
  return registry;
}
