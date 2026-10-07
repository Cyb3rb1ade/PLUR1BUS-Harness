import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExecRequest,
  ExecResult,
  HostClock,
  HostContext,
  HostExec,
  HostFs,
  HostOs,
  HostOutcome,
  HostPlatform,
} from "../../src/host-tools/index.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const fixture = (...p: string[]): string => readFileSync(join(FIX, ...p), "utf8");

export type ExecCall = { program: string; args: readonly string[]; stdin?: string | undefined };

export interface ScriptedReply {
  match: (c: ExecCall) => boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
  hang?: boolean;
}

const base = (program: string): string => program.replace(/\\/g, "/").split("/").pop()!.replace(/\.exe$/i, "").toLowerCase();

export function isProg(c: ExecCall, name: string): boolean {
  return base(c.program) === name.toLowerCase();
}

export class FakeClock implements HostClock {
  t = 1_000_000;
  pending: Array<{ at: number; fn: () => void; id: number; cleared: boolean }> = [];
  private seq = 0;
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): unknown {
    const e = { at: this.t + ms, fn, id: ++this.seq, cleared: false };
    this.pending.push(e);
    return e;
  }
  clearTimeout(h: unknown): void { (h as { cleared: boolean }).cleared = true; }
  advance(ms: number): void {
    this.t += ms;
    for (const e of this.pending.filter((p) => !p.cleared && p.at <= this.t)) {
      e.cleared = true;
      e.fn();
    }
  }
  async sleep(ms: number): Promise<void> { this.advance(ms); }
}

export class FakeExec implements HostExec {
  readonly calls: ExecCall[] = [];
  scripts: ScriptedReply[];
  clock: FakeClock;
  constructor(scripts: ScriptedReply[] = [], clock: FakeClock = new FakeClock()) {
    this.scripts = scripts;
    this.clock = clock;
  }
  async run(req: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
    const call: ExecCall = { program: req.program, args: req.args, ...(req.stdin !== undefined ? { stdin: req.stdin } : {}) };
    this.calls.push(call);
    if (signal?.aborted) {
      return { exitCode: null, signal: null, stdout: "", stderr: "", truncated: false, timedOut: false, aborted: true, durationMs: 0 };
    }
    const hit = this.scripts.find((s) => s.match(call));
    if (!hit) {
      return { exitCode: 1, signal: null, stdout: "", stderr: `not found: ${req.program}`, truncated: false, timedOut: false, aborted: false, durationMs: 0 };
    }
    if (hit.hang) {
      return await new Promise((resolve) => {
        const onAbort = (): void => resolve({
          exitCode: null, signal: null, stdout: "", stderr: "", truncated: false, timedOut: true, aborted: Boolean(signal?.aborted), durationMs: hit.delayMs ?? 0,
        });
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        this.clock.setTimeout(onAbort, req.timeoutMs ?? 30_000);
      });
    }
    if (hit.delayMs) this.clock.advance(hit.delayMs);
    return {
      exitCode: hit.exitCode ?? 0, signal: null, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "",
      truncated: false, timedOut: false, aborted: false, durationMs: hit.delayMs ?? 0,
    };
  }
}

export class MemoryFs implements HostFs {
  files: Map<string, string>;
  dirs: Set<string>;
  constructor(init: Record<string, string | readonly string[] | true> = {}) {
    this.files = new Map();
    this.dirs = new Set();
    for (const [p, v] of Object.entries(init)) {
      const n = p.replace(/\\/g, "/");
      if (v === true) this.dirs.add(n);
      else if (typeof v !== "string") {
        this.dirs.add(n);
        for (const name of v) {
          const child = n.endsWith("/") ? n + name : `${n}/${name}`;
          this.dirs.add(child.endsWith(".app") || child.endsWith(".desktop") || !child.includes(".") ? child : n);
          if (name.endsWith("/") || name.endsWith(".app")) this.dirs.add(child.replace(/\/$/, ""));
          else this.files.set(child, "");
        }
      } else {
        this.files.set(n, v);
        const parts = n.split("/");
        for (let i = 1; i < parts.length; i += 1) this.dirs.add(parts.slice(0, i).join("/") || "/");
      }
    }
  }
  async exists(p: string): Promise<boolean> {
    const n = p.replace(/\\/g, "/");
    return this.files.has(n) || this.dirs.has(n);
  }
  async readFile(p: string): Promise<string> {
    const n = p.replace(/\\/g, "/");
    const v = this.files.get(n);
    if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return v;
  }
  async readdir(p: string): Promise<string[]> {
    const n = p.replace(/\\/g, "/").replace(/\/$/, "");
    const prefix = n === "" ? "/" : n + "/";
    const names = new Set<string>();
    for (const f of [...this.files.keys(), ...this.dirs]) {
      if (f === n) continue;
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) names.add(name);
      }
    }
    if (names.size === 0 && !this.dirs.has(n)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return [...names].sort();
  }
  async stat(p: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    const n = p.replace(/\\/g, "/");
    if (this.files.has(n)) return { isFile: true, isDirectory: false, size: this.files.get(n)!.length };
    if (this.dirs.has(n)) return { isFile: false, isDirectory: true, size: 0 };
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }
}

export function fakeOs(platform: HostPlatform, over: Partial<HostOs> = {}): HostOs {
  const ifaces = {
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
    eth0: [{ address: "10.0.0.8", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "10.0.0.8/24" }],
  } as HostOs["networkInterfaces"] extends () => infer R ? R : never;
  const baseOs: HostOs = {
    platform: () => platform,
    release: () => (platform === "darwin" ? "24.3.0" : platform === "win32" ? "10.0.22631" : "6.8.0"),
    arch: () => "arm64",
    type: () => (platform === "darwin" ? "Darwin" : platform === "win32" ? "Windows_NT" : "Linux"),
    cpus: () => [{ model: "Test CPU", speed: 3200 }],
    totalmem: () => 16 * 1024 * 1024 * 1024,
    freemem: () => 8 * 1024 * 1024 * 1024,
    uptime: () => 12_345,
    homedir: () => (platform === "win32" ? "C:\\Users\\alice" : "/Users/alice"),
    hostname: () => "host",
    networkInterfaces: () => ifaces,
    userInfo: () => ({ username: "alice", uid: 501, gid: 20 }),
    loadavg: () => [0.1, 0.2, 0.3],
  };
  return { ...baseOs, ...over };
}

export function platformScripts(platform: HostPlatform): ScriptedReply[] {
  if (platform === "darwin") {
    return [
      { match: (c) => isProg(c, "ps"), stdout: fixture("darwin", "ps.txt") },
      { match: (c) => isProg(c, "df"), stdout: fixture("darwin", "df.txt") },
      { match: (c) => isProg(c, "pmset"), stdout: fixture("darwin", "pmset-batt.txt") },
      { match: (c) => isProg(c, "mdls"), stdout: fixture("darwin", "mdls-safari.txt") },
      { match: (c) => isProg(c, "osascript") && c.args.some((a) => a.includes("System Events")), stdout: fixture("darwin", "gui-apps.txt") },
      { match: (c) => isProg(c, "osascript"), stdout: "", exitCode: 0 },
      { match: (c) => isProg(c, "open"), stdout: "", exitCode: 0 },
      { match: (c) => isProg(c, "kill"), stdout: "", exitCode: 0 },
      { match: (c) => isProg(c, "pbpaste"), stdout: "clip-text" },
      { match: (c) => isProg(c, "pbcopy"), stdout: "", exitCode: 0 },
      { match: (c) => isProg(c, "brew") && c.args[0] === "search", stdout: fixture("pkg", "brew-search.txt") },
      { match: (c) => isProg(c, "brew") && (c.args[0] === "list" || c.args[0] === "ls"), stdout: fixture("pkg", "brew-list.txt") },
      { match: (c) => isProg(c, "brew") && c.args[0] === "info", stdout: fixture("pkg", "brew-info.txt") },
      { match: (c) => isProg(c, "brew"), stdout: "Homebrew 4.4.0", exitCode: 0 },
    ];
  }
  if (platform === "win32") {
    return [
      { match: (c) => isProg(c, "tasklist"), stdout: fixture("win32", "tasklist.csv") },
      { match: (c) => isProg(c, "wmic") && c.args.some((a) => /logicaldisk/i.test(a)), stdout: fixture("win32", "wmic-disk.csv") },
      { match: (c) => isProg(c, "wmic") && c.args.some((a) => /Win32_Battery/i.test(a)), stdout: fixture("win32", "wmic-battery.csv") },
      { match: (c) => isProg(c, "wmic"), stdout: fixture("win32", "wmic-process.csv") },
      { match: (c) => isProg(c, "reg"), stdout: fixture("win32", "reg-uninstall.txt") },
      { match: (c) => isProg(c, "taskkill"), stdout: "", exitCode: 0 },
      { match: (c) => isProg(c, "explorer"), stdout: "", exitCode: 0 },
      { match: (c) => isProg(c, "cmd"), stdout: "", exitCode: 0 },
      { match: (c) => isProg(c, "powershell") && c.args.some((a) => /Get-Clipboard/i.test(a)), stdout: "clip-text" },
      { match: (c) => isProg(c, "powershell") && c.args.some((a) => /Set-Clipboard/i.test(a)), stdout: "", exitCode: 0 },
      { match: (c) => isProg(c, "powershell"), stdout: "", exitCode: 0 },
      { match: (c) => isProg(c, "winget") && c.args[0] === "search", stdout: "ripgrep  14.1.1" },
      { match: (c) => isProg(c, "winget") && c.args[0] === "list", stdout: "ripgrep  14.1.1" },
      { match: (c) => isProg(c, "winget") && c.args[0] === "show", stdout: "Found ripgrep" },
      { match: (c) => isProg(c, "winget"), stdout: "v1.9", exitCode: 0 },
    ];
  }
  return [
    { match: (c) => isProg(c, "ps"), stdout: fixture("linux", "ps.txt") },
    { match: (c) => isProg(c, "df"), stdout: fixture("linux", "df.txt") },
    { match: (c) => isProg(c, "wmctrl"), stdout: fixture("linux", "wmctrl.txt") },
    { match: (c) => isProg(c, "xdg-open"), stdout: "", exitCode: 0 },
    { match: (c) => isProg(c, "kill"), stdout: "", exitCode: 0 },
    { match: (c) => isProg(c, "notify-send"), stdout: "", exitCode: 0 },
    { match: (c) => isProg(c, "wl-paste") || isProg(c, "xclip") || isProg(c, "xsel"), stdout: "clip-text" },
    { match: (c) => isProg(c, "wl-copy"), stdout: "", exitCode: 0 },
    { match: (c) => isProg(c, "apt-cache") && c.args[0] === "search", stdout: "ripgrep - recursively searches" },
    { match: (c) => isProg(c, "dpkg-query"), stdout: "ripgrep\t14.1.1" },
    { match: (c) => isProg(c, "apt-cache") && c.args[0] === "show", stdout: "Package: ripgrep\nVersion: 14.1.1" },
    { match: (c) => isProg(c, "apt-get") || isProg(c, "apt"), stdout: "apt 2.8", exitCode: 0 },
  ];
}

export function platformFs(platform: HostPlatform): MemoryFs {
  if (platform === "darwin") {
    return new MemoryFs({
      "/opt/homebrew/bin/brew": "#!/bin/sh\n",
      "/Applications": ["Safari.app", "Mail.app"],
      "/Applications/Safari.app": true,
      "/Applications/Mail.app": true,
      "/sys/class/power_supply": true,
    });
  }
  if (platform === "win32") {
    return new MemoryFs({
      "C:/Program Files/WindowsApps/winget.exe": "",
      "C:/Users/alice/AppData/Local/Microsoft/WindowsApps/winget.exe": "",
      "C:/ProgramData/Microsoft/Windows/Start Menu/Programs": ["Safari.lnk", "Code.lnk"],
    });
  }
  return new MemoryFs({
    "/usr/bin/apt-get": "#!/bin/sh\n",
    "/usr/bin/apt-cache": "#!/bin/sh\n",
    "/usr/bin/dpkg-query": "#!/bin/sh\n",
    "/usr/share/applications": ["firefox.desktop"],
    "/usr/share/applications/firefox.desktop": fixture("linux", "firefox.desktop"),
    "/sys/class/power_supply": ["BAT0"],
    "/sys/class/power_supply/BAT0": true,
    "/sys/class/power_supply/BAT0/capacity": "80",
    "/sys/class/power_supply/BAT0/status": "Discharging",
    "/usr/bin/wl-copy": "#!/bin/sh\n",
    "/usr/bin/wl-paste": "#!/bin/sh\n",
    "/usr/bin/notify-send": "#!/bin/sh\n",
    "/usr/bin/xdg-open": "#!/bin/sh\n",
    "/usr/bin/wmctrl": "#!/bin/sh\n",
  });
}

export function makeCtx(platform: HostPlatform, over: Partial<HostContext> = {}): { ctx: HostContext; exec: FakeExec; clock: FakeClock; fs: MemoryFs } {
  const clock = over.clock instanceof FakeClock ? over.clock : new FakeClock();
  const exec = over.exec instanceof FakeExec ? over.exec : new FakeExec(platformScripts(platform), clock);
  const fs = over.fs instanceof MemoryFs ? over.fs : platformFs(platform);
  const os = over.os ?? fakeOs(platform);
  const home = os.homedir();
  const env: Record<string, string | undefined> = {
    PATH: platform === "win32"
      ? "C:\\Windows\\System32;C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps"
      : platform === "darwin" ? "/opt/homebrew/bin:/usr/bin:/bin" : "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
  };
  if (platform === "win32") env.LOCALAPPDATA = "C:\\Users\\alice\\AppData\\Local";
  const { signal, ...rest } = over;
  const ctx: HostContext = {
    env,
    homedir: home,
    pid: 400,
    uid: 501,
    user: "alice",
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
    ...rest,
    platform,
    exec,
    fs,
    os,
    clock,
    ...(signal ? { signal } : {}),
  };
  return { ctx, exec, clock, fs };
}

export function ok<T>(r: HostOutcome, label = ""): T {
  assert.equal(r.isError, false, r.isError ? `${label}${label ? ": " : ""}${JSON.stringify(r.error)}` : "");
  if (r.isError) throw new Error("unreachable");
  return r.value as T;
}

export function isErr(r: { isError: boolean }, code: string): void {
  if (!r.isError) throw new Error(`expected error ${code}, got success`);
}
