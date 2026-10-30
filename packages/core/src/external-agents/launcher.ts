/** #820: ACP processes use the shared sandbox, empty HOME and native resource supervision. */
import { spawn } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { constants, lstatSync, realpathSync } from "node:fs";
import type { Identity } from "../policy/paths.ts";
import { basename, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { backendArgv, detectSandbox } from "../tools/sandbox/backends.ts";
import { preparePolicy } from "../tools/sandbox/policy.ts";
import type { AcpWorktreeMount } from "../tools/sandbox/acp-worktree.ts";
import { matchDeny } from "../policy/paths.ts";
import { DEFAULT_MAX_TASKS } from "../tools/sandbox/types.ts";

export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;
export const MAX_RUN_TIMEOUT_MS = 3_600_000;
export const TRUSTED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const SHELLS = new Set(["sh", "bash", "zsh", "cmd", "cmd.exe", "powershell", "pwsh"]);

/** A typed refusal before the target starts. */
export class LaunchError extends Error {
  readonly reason: "sandbox-unavailable" | "argv" | "spawn-failed" | "aborted";
  constructor(reason: LaunchError["reason"]) {
    super(reason);
    this.name = "LaunchError";
    this.reason = reason;
  }
}

export interface LaunchHandle {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid: number | undefined;
  stop(): void;
  exited: Promise<number | null>;
  exitStatus: { exitCode?: number; signal?: string; reason?: "spawn-failed" | "timeout" };
}

export interface LaunchOptions {
  argv: readonly string[];
  cwd: string;
  home?: string;
  worktree?: string;
  mount?: AcpWorktreeMount;
  /** Discovery only: read-only scratch cwd and no writable bind. */
  probe?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  limitsHelper?: string;
  maxTasks?: number;
  memoryBytes?: number;
  /** Canonical targets retained by D109 classification, never accepted from ACP wire params. */
  approvedCommand?: string;
  approvedCwd?: string;
  approvedCommandIdentity?: Identity;
  approvedCwdIdentity?: Identity;
}

/** Resolve only the executable against the trusted system path; ordinary arguments remain unrestricted. */
export async function resolveCommand(command: string, scope: { worktree?: string; probe?: boolean } = {}): Promise<string> {
  if (!command || command.includes("\0") || SHELLS.has(basename(command))) throw new LaunchError("argv");
  const candidates = isAbsolute(command) ? [command] : TRUSTED_PATH.split(":").map(p => join(p, command));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      const canonical = await realpath(path);
      const system = TRUSTED_PATH.split(":").some(root => canonical.startsWith(root + "/"));
      const local = scope.worktree !== undefined && canonical.startsWith(scope.worktree + "/");
      if (!scope.probe && !system && !local && canonical !== await realpath(process.execPath)) continue;
      return canonical;
    } catch { /* Try the next trusted system directory. */ }
  }
  throw new LaunchError("argv");
}

/** Every async preparation step is followed by a cancellation check before the single spawn boundary. */
export async function launchExternalAgent(o: LaunchOptions): Promise<LaunchHandle> {
  if ((o.platform ?? process.platform) === "win32") throw new LaunchError("sandbox-unavailable");
  if (!o.probe && !o.mount) throw new LaunchError("sandbox-unavailable");
  if (!o.argv.length || o.argv.some(a => typeof a !== "string" || a.includes("\0"))) throw new LaunchError("argv");
  if (!Number.isSafeInteger(o.maxTasks ?? DEFAULT_MAX_TASKS) || (o.maxTasks ?? DEFAULT_MAX_TASKS) < 1)
    throw new LaunchError("sandbox-unavailable");
  const timeoutMs = o.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RUN_TIMEOUT_MS)
    throw new LaunchError("sandbox-unavailable");
  o.signal?.throwIfAborted();
  const program = await resolveCommand(o.argv[0]!, { ...(o.worktree ? { worktree: o.worktree } : {}), ...(o.probe ? { probe: true } : {}) });
  o.signal?.throwIfAborted();
  if (o.approvedCommand && program !== o.approvedCommand) throw new LaunchError("argv");
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "p1b-acp-")));
  const home = o.home ?? o.cwd;
  try {
    o.signal?.throwIfAborted();
    const p = await preparePolicy({
      home, userHome: homedir(), cwd: o.cwd, readRoots: [{ id: "cwd", path: o.worktree ?? o.cwd }],
      writeRoots: o.mount ? [{ id: "worktree", path: o.worktree ?? o.cwd }] : [],
      ...(o.mount ? { acpWorktree: o.mount } : {}), acpScratch: scratch,
      network: "none", envAllow: ["PATH", "HOME", "TMPDIR", "LANG"],
      limitsHelper: o.limitsHelper ?? join(home, "bin", "plur1bus-sandbox-limits"),
      limits: { timeoutMs, cpuSeconds: 60, memoryBytes: o.memoryBytes ?? 8 * 1024 ** 3,
        maxOutputBytes: 1024 * 1024, maxTasks: o.maxTasks ?? DEFAULT_MAX_TASKS },
    });
    o.signal?.throwIfAborted();
    if (o.approvedCwd && p.cwd !== o.approvedCwd) throw new LaunchError("argv");
    if (matchDeny(program, p.denied)) throw new LaunchError("argv");
    // The absolute executable is trusted composition input. Mount the file, never its home directory.
    p.runtimePaths = [...new Set([...p.runtimePaths.filter(path => !path.startsWith("/dev/")), program, process.execPath, ...(process.platform === "linux" ? ["/etc/passwd"] : [])])];
    p.runtimeRoots = [...new Set([...p.runtimeRoots, program, process.execPath, ...(process.platform === "linux" ? ["/etc/passwd"] : [])])];
    const detection = await detectSandbox(p.limitsHelper);
    o.signal?.throwIfAborted();
    if (!detection.available || (process.platform === "linux" && detection.tasks.mechanism !== "namespace-limit"))
      throw new LaunchError("sandbox-unavailable");
    const command = await backendArgv(p, detection, [program, ...o.argv.slice(1)]);
    o.signal?.throwIfAborted();
    if (o.approvedCommand && await realpath(program) !== o.approvedCommand) throw new LaunchError("argv");
    o.signal?.throwIfAborted();
    if (o.approvedCwd && await realpath(p.cwd) !== o.approvedCwd) throw new LaunchError("argv");
    o.signal?.throwIfAborted();
    const resource = [String(p.limits.cpuSeconds), String(p.limits.memoryBytes), ...command];
    const args = process.platform === "darwin"
      ? ["--watch-tree", String(p.limits.maxTasks), String(p.limits.memoryBytes), "--", p.limitsHelper, ...resource]
      : resource;
    // Last check is synchronous: neither canonical target may change across the final async preparation step.
    for (const [path, expected, identity] of [[program, o.approvedCommand, o.approvedCommandIdentity], [p.cwd, o.approvedCwd, o.approvedCwdIdentity]] as const) {
      if (!expected) continue;
      const stat = lstatSync(path, { bigint: true });
      if (realpathSync(path) !== expected || (identity && (String(stat.dev) !== identity.dev || String(stat.ino) !== identity.ino
        || (identity.birth !== undefined && String(stat.birthtimeNs) !== identity.birth)))) throw new LaunchError("argv");
    }
    o.signal?.throwIfAborted();
    const child = spawn(p.limitsHelper, args, {
      cwd: p.cwd, env: { PATH: TRUSTED_PATH, HOME: scratch, TMPDIR: scratch, LANG: "C.UTF-8" },
      detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* Already reaped. */ }
      setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* Already reaped. */ }
      }, 100).unref();
    };
    const exitStatus: LaunchHandle["exitStatus"] = {};
    const timer = setTimeout(() => { exitStatus.reason = "timeout"; stop(); }, timeoutMs);
    const abort = () => stop();
    o.signal?.addEventListener("abort", abort, { once: true });
    if (o.signal?.aborted) stop();
    const exited = new Promise<number | null>(resolve => {
      child.once("error", () => { exitStatus.reason = "spawn-failed"; resolve(null); });
      child.once("close", (code, signal) => {
        if (code !== null) exitStatus.exitCode = code;
        if (signal) exitStatus.signal = signal;
        resolve(code);
      });
    }).finally(async () => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", abort);
      stop();
      await rm(scratch, { recursive: true, force: true });
    });
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, pid: child.pid, stop, exited, exitStatus };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
