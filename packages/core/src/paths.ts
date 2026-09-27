import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { coreAddress as moduleApiCoreAddress, supervisorAddress as moduleApiSupervisorAddress } from "@plur1bus/module-api";

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
  /** Written by the supervisor (S3): its RPC token and the nonce `core.adopt` proves. */
  supervisorSocket: string; supervisorToken: string; supervisorPid: string;
  logs: string; logFile(role: string): string; runtime: string; models: string; modules: string; skills: string;
}

export function layout(home: string): Layout {
  const p = home.includes("\\") ? path.win32 : path.posix;
  const j = (...s: string[]) => p.join(home, ...s);
  return {
    home, configPath: j("config.json"), state: j("state"), lancedb: j("state", "lancedb"), journal: j("state", "journal"), agents: j("agents"),
    agentDir: (id) => j("agents", id), workspaceDir: (id) => j("agents", id, "workspace"),
    run: j("run"), coreSocket: j("run", "core.sock"), coreToken: j("run", "core.token"), corePid: j("run", "core.pid"), coreLock: j("state", "core.lock"),
    supervisorSocket: j("run", "supervisor.sock"), supervisorToken: j("run", "supervisor.token"), supervisorPid: j("run", "supervisor.pid"),
    logs: j("logs"), logFile: (role) => j("logs", `${role}.log`), runtime: j("runtime"), models: j("models"), modules: j("modules"), skills: j("skills"),
  };
}

/** The address the RPC server listens on and the client connects to (the one rule: module-api's `unitAddress`). */
export function coreAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  return moduleApiCoreAddress(home, platform);
}

/** The supervisor's RPC address: `run/supervisor.sock` on POSIX, the per-home `-supervisor` pipe on Windows. */
export function supervisorAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  return moduleApiSupervisorAddress(home, platform);
}
