import type { McpToolContext, McpToolDef } from "../types.ts";

export interface McpToolGroup {
  readonly name: string;
  buildTools(ctx: McpToolContext): readonly McpToolDef[];
}

export class McpToolRegistry {
  private readonly groups = new Map<string, McpToolGroup>();

  registerGroup(group: McpToolGroup): void {
    this.groups.set(group.name, group);
  }

  getGroup(name: string): McpToolGroup | undefined {
    return this.groups.get(name);
  }

  hasGroup(name: string): boolean {
    return this.groups.has(name);
  }

  getRegisteredGroupNames(): string[] {
    return [...this.groups.keys()].sort();
  }

  buildTools(activeGroupNames: readonly string[], ctx: McpToolContext): McpToolDef[] {
    const tools: McpToolDef[] = [];
    const seen = new Set<string>();

    for (const groupName of activeGroupNames) {
      const group = this.groups.get(groupName);
      if (!group) continue;
      const groupTools = group.buildTools(ctx);
      for (const tool of groupTools) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        tools.push(tool);
      }
    }

    return tools.sort((a, b) => a.name.localeCompare(b.name));
  }
}
