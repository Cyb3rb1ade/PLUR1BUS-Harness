import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAuditSink } from "../../../src/rbac/audit.ts";
import type { ApprovalPort, ExecConfig, ExecDeps, ExitInfo, ProcessHandle, ProcessPort, SpawnSpec, TimerPort } from "../../../src/tools/exec/index.ts";
import { ctx, FakeClock, MemoryGrants } from "../../policy/helpers.ts";
import type { Grant } from "../../../src/policy/index.ts";

export class FakeTimers implements TimerPort {
  t = 1_000_000;
  pending: Array<{ at: number; fn: () => void; id: number; cleared: boolean }> = [];
  private seq = 0;
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): unknown { const e = { at: this.t + ms, fn, id: ++this.seq, cleared: false }; this.pending.push(e); return e; }
  clearTimeout(h: unknown): void { (h as { cleared: boolean }).cleared = true; }
  advance(ms: number): void {
    this.t += ms;
    for (const e of this.pending.filter((p) => !p.cleared && p.at <= this.t)) { e.cleared = true; e.fn(); }
  }
}

export class FakeProcess implements ProcessHandle {
  pid = 4242;
  kills = 0;
  private out: Array<(c: Uint8Array) => void> = [];
  private err: Array<(c: Uint8Array) => void> = [];
  private resolve!: (x: ExitInfo) => void;
  private reject!: (e: Error) => void;
  private readonly done = new Promise<ExitInfo>((res, rej) => { this.resolve = res; this.reject = rej; });
  readonly spec: SpawnSpec;
  readonly killedExit: ExitInfo = { code: null, signal: "SIGKILL" };
  constructor(spec: SpawnSpec) { this.spec = spec; }
  onStdout(cb: (c: Uint8Array) => void): void { this.out.push(cb); }
  onStderr(cb: (c: Uint8Array) => void): void { this.err.push(cb); }
  wait(): Promise<ExitInfo> { return this.done; }
  async killTree(): Promise<void> { this.kills += 1; this.resolve(this.killedExit); }
  stdout(s: string | Uint8Array): void { const b = typeof s === "string" ? Buffer.from(s) : s; for (const f of this.out) f(b); }
  stderr(s: string): void { for (const f of this.err) f(Buffer.from(s)); }
  exit(code = 0): void { this.resolve({ code, signal: null }); }
  fail(e: Error): void { this.reject(e); }
}

export class FakePort implements ProcessPort {
  spawned: FakeProcess[] = [];
  onSpawn: (p: FakeProcess) => void = () => {};
  spawn(spec: SpawnSpec): ProcessHandle { const p = new FakeProcess(spec); this.spawned.push(p); queueMicrotask(() => this.onSpawn(p)); return p; }
}

export function tmpRoot(): { root: string; sub: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "p1b-exec-")));
  const sub = join(root, "work");
  mkdirSync(sub);
  return { root, sub };
}

export function mk(over: Partial<ExecConfig> & { root: string }, extra: Partial<ExecDeps> = {}, grants: Grant[] = []) {
  const { root, ...cfg } = over;
  const audit = memoryAuditSink();
  const timers = new FakeTimers();
  const port = new FakePort();
  const asked: unknown[] = [];
  const approvals: ApprovalPort = { request: async (r) => { asked.push(r); return { approved: true }; } };
  const deps: ExecDeps = {
    config: { mode: "allowlist", roots: [{ id: "r", path: root }], allowlist: [{ program: "git" }], ...cfg },
    process: port, timers, audit,
    policy: { grants: new MemoryGrants(grants), clock: new FakeClock() },
    baseEnv: { PATH: "/usr/bin", HOME: "/home/x", API_TOKEN: "t0ps3cret", AWS_SECRET_ACCESS_KEY: "k" },
    policyContext: ctx(), approvals, platform: "linux", ...extra,
  };
  return { deps, audit, timers, port, asked };
}
