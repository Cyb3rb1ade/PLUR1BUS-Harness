import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type { Layout } from "./paths.ts";

const TEMPLATE_DIR = new URL("./agent-templates/", import.meta.url);
const TEMPLATES = ["SOUL.md", "USER.md", "persona-voice.md"] as const;

export interface AgentRegistry { list(): string[]; has(id: string): boolean; scaffold(id: string): void; workspaceOf(id: string): string | undefined }

export function createAgentRegistry(config: HarnessConfig, l: Layout): AgentRegistry {
  return {
    list: () => Object.keys(config.agents).sort(),
    has: (id) => Object.hasOwn(config.agents, id),
    scaffold(id) {
      mkdirSync(l.workspaceDir(id), { recursive: true, mode: 0o700 });
      for (const t of TEMPLATES) {
        const target = join(l.agentDir(id), t);
        if (!existsSync(target)) writeFileSync(target, readFileSync(new URL(t, TEMPLATE_DIR), "utf8").replaceAll("{{agentId}}", id), { mode: 0o600 });
      }
    },
    workspaceOf: (id) => (Object.hasOwn(config.agents, id) ? l.workspaceDir(id) : undefined),
  };
}
