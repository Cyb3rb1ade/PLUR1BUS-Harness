import { spawn, type ChildProcess } from "node:child_process";
import { HostFailure } from "./errors.ts";
import {
  DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, HARD_MAX_OUTPUT_BYTES, HARD_MAX_TIMEOUT_MS,
  type ExecRequest, type ExecResult, type HostClock, type HostExec,
} from "./types.ts";

class Capture {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  truncated = false;
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  push(c: Uint8Array): void {
    const room = this.limit - this.size;
    if (room <= 0) { if (c.length > 0) this.truncated = true; return; }
    const take = c.length > room ? c.subarray(0, room) : c;
    if (take.length < c.length) this.truncated = true;
    this.chunks.push(take);
    this.size += take.length;
  }
  text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
}

/** Spawn errors carry the program path and OS detail; callers only get a classified, path-free failure. */
function spawnFailure(e: unknown): HostFailure {
  const c = (e as { code?: unknown } | null)?.code;
  if (c === "ENOENT" || c === "ENOTDIR") return new HostFailure("not_found", "the program was not found");
  if (c === "EACCES" || c === "EPERM") return new HostFailure("permission_denied", "the program could not be started");
  return new HostFailure("not_found", "the program could not be started");
}

function clamp(v: number | undefined, def: number, max: number): number {
  if (v === undefined) return def;
  if (!Number.isInteger(v) || v < 1) throw new HostFailure("invalid_input", "timeout and size limits must be positive integers");
  return Math.min(v, max);
}

/** How long output still in flight is read after the leader exited, before a descendant that kept the pipes open is cut loose. */
const DRAIN_MS = 250;

/** Ends the leader and everything still in its process group (POSIX) or tree (Windows); never throws. */
function killTree(child: ChildProcess): void {
  try {
    if (child.pid && process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
      killer.once("error", () => { /* the plain kill below still ends the leader */ });
      killer.unref();
    } else if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch { /* no such group: fall through to the leader itself */ }
  try { child.kill("SIGKILL"); } catch { /* gone */ }
}

export function createNodeExec(clock: HostClock): HostExec {
  return {
    run(req: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
      if (typeof req.program !== "string" || req.program.length === 0 || req.program.includes("\0")) {
        return Promise.reject(new HostFailure("invalid_input", "program must be a non-empty string"));
      }
      const args = req.args ?? [];
      if (args.some((a) => typeof a !== "string" || a.includes("\0"))) {
        return Promise.reject(new HostFailure("invalid_input", "arguments must be strings without NUL"));
      }
      const timeoutMs = clamp(req.timeoutMs, DEFAULT_TIMEOUT_MS, HARD_MAX_TIMEOUT_MS);
      const maxBytes = clamp(req.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, HARD_MAX_OUTPUT_BYTES);
      const started = clock.now();
      const out = new Capture(maxBytes);
      const err = new Capture(maxBytes);
      return new Promise((resolve, reject) => {
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let drain: ReturnType<typeof setTimeout> | undefined;
        const finish = (r: ExecResult): void => { if (!settled) { settled = true; resolve(r); } };
        try {
          const child = spawn(req.program, [...args], {
            cwd: req.cwd, env: req.env ? { ...req.env } : undefined,
            shell: false, windowsHide: true,
            // Its own process group, so that the time limit can end the leader's descendants too.
            detached: process.platform !== "win32",
            stdio: [req.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
          });
          child.stdout?.on("data", (c: Uint8Array) => out.push(c));
          child.stderr?.on("data", (c: Uint8Array) => err.push(c));
          if (req.stdin !== undefined) {
            // A child that exits without draining stdin raises EPIPE here; unhandled it would crash the host.
            child.stdin?.on("error", () => { /* the exit status tells the story */ });
            child.stdin?.end(req.stdin);
          }
          const kill = (): void => killTree(child);
          const timer = clock.setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
          const onAbort = (): void => { aborted = true; kill(); };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
          child.once("error", (e) => {
            clock.clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (settled) return;
            settled = true;
            reject(spawnFailure(e));
          });
          const complete = (code: number | null, sig: NodeJS.Signals | null): void => {
            clock.clearTimeout(timer);
            if (drain) clearTimeout(drain);
            signal?.removeEventListener("abort", onAbort);
            finish({
              exitCode: code, signal: sig, stdout: out.text(), stderr: err.text(),
              truncated: out.truncated || err.truncated, timedOut, aborted,
              durationMs: clock.now() - started,
            });
          };
          // "close" waits until every holder of the pipes let go. A descendant that inherited stdout and detached
          // would keep the call open for ever, so once the leader is gone only a short drain is waited for.
          child.once("exit", (code, sig) => {
            if (settled) return;
            drain = setTimeout(() => {
              for (const stream of [child.stdout, child.stderr, child.stdin]) { try { stream?.destroy(); } catch { /* closed */ } }
              complete(code, sig);
            }, DRAIN_MS);
            drain.unref?.();
          });
          child.once("close", complete);
        } catch (e) {
          reject(e instanceof HostFailure ? e : spawnFailure(e));
        }
      });
    },
  };
}

export async function runCaptured(ctx: { exec: HostExec; clock: HostClock; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }, req: ExecRequest): Promise<ExecResult> {
  const signal = ctx.signal;
  if (signal?.aborted) throw new HostFailure("aborted", "the call was aborted");
  const r = await ctx.exec.run({
    ...req,
    timeoutMs: req.timeoutMs ?? ctx.timeoutMs,
    maxOutputBytes: req.maxOutputBytes ?? ctx.maxOutputBytes,
  }, signal);
  if (r.aborted) throw new HostFailure("aborted", "the call was aborted");
  if (r.timedOut) throw new HostFailure("timeout", "the command timed out");
  return r;
}

/** Like runCaptured, but a non-zero exit (or a truncated capture when `whole`) is a failure the caller must see. */
export async function runChecked(
  ctx: Parameters<typeof runCaptured>[0],
  req: ExecRequest,
  failure: { code: "not_found" | "permission_denied" | "not_supported_on_platform"; message: string },
  opts: { whole?: boolean } = {},
): Promise<ExecResult> {
  const r = await runCaptured(ctx, req);
  if (r.exitCode !== 0) throw new HostFailure(failure.code, failure.message);
  if (opts.whole && r.truncated) throw new HostFailure("too_large", "the command output exceeded the size limit");
  return r;
}
