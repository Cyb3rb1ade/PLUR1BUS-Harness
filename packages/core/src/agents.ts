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
    let lastMissingWarnMtime = -1;

    const scaffoldAgent = (id: string) => {
      try {
        mkdirSync(l.workspaceDir(id), { recursive: true, mode: 0o700 });
        for (const t of TEMPLATES) {
          const target = join(l.agentDir(id), t);
          if (!existsSync(target)) writeFileSync(target, readFileSync(new URL(t, TEMPLATE_DIR), "utf8").replaceAll("{{agentId}}", id), { mode: 0o600 });
        }
      } catch (e) {
        logger?.warn("scaffold failed, will retry later", { agentId: id, err: e });
      }
    };

    const refresh = (): HarnessConfig => {
      let stat: ReturnType<typeof statSync> | null = null;
      try {
        stat = statSync(pathForm.path);
      } catch (e) {
        if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
          // File doesn't exist
          if (cached.config) {
            // We have a last good config, keep using it, warn once
            if (lastMissingWarnMtime !== -1) {
              // Already warned about missing file
            } else {
              lastMissingWarnMtime = 0; // Mark that we've warned about missing
              logger?.warn("config file not found, keeping last good config", { path: pathForm.path });
            }
            return cached.config;
          } else {
            // No cached config yet, this is a failure
            throw e;
          }
        } else {
          throw e;
        }
      }

      if (stat && stat.mtimeMs !== cached.mtimeMs) {
        try {
          const loaded = loadConfig(pathForm.path);
          cached = { mtimeMs: stat.mtimeMs, config: loaded.config };
          lastWarnMtime = -1; // reset warn tracking on successful reload
          lastMissingWarnMtime = -1;
        } catch (e) {
          if (e instanceof Error && e.name === "ConfigInvalid" && cached.config) {
            // Swallow the error, log once per distinct mtime, keep last good config
            if (lastWarnMtime !== stat.mtimeMs) {
              logger?.warn("config reload failed, keeping last good config", { err: e, path: pathForm.path });
              lastWarnMtime = stat.mtimeMs;
            }
            // Important: do NOT advance cached.mtimeMs, so we skip reloads until mtime changes
          } else {
            throw e;
          }
        }
      }

      // Scaffold newly appearing agents after every refresh
      if (cached.config) {
        for (const id of Object.keys(cached.config.agents)) {
          if (!seenAgents.has(id)) {
            scaffoldAgent(id);
            seenAgents.add(id);
          }
        }
      }

      return cached.config!;
    };

    return {
      list: () => {
        const config = refresh();
        return Object.keys(config.agents).sort();
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
