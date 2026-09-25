import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type { Layout } from "./paths.ts";
import { loadConfig, type ConfigInvalid } from "./config-load.ts";
import type { HarnessLogger } from "./logger.ts";

const TEMPLATE_DIR = new URL("./agent-templates/", import.meta.url);
const TEMPLATES = ["SOUL.md", "USER.md", "persona-voice.md"] as const;

export interface AgentRegistry { list(): string[]; has(id: string): boolean; scaffold(id: string): void; workspaceOf(id: string): string | undefined }

export function createAgentRegistry(configOrPath: HarnessConfig | { path: string }, l: Layout, logger?: HarnessLogger): AgentRegistry {
  // Handle both forms: existing (config) and new (path with live reload)
  if (!("agents" in configOrPath)) {
    // Path form with live reload
    const pathForm = configOrPath as { path: string };
    let cached = { mtimeMs: 0, config: null as HarnessConfig | null };
    const seenAgents = new Set<string>();
    let lastWarnMtime = -1;

    const refresh = (): HarnessConfig => {
      try {
        const stat = statSync(pathForm.path);
        if (stat.mtimeMs !== cached.mtimeMs) {
          try {
            const loaded = loadConfig(pathForm.path);
            cached = { mtimeMs: stat.mtimeMs, config: loaded.config };
            lastWarnMtime = -1; // reset warn tracking on successful reload
          } catch (e) {
            if (e instanceof Error && e.name === "ConfigInvalid" && cached.config) {
              // Swallow the error, log once per distinct mtime, keep last good config
              if (lastWarnMtime !== stat.mtimeMs) {
                logger?.warn("config reload failed, keeping last good config", { err: e, path: pathForm.path });
                lastWarnMtime = stat.mtimeMs;
              }
            } else {
              throw e;
            }
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("ENOENT") && cached.config) {
          // File doesn't exist but we have a last good config, keep using it
          logger?.warn("config file not found, keeping last good config", { path: pathForm.path });
        } else {
          throw e;
        }
      }
      return cached.config!;
    };

    const scaffoldAgent = (id: string) => {
      mkdirSync(l.workspaceDir(id), { recursive: true, mode: 0o700 });
      for (const t of TEMPLATES) {
        const target = join(l.agentDir(id), t);
        if (!existsSync(target)) writeFileSync(target, readFileSync(new URL(t, TEMPLATE_DIR), "utf8").replaceAll("{{agentId}}", id), { mode: 0o600 });
      }
    };

    return {
      list: () => {
        const config = refresh();
        const agents = Object.keys(config.agents).sort();
        // Scaffold newly appearing agents lazily
        for (const id of agents) {
          if (!seenAgents.has(id)) {
            scaffoldAgent(id);
            seenAgents.add(id);
          }
        }
        return agents;
      },
      has: (id) => {
        const config = refresh();
        return Object.hasOwn(config.agents, id);
      },
      scaffold(id) {
        scaffoldAgent(id);
      },
      workspaceOf: (id) => {
        const config = refresh();
        return Object.hasOwn(config.agents, id) ? l.workspaceDir(id) : undefined;
      },
    };
  } else {
    // Config form (existing behavior)
    const config = configOrPath as HarnessConfig;
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
}
