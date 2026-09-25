import { createHash } from "node:crypto";
import { homedir as osHomedir } from "node:os";
import path from "node:path";

export interface ResolveHomeOptions { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; homedir?: string; localAppData?: string }

export function resolveHome(o: ResolveHomeOptions = {}): string {
  const env = o.env ?? process.env; const platform = o.platform ?? process.platform;
  if (o.home) return path.resolve(o.home);
  if (env.PLUR1BUS_HOME) return path.resolve(env.PLUR1BUS_HOME);
  const home = o.homedir ?? osHomedir();
  if (platform === "win32") {
    const lad = o.localAppData ?? env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local");
    return path.win32.join(lad, "PLUR1BUS");
  }
  return path.posix.join(home, ".plur1bus");
}

export interface Layout {
  home: string; configPath: string; state: string; lancedb: string; journal: string; agents: string;
  agentDir(id: string): string; workspaceDir(id: string): string;
  run: string; coreSocket: string; coreToken: string; corePid: string; coreLock: string;
  logs: string; logFile(role: string): string; runtime: string; models: string; modules: string; skills: string;
}

export function layout(home: string): Layout {
  const p = home.includes("\\") ? path.win32 : path.posix;
  const j = (...s: string[]) => p.join(home, ...s);
  return {
    home, configPath: j("config.json"), state: j("state"), lancedb: j("state", "lancedb"), journal: j("state", "journal"), agents: j("agents"),
    agentDir: (id) => j("agents", id), workspaceDir: (id) => j("agents", id, "workspace"),
    run: j("run"), coreSocket: j("run", "core.sock"), coreToken: j("run", "core.token"), corePid: j("run", "core.pid"), coreLock: j("state", "core.lock"),
    logs: j("logs"), logFile: (role) => j("logs", `${role}.log`), runtime: j("runtime"), models: j("models"), modules: j("modules"), skills: j("skills"),
  };
}

/** The address the RPC server listens on and the client connects to. */
export function coreAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return `\\\\.\\pipe\\plur1bus-${createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16)}-core`;
  return layout(home).coreSocket;
}
