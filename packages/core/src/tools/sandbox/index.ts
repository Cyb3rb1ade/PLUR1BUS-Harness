import { posix, win32 } from 'node:path';
import { BoundedCapture } from './capture.ts';
import { execFile } from 'node:child_process';
import { createNodeProcessPort } from '../exec/node-process.ts';
import { isSecretishName } from '../exec/env.ts';
import { backendArgv, detectSandbox } from './backends.ts';
import { preparePolicy } from './policy.ts';
import { SandboxFailure, type SandboxPolicy, type SandboxResult } from './types.ts';
export { detectSandbox, seatbeltProfile } from './backends.ts';
export { preparePolicy } from './policy.ts';
export * from './types.ts';
/** Fixed argv only. The policy and executable installation path come from trusted composition. */
export async function sandboxSpawn(argv: readonly string[], policy: SandboxPolicy, options: { signal?: AbortSignal } = {}): Promise<SandboxResult> {
  if (!argv.length || argv.some(s => typeof s !== 'string' || s.includes('\0')) || !(process.platform === 'win32' ? win32 : posix).isAbsolute(argv[0]!)) throw new SandboxFailure('sandbox requires an absolute executable and NUL-free argv');
  if (process.platform === 'win32') {
    const unavailable = await detectSandbox(policy.limitsHelper);
    throw new SandboxFailure(unavailable.reason);
  }
  const p = await preparePolicy(policy);
  const detection = await detectSandbox(p.limitsHelper);
  if (!detection.available) throw new SandboxFailure(detection.reason);
  const command = await backendArgv(p, detection, argv);
  const env: Record<string, string> = {};
  const allowed = new Set(p.envAllow);
  for (const [name, value] of Object.entries(p.env ?? {})) {
    // Loader/config injection remains forbidden even if mistakenly allowlisted by a caller.
    if (!allowed.has(name) || isSecretishName(name) || /^(?:PLUR1BUS_|NODE_|DYLD_|LD_|PYTHON|PERL|RUBY|BASH_ENV|ENV$)/i.test(name)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value?.includes('\0')) throw new SandboxFailure('invalid sandbox environment');
    if (value !== undefined) env[name] = value;
  }
  const started = Date.now();
  const out = new BoundedCapture(p.limits.maxOutputBytes), err = new BoundedCapture(p.limits.maxOutputBytes);
  let timedOut = false, aborted = false;
  const resources = () => ({ durationMs: Date.now() - started, cpuSeconds: p.limits.cpuSeconds, memoryBytes: p.limits.memoryBytes, measured: false as const });
  const sandbox = { ...detection, network: p.network === 'egress' ? 'none' as const : p.network, warnings: p.network === 'egress' ? ['Egress proxy enforcement unavailable; network forced to none.'] : [] };
  if (options.signal?.aborted) return { exitCode: null, signal: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut, aborted: true, resources: resources(), sandbox };
  const child = createNodeProcessPort().spawn({ program: p.limitsHelper, args: [String(p.limits.cpuSeconds), String(p.limits.memoryBytes), ...command], cwd: p.cwd, env });
  child.onStdout(c => out.push(c)); child.onStderr(c => err.push(c));
  const kill = () => { void child.killTree(); };
  let sampling = false;
  const memoryTimer = process.platform === 'darwin' ? setInterval(() => {
    if (sampling || child.pid === undefined) return;
    sampling = true;
    execFile('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], { timeout: 1000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => {
      sampling = false;
      // A failed observation cannot silently drop the requested bound.
      if (error || !/^\s*\d+\s*$/.test(stdout) || Number(stdout.trim()) * 1024 > p.limits.memoryBytes) kill();
    });
  }, 100) : undefined;
  const timer = setTimeout(() => { timedOut = true; kill(); }, p.limits.timeoutMs);
  const onAbort = () => { aborted = true; kill(); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    const exit = await child.wait();
    return { exitCode: exit.code, signal: exit.signal, stdout: out.text(), stderr: err.text(), stdoutTruncated: out.truncated, stderrTruncated: err.truncated, timedOut, aborted, resources: resources(), sandbox };
  } finally { clearTimeout(timer); if (memoryTimer) clearInterval(memoryTimer); options.signal?.removeEventListener('abort', onAbort); await child.killTree(); }
}
