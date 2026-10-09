import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fail, integer, string } from './errors.ts';
import type { HostctlConfig } from './config.ts';
export interface RunContext { agentId: string; principal: string; sessionId?: string; signal: AbortSignal; surface?: 0 | 1 | 2 | 3 }
export type Spawn = (program: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface ProcessOptions { spawn?: Spawn; killTree?: (child: ChildProcess) => Promise<void>; baseEnv?: NodeJS.ProcessEnv }
interface Job { id: string; owner: string; session: string; child: ChildProcess; output: Buffer; truncated: boolean; timedOut: boolean; terminating: boolean; done: boolean; exitCode: number | null; timer: ReturnType<typeof setTimeout>; finished: Promise<void>; abort: () => void; signal: AbortSignal }
const owner = (c: RunContext) => JSON.stringify([c.agentId, c.principal, c.sessionId ?? '']);
const blockedEnv = /secret|token|password|credential|private|^NODE_OPTIONS$|^LD_|^DYLD_|^PYTHONPATH$|^BASH_ENV$|^ENV$|^PSModulePath$/i;
const dangerous = /(?:^|[\s/\\])(?:format(?:\.com)?|diskpart(?:\.exe)?|mkfs(?:\.[\w]+)?|sudo|doas|pkexec|runas)(?:\s|$)|\brm\s+[^\n]*-[a-z]*r[a-z]*f[a-z]*\s+["']?\/(?:["']?(?:\s|$))|\breg(?:\.exe)?\s+(?:delete|load|restore)\b|HKEY_LOCAL_MACHINE|\\Device\\|\\\\\.\\/i;
export async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') await new Promise<void>((resolve, reject) => { const killer = nodeSpawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }); killer.once('error', reject); killer.once('close', () => resolve()); });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } }
}
export function processes(config: HostctlConfig, canon: (p: string, access: 'read' | 'write') => Promise<{ canonical: string }>, o: ProcessOptions = {}) {
  const jobs = new Map<string, Job>(); const spawn = o.spawn ?? nodeSpawn; const stop = o.killTree ?? killTree;
  const get = (a: Record<string, unknown>, ctx: RunContext) => { const job = jobs.get(string(a, 'id')); if (!job || job.owner !== owner(ctx)) fail('DENIED', 'Use a process session ID started in this agent session.'); return job; };
  const result = (j: Job) => ({ id: j.id, pid: j.child.pid, output: j.output.toString('utf8') + (j.truncated ? '\n[OUTPUT TRUNCATED]' : ''), truncated: j.truncated, timedOut: j.timedOut, running: !j.done, exitCode: j.exitCode });
  const terminate = async (j: Job) => { if (!j.done && !j.terminating) { j.terminating = true; await stop(j.child); } };
  const start = async (a: Record<string, unknown>, ctx: RunContext, shell: boolean) => {
    if ([...jobs.values()].filter(j => !j.done).length >= 32) fail('TOO_LARGE', 'At most 32 processes may run per root pool.');
    if (jobs.size >= 128) { const old = [...jobs.values()].find(j => j.done); if (old) jobs.delete(old.id); else fail('TOO_LARGE', 'Process session limit reached.'); }
    ctx.signal.throwIfAborted(); if (!ctx.sessionId) fail('DENIED', 'A harness session is required for process ownership.');
    if (shell && !config.shell.allowed) fail('DENIED', 'Shell execution is disabled in tools.hostctl.shell.allowed.');
    const program = shell ? config.shell.default : string(a, 'program');
    // Explicit shell launchers must use proc.shell, otherwise shell.allowed could be bypassed accidentally.
    if (!shell && /^(?:bash|zsh|sh|dash|fish|pwsh|powershell|cmd)(?:\.exe)?$/i.test(path.basename(program))) fail('DENIED', 'Use proc.shell for shell interpreters.');
    if (a.args !== undefined && (!Array.isArray(a.args) || a.args.some(v => typeof v !== 'string' || v.includes('\0')))) fail('INVALID_ARGUMENT', 'args must be an array of strings.');
    const args = shell ? (program === 'pwsh' ? ['-NoProfile', '-NonInteractive', '-Command', string(a, 'command')] : ['-c', string(a, 'command')]) : (a.args ?? []) as string[];
    const command = [program, ...args].join(' ');
    const rmRoot = /^rm(?:\.exe)?$/i.test(path.basename(program)) && args.some(a => /^\/+$/u.test(a) || /^[a-z]:[\\/]*$/i.test(a)) && args.some(a => a === '--recursive' || /^-[a-z]*[rR]/.test(a));
    if (rmRoot || dangerous.test(command) || config.denyPatterns.some(p => command.toLowerCase().includes(p.toLowerCase()))) fail('DENIED', 'Dangerous command refused; use a bounded file operation instead.');
    const cwd = (await canon(string(a, 'cwd'), 'read')).canonical;
    const env: NodeJS.ProcessEnv = {}; const base = o.baseEnv ?? process.env;
    for (const key of config.env.allow) if (!blockedEnv.test(key) && base[key] !== undefined) env[key] = base[key];
    if (a.env !== undefined && (!a.env || typeof a.env !== 'object' || Array.isArray(a.env))) fail('INVALID_ARGUMENT', 'env must be an object.');
    for (const [key, value] of Object.entries((a.env ?? {}) as object)) {
      if (!config.env.allow.includes(key) || blockedEnv.test(key)) fail('DENIED', 'Environment key is not allowlisted.');
      if (typeof value !== 'string' || value.includes('\0')) fail('INVALID_ARGUMENT', 'Environment values must be strings.'); env[key] = value;
    }
    const timeout = integer(a.timeoutMs, config.exec.timeoutMs, config.exec.timeoutMs); if (!timeout) fail('INVALID_ARGUMENT', 'timeoutMs must be positive.');
    ctx.signal.throwIfAborted(); const child = spawn(program, args, { cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let finish!: () => void; const finished = new Promise<void>(resolve => { finish = resolve; });
    const j: Job = { id: randomUUID(), owner: owner(ctx), session: ctx.sessionId, child, output: Buffer.alloc(0), truncated: false, timedOut: false, terminating: false, done: false, exitCode: null, timer: setTimeout(() => { j.timedOut = true; void terminate(j).catch(() => {}); }, timeout), finished, abort: () => { void terminate(j).catch(() => {}); }, signal: ctx.signal };
    jobs.set(j.id, j); j.timer.unref?.(); ctx.signal.addEventListener('abort', j.abort, { once: true });
    const append = (data: Buffer | string) => { const bytes = Buffer.from(data); const room = config.output.maxBytes - j.output.length; if (bytes.length > room) j.truncated = true; if (room > 0) j.output = Buffer.concat([j.output, bytes.subarray(0, room)]); };
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    const done = (code: number | null) => { if (j.done) return; j.done = true; j.exitCode = code; clearTimeout(j.timer); ctx.signal.removeEventListener('abort', j.abort); if (process.platform !== 'win32' && !j.terminating) { j.terminating = true; void stop(child).catch(() => {}); } finish(); };
    child.stdin?.on('error', () => {});
    child.once('error', () => done(-1)); child.once('close', code => done(code));
    if (ctx.signal.aborted) j.abort(); return j;
  };
  return {
    async run(op: string, a: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
      if (op === 'list') return { processes: [...jobs.values()].filter(j => j.owner === owner(ctx)).map(result) };
      if (op === 'exec' || op === 'start' || op === 'shell') { const j = await start(a, ctx, op === 'shell'); if (op !== 'start') { j.child.stdin?.end(); await j.finished; if (j.timedOut) fail('TIMEOUT', 'Process lifetime exceeded; use a smaller task or increase the configured timeout.'); } return result(j); }
      const j = get(a, ctx);
      if (op === 'read_output') return result(j);
      if (op === 'kill') { await terminate(j); return result(j); }
      if (op === 'write_stdin') { if (j.done) fail('DENIED', 'The process has exited.'); const text = string(a, 'text'); if (Buffer.byteLength(text) > config.output.maxBytes) fail('TOO_LARGE', 'Send less stdin per call.'); j.child.stdin?.write(text); if (a.eof === true) j.child.stdin?.end(); return { written: Buffer.byteLength(text) }; }
      return fail('INVALID_ARGUMENT', 'Unknown process operation.');
    },
    async endSession(sessionId: string) { for (const [id, j] of jobs) if (j.session === sessionId) { await terminate(j); clearTimeout(j.timer); j.signal.removeEventListener('abort', j.abort); jobs.delete(id); } },
    async close() { for (const j of jobs.values()) await terminate(j); for (const j of jobs.values()) { clearTimeout(j.timer); j.signal.removeEventListener('abort', j.abort); } jobs.clear(); },
  };
}
