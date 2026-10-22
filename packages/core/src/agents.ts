import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SCHEMA, type HarnessConfig } from "@plur1bus/config-schema";
import { RpcError } from "./rpc/errors.ts";
import type { Layout } from "./paths.ts";
import { loadConfig, type ConfigInvalid } from "./config-load.ts";
import type { HarnessLogger } from "./logger.ts";

const TEMPLATE_DIR = new URL("./agent-templates/", import.meta.url);
const TEMPLATES = ["SOUL.md", "USER.md", "persona-voice.md"] as const;

/** The agent's workspace directory and its template files (never overwriting one that exists). */
export function scaffoldFiles(l: Layout, id: string): void {
  // The id becomes a directory name: only the Config Schema's agent-name rule may reach the file system.
  if (typeof id !== "string" || !new RegExp(CONFIG_SCHEMA.properties.agents.propertyNames.pattern).test(id)) throw new RpcError("E_INVALID_PARAMS", "invalid agent name");
  mkdirSync(l.workspaceDir(id), { recursive: true, mode: 0o700 });
  for (const t of TEMPLATES) {
    const target = join(l.agentDir(id), t);
    // Anything already at the target stays, a dangling symlink included. lstat does not follow it. "wx" alone is not enough on
    // Windows: CreateFile(CREATE_NEW) follows a dangling symlink and creates the file it points to, outside the agent directory.
    try { lstatSync(target); continue; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    // "wx" stays as the create-exclusive guard against a link planted between the check and the write (POSIX never follows it).
    try { writeFileSync(target, readFileSync(new URL(t, TEMPLATE_DIR), "utf8").replaceAll("{{agentId}}", () => id), { mode: 0o600, flag: "wx" }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
}

export interface AgentRegistry { list(): string[]; has(id: string): boolean; scaffold(id: string): void; workspaceOf(id: string): string | undefined }

/** A fixed configuration, config.json with live reload (`path`), or a function returning the current configuration
 *  (`config`: the supervisor's, B7). The function form scaffolds an agent the first time it appears, like the path form. */
export type AgentRegistryInput = HarnessConfig | { path: string } | { config: () => HarnessConfig };

export function createAgentRegistry(configOrPath: AgentRegistryInput, l: Layout, logger?: HarnessLogger): AgentRegistry {
  if ("config" in configOrPath && typeof configOrPath.config === "function") {
    const current = configOrPath.config;
    const seen = new Set<string>();
    const agentsNow = () => {
      const agents = current().agents;
      for (const id of Object.keys(agents)) {
        if (seen.has(id)) continue;
        try { scaffoldFiles(l, id); seen.add(id); } catch (e) { logger?.warn("scaffold failed, will retry later", { agentId: id, err: e }); }
      }
      return agents;
    };
    return {
      list: () => Object.keys(agentsNow()).sort(),
      has: (id) => Object.hasOwn(agentsNow(), id),
      scaffold: (id) => scaffoldFiles(l, id),
      workspaceOf: (id) => (Object.hasOwn(agentsNow(), id) ? l.workspaceDir(id) : undefined),
    };
  }
  if ("path" in configOrPath) {
    // Path form with live reload
    const pathForm = configOrPath as { path: string };
    let cached = { mtimeMs: 0, config: null as HarnessConfig | null };
    const seenAgents = new Set<string>();
    let lastWarnMtime = -1;
    let lastMissingWarnMtime = -1;

    const scaffoldAgent = (id: string): boolean => {
      try {
        scaffoldFiles(l, id);
        return true;
      } catch (e) {
        logger?.warn("scaffold failed, will retry later", { agentId: id, err: e });
        return false;
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
            // Only a successful scaffold counts as done; a failed one is retried on the next call.
            if (scaffoldAgent(id)) seenAgents.add(id);
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
      scaffold: (id) => scaffoldFiles(l, id),
      workspaceOf: (id) => (Object.hasOwn(config.agents, id) ? l.workspaceDir(id) : undefined),
    };
  }
}
