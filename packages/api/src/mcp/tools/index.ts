import { AgentToolGroup } from "./agent.ts";
import { McpToolRegistry } from "./group.ts";
import { MemoryToolGroup, type MemoryToolGroupOptions } from "./memory.ts";
import { SkillsToolGroup, type SkillsToolGroupOptions } from "./skills.ts";

export * from "./group.ts";
export * from "./memory.ts";
export * from "./agent.ts";
export * from "./skills.ts";

export interface CreateDefaultRegistryOptions {
  memory?: MemoryToolGroupOptions;
  skills?: SkillsToolGroupOptions;
}

/**
 * Creates and initializes the standard MCP tool registry with memory, agent, and skills groups.
 */
export function createDefaultToolRegistry(options: CreateDefaultRegistryOptions = {}): McpToolRegistry {
  const registry = new McpToolRegistry();
  registry.registerGroup(new MemoryToolGroup(options.memory));
  registry.registerGroup(new AgentToolGroup());
  registry.registerGroup(new SkillsToolGroup(options.skills));
  return registry;
}
