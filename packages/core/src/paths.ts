import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { coreAddress as moduleApiCoreAddress, supervisorAddress as moduleApiSupervisorAddress } from "@plur1bus/module-api";

export interface ResolveHomeOptions { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; homedir?: string; localAppData?: string }

const blank = (v: string | undefined): v is undefined => v === undefined || v.trim() === "";
const absolute = (p: string, platform: NodeJS.Platform): boolean => (platform === "win32" ? path.win32.isAbsolute(p) : path.isAbsolute(p));

/** An explicit home: `~` is the user's home directory, then made absolute with the target platform's rules (a Windows
 *  home given on another host is not glued onto the working directory). */
function explicitHome(value: string, platform: NodeJS.Platform, userHome: () => string): string {
  const m = /^~(?:[\\/](.*))?$/.exec(value);
  const expanded = m ? (platform === "win32" ? path.win32 : path).join(userHome(), m[1] ?? "") : value;
  return platform === "win32" && path.win32.isAbsolute(expanded) ? path.win32.resolve(expanded) : path.resolve(expanded);
}

export function resolveHome(o: ResolveHomeOptions = {}): string {
  const env = o.env ?? process.env; const platform = o.platform ?? process.platform;
  // The user's home directory, only when needed. It must be an absolute path: an empty one would make the default a
  // relative directory in whatever the working directory is.
  const userHome = (): string => {
    let home: string;
    try { home = o.homedir ?? osHomedir(); } catch (e) { throw new Error("cannot determine the home directory; set PLUR1BUS_HOME or pass --home", { cause: e }); }
    if (!home || !absolute(home, platform)) throw new Error(`cannot determine the home directory (got ${JSON.stringify(home)}); set PLUR1BUS_HOME or pass --home`);
    return home;
  };
  if (!blank(o.home)) return explicitHome(o.home, platform, userHome);
  if (!blank(env.PLUR1BUS_HOME)) return explicitHome(env.PLUR1BUS_HOME, platform, userHome);
  const home = userHome();
  if (platform === "win32") {
    const given = o.localAppData ?? env.LOCALAPPDATA;
    if (!blank(given) && !path.win32.isAbsolute(given)) throw new Error("LOCALAPPDATA is not an absolute path, so the home directory cannot be derived from it; set PLUR1BUS_HOME or pass --home");
    return path.win32.join(blank(given) ? path.win32.join(home, "AppData", "Local") : given, "PLUR1BUS");
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
  /** D112: the model catalog directory and file, and the system jobs' ledger directory. */
  catalog: string; catalogModels: string; systemJobs: string;
  /** M2: the encrypted-file secret store's directory (store.json, store.key). */
  secrets: string;
}

/** A Windows home: a drive letter or a double-backslash prefix (UNC, extended-length). A backslash alone is a legal character in a POSIX name. */
const isWindowsHome = (home: string): boolean => /^(?:[A-Za-z]:|\\\\)/.test(home);

/** One path segment built from a caller-chosen name (agent id, log role): never empty, `.`, `..`, nor anything that
 *  separates, addresses a drive or ends in a character Windows drops. */
function segment(s: string): string {
  if (typeof s !== "string" || s === "" || s === "." || s === ".." || /[\\/\0:]|[. ]$/.test(s)) throw new Error(`invalid path segment: ${JSON.stringify(s)}`);
  return s;
}

export function layout(home: string): Layout {
  const p = isWindowsHome(home) ? path.win32 : path.posix;
  const j = (...s: string[]) => p.join(home, ...s);
  return {
    home, configPath: j("config.json"), state: j("state"), lancedb: j("state", "lancedb"), journal: j("state", "journal"), agents: j("agents"),
    agentDir: (id) => j("agents", segment(id)), workspaceDir: (id) => j("agents", segment(id), "workspace"),
    run: j("run"), coreSocket: j("run", "core.sock"), coreToken: j("run", "core.token"), corePid: j("run", "core.pid"), coreLock: j("state", "core.lock"),
    supervisorSocket: j("run", "supervisor.sock"), supervisorToken: j("run", "supervisor.token"), supervisorPid: j("run", "supervisor.pid"),
    logs: j("logs"), logFile: (role) => j("logs", `${segment(role)}.log`), runtime: j("runtime"), models: j("models"), modules: j("modules"), skills: j("skills"),
    catalog: j("catalog"), catalogModels: j("catalog", "models.json"), systemJobs: j("state", "system-jobs"),
    secrets: j("state", "secrets"),
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
