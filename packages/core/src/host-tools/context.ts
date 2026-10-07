import { constants as fsc } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import { createNodeExec } from "./exec.ts";
import { isHostPlatform, type HostClock, type HostContext, type HostFs, type HostOs, type HostPlatform } from "./types.ts";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from "./types.ts";

export const systemClock: HostClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(Object.assign(new Error("aborted"), { code: "aborted" })); return; }
      const t = setTimeout(() => resolve(), ms);
      const onAbort = (): void => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { code: "aborted" })); };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

export const nodeFs: HostFs = {
  async exists(p) { try { await access(p, fsc.F_OK); return true; } catch { return false; } },
  async readFile(p) { return readFile(p, "utf8"); },
  async readdir(p) { return readdir(p); },
  async stat(p) {
    const s = await stat(p);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
  },
};

export const nodeOs: HostOs = {
  platform: () => os.platform(),
  release: () => os.release(),
  arch: () => os.arch(),
  type: () => os.type(),
  cpus: () => os.cpus().map((c) => ({ model: c.model, speed: c.speed })),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  uptime: () => os.uptime(),
  homedir: () => os.homedir(),
  hostname: () => os.hostname(),
  networkInterfaces: () => os.networkInterfaces(),
  userInfo: () => os.userInfo(),
  loadavg: () => os.loadavg(),
};

export function createNodeHostContext(over: Partial<HostContext> = {}): HostContext {
  const platform: HostPlatform = over.platform ?? (isHostPlatform(process.platform) ? process.platform : "linux");
  const clock = over.clock ?? systemClock;
  let user = "user";
  let uid = 0;
  try {
    const u = (over.os ?? nodeOs).userInfo();
    user = u.username;
    uid = u.uid;
  } catch { /* containers without a passwd entry */ }
  return {
    platform,
    exec: over.exec ?? createNodeExec(clock),
    fs: over.fs ?? nodeFs,
    os: over.os ?? nodeOs,
    clock,
    env: over.env ?? process.env,
    homedir: over.homedir ?? (over.os ?? nodeOs).homedir(),
    pid: over.pid ?? process.pid,
    uid: over.uid ?? uid,
    user: over.user ?? user,
    timeoutMs: over.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: over.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    ...(over.signal ? { signal: over.signal } : {}),
  };
}

export async function which(ctx: HostContext, name: string): Promise<string | null> {
  const pathVar = ctx.env.PATH ?? ctx.env.Path ?? "";
  const sep = ctx.platform === "win32" ? ";" : ":";
  const exts = ctx.platform === "win32" ? (ctx.env.PATHEXT ?? ".EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase()) : [""];
  const names = ctx.platform === "win32" ? [name, name.toLowerCase(), `${name}.exe`] : [name];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const n of names) {
      const candidates = ctx.platform === "win32"
        ? [n, ...exts.map((e) => (n.toLowerCase().endsWith(e.toLowerCase()) ? n : n + e))]
        : [n];
      for (const c of candidates) {
        const p = dir.replace(/[\\/]+$/, "") + (ctx.platform === "win32" ? "\\" : "/") + c;
        if (await ctx.fs.exists(p)) return p;
      }
    }
  }
  return null;
}
