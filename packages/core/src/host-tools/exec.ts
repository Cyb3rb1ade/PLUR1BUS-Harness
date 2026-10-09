import { spawn } from "node:child_process";
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

function clamp(v: number | undefined, def: number, max: number): number {
  if (v === undefined) return def;
  if (!Number.isInteger(v) || v < 1) throw new HostFailure("invalid_input", "timeout and size limits must be positive integers");
  return Math.min(v, max);
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
        const finish = (r: ExecResult): void => { if (!settled) { settled = true; resolve(r); } };
        try {
          const child = spawn(req.program, [...args], {
            cwd: req.cwd, env: req.env ? { ...req.env } : undefined,
            shell: false, windowsHide: true,
            stdio: [req.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
          });
          child.stdout?.on("data", (c: Uint8Array) => out.push(c));
          child.stderr?.on("data", (c: Uint8Array) => err.push(c));
          if (req.stdin !== undefined) {
            child.stdin?.write(req.stdin);
            child.stdin?.end();
          }
          const kill = (): void => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
          const timer = clock.setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
          const onAbort = (): void => { aborted = true; kill(); };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
          child.once("error", (e) => {
            clock.clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (settled) return;
            settled = true;
            reject(e);
          });
          child.once("close", (code, sig) => {
            clock.clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            finish({
              exitCode: code, signal: sig, stdout: out.text(), stderr: err.text(),
              truncated: out.truncated || err.truncated, timedOut, aborted,
              durationMs: clock.now() - started,
            });
          });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
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
