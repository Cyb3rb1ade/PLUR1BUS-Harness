import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { PathRoot, DenyEntry } from '../../policy/paths.ts';
import type { AuditSink } from '../../rbac/audit.ts';
import type { ProcessPort, SpawnSpec } from '../exec/types.ts';
import { createNodeProcessPort } from '../exec/node-process.ts';
import { buildEnv, DEFAULT_ENV_ALLOW } from '../exec/env.ts';
import type { HostExec } from '../../host-tools/types.ts';
import { createNodeExec } from '../../host-tools/exec.ts';
import { systemClock } from '../../host-tools/context.ts';
import { sandboxSpawn, SandboxFailure, type SandboxPolicy } from './index.ts';
export interface SandboxOptions { required?: boolean; limitsHelper?: string }
export interface SandboxPortsOptions {
  home: string; roots: readonly PathRoot[]; deny: readonly DenyEntry[];
  sandbox?: SandboxOptions; audit: AuditSink; principal: string;
}
async function executable(program: string): Promise<string> {
  // Resolve on trusted system PATH only, never the model-controlled cwd or requested PATH.
  const paths = isAbsolute(program) ? [program] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map(p => join(p, program));
  for (const p of paths) try { await access(p, constants.X_OK); return await realpath(p); } catch { /* next trusted prefix */ }
  throw new SandboxFailure('program is unavailable on the sandbox system path');
}
function policy(o: SandboxPortsOptions, spec: SpawnSpec): SandboxPolicy {
  return { home: o.home, userHome: homedir(), cwd: spec.cwd, readRoots: o.roots, writeRoots: o.roots, deny: o.deny, network: 'none', envAllow: DEFAULT_ENV_ALLOW, env: spec.env, limitsHelper: o.sandbox?.limitsHelper ?? join(o.home, 'bin', 'plur1bus-sandbox-limits'), limits: { timeoutMs: 300000, cpuSeconds: 30, memoryBytes: 512 * 1024 ** 2, maxProcesses: 64, maxOutputBytes: 1024 * 1024 } };
}
function bypass(o: SandboxPortsOptions): void {
  // A failed audit write throws before spawn. The bypass is trusted configuration, never a tool argument.
  o.audit.append({ at: Date.now(), actor: { user: o.principal, host: 'local' }, action: 'sandbox.bypass', target: 'tools.sandbox.required', detail: { required: false, sandboxed: false } });
}
export function createSandboxProcessPort(o: SandboxPortsOptions): ProcessPort {
  return { spawn(spec) {
    if (o.sandbox?.required === false) { bypass(o); return createNodeProcessPort().spawn(spec); }
    const ac = new AbortController();
    const stdout: ((c: Uint8Array) => void)[] = [], stderr: ((c: Uint8Array) => void)[] = [];
    const done = Promise.resolve().then(async () => {
      const r = await sandboxSpawn([await executable(spec.program), ...spec.args], policy(o, spec), { signal: ac.signal });
      for (const cb of stdout) cb(Buffer.from(r.stdout)); for (const cb of stderr) cb(Buffer.from(r.stderr));
      return { code: r.exitCode, signal: r.signal };
    });
    // The existing exec runner attaches wait in the same tick.
    return { pid: undefined, onStdout: cb => { stdout.push(cb); }, onStderr: cb => { stderr.push(cb); }, wait: () => done, async killTree() { ac.abort(); await done.catch(() => {}); } };
  } };
}
export function createSandboxHostExec(o: SandboxPortsOptions): HostExec {
  return { async run(req, signal) {
    if (o.sandbox?.required === false) { bypass(o); return createNodeExec(systemClock).run({ ...req, env: buildEnv({ allow: DEFAULT_ENV_ALLOW, base: req.env ?? process.env, windows: process.platform === 'win32' }) }, signal); }
    if (req.stdin !== undefined) throw new SandboxFailure('sandbox stdin adapter unavailable; no process launched');
    const cwd = req.cwd ?? o.roots[0]?.path;
    if (!cwd) throw new SandboxFailure('sandbox requires a workspace root');
    const p = policy(o, { program: req.program, args: req.args, cwd, env: req.env ?? { PATH: '/usr/bin:/bin' } });
    const r = await sandboxSpawn([await executable(req.program), ...req.args], { ...p, limits: { ...p.limits, timeoutMs: req.timeoutMs ?? 30000, maxOutputBytes: req.maxOutputBytes ?? 65536 } }, { ...(signal ? { signal } : {}) });
    return { exitCode: r.exitCode, signal: r.signal, stdout: r.stdout, stderr: r.stderr, truncated: r.stdoutTruncated || r.stderrTruncated, timedOut: r.timedOut, aborted: r.aborted, durationMs: r.resources.durationMs };
  } };
}
