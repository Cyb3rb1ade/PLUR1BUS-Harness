// Bounded process start for an external ACP agent. No shell. The child env is the allowlist from containment.
import { spawn, type ChildProcess } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { childEnv } from "./containment.ts";

export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;

const SHELLS = new Set(["sh", "bash", "zsh", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);

export class LaunchError extends Error {
  readonly reason: "sandbox-unavailable" | "argv" | "spawn-failed";
  constructor(reason: "sandbox-unavailable" | "argv" | "spawn-failed") {
    super(reason);
    this.name = "LaunchError";
    this.reason = reason;
  }
}

export interface LaunchHandle {
  stdin: Writable;
  stdout: Readable;
  pid: number | undefined;
  stop: () => void;
  exited: Promise<number | null>;
}

/** Starts `argv[0]` directly. Windows is refused. A timeout or abort kills the process group. */
export function launchExternalAgent(o: {
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
}): LaunchHandle {
  const platform = o.platform ?? process.platform;
  if (platform === "win32") throw new LaunchError("sandbox-unavailable");
  if (!argvOk(o.argv)) throw new LaunchError("argv");
  const timeoutMs = o.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  let child: ChildProcess;
  try {
    child = spawn(o.argv[0]!, o.argv.slice(1), {
      cwd: o.cwd,
      env: childEnv(o.env),
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw new LaunchError("spawn-failed");
  }
  child.stderr?.resume();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }, 100).unref();
  };
  const timer = setTimeout(stop, timeoutMs);
  timer.unref?.();
  const onAbort = () => stop();
  if (o.signal?.aborted) stop();
  else o.signal?.addEventListener("abort", onAbort, { once: true });
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve(code);
    });
  });
  return { stdin: child.stdin!, stdout: child.stdout!, pid: child.pid, stop, exited };
}

function argvOk(argv: readonly string[]): boolean {
  if (argv.length === 0 || !argv[0] || !isAbsolute(argv[0])) return false;
  return argv.every((a) => typeof a === "string" && a.length > 0 && !a.includes("\0") && !SHELLS.has(basename(a).toLowerCase()));
}
