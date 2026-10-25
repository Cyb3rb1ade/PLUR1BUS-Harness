import { execFile } from 'node:child_process';
import { access, lstat, readdir } from 'node:fs/promises';
import { constants, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { PreparedPolicy } from './policy.ts';
import { SandboxFailure, type SandboxDetection, type SandboxTasks } from './types.ts';
/** Trusted launcher path inside a bubblewrap run. */
export const INNER_LAUNCHER = '/run/plur1bus/sandbox-limits';
let outerNamespace: string | undefined;
/** Snapshot the core's namespace once; unreadable means that the inner launcher must skip the cap. */
export function outerUserNamespace(): string {
  if (outerNamespace === undefined) try { outerNamespace = readlinkSync('/proc/self/ns/user'); }
  catch { outerNamespace = ''; /* No safe namespace comparison is possible. */ }
  return outerNamespace;
}
/** Bind the trusted launcher before sealing the root; allow one extra task for bubblewrap's init. */
export function tasksStep(limitsHelper: string, maxTasks: number): { bind: string[]; prefix: string[] } {
  return { bind: ['--ro-bind', limitsHelper, INNER_LAUNCHER],
    prefix: [INNER_LAUNCHER, '--tasks', String(maxTasks + 1), outerUserNamespace(), '--'] };
}
const BWRAP_PROBE = ['--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
  '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64'];
const taskProbes = new Map<string, Promise<SandboxTasks>>();
const probeFailed = (): SandboxTasks => ({ mechanism: 'none', reason: 'The process-cap probe could not run.',
  hint: 'Install the plur1bus-sandbox-limits launcher of this release.' });
/** Measure Linux task accounting with at most four forks; cache once per trusted launcher for the core lifetime. */
export function probeTasks(limitsHelper: string): Promise<SandboxTasks> {
  let result = taskProbes.get(limitsHelper);
  if (!result) {
    result = new Promise<SandboxTasks>(resolve => {
      const args = [...BWRAP_PROBE, '--proc', '/proc', '--ro-bind', limitsHelper, INNER_LAUNCHER,
        '--', INNER_LAUNCHER, '--probe-tasks', outerUserNamespace()];
      execFile('/usr/bin/bwrap', args, { timeout: 3000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => {
        if (error) { resolve(probeFailed()); return; }
        switch (stdout.trim()) {
          case 'enforced': resolve({ mechanism: 'namespace-limit', reason: 'Each sandboxed run has its own task limit in its own user namespace.' }); break;
          case 'per-user': resolve({ mechanism: 'none', reason: 'This kernel counts processes per user, not per sandbox; a cap would limit every process of the user.',
            hint: 'Linux 5.14 or newer enforces the cap per sandbox.' }); break;
          case 'not-enforced': resolve({ mechanism: 'none', reason: 'The kernel does not apply process limits to root.', hint: 'Run PLUR1BUS as a normal user.' }); break;
          case 'shared-userns': resolve({ mechanism: 'none', reason: 'bubblewrap did not create a user namespace; a cap would count every process of the user.',
            hint: 'Use a bubblewrap without setuid, with unprivileged user namespaces enabled.' }); break;
          default: resolve(probeFailed());
        }
      });
    });
    taskProbes.set(limitsHelper, result);
  }
  return result;
}
const quote = (s: string): string => JSON.stringify(s);
export function seatbeltProfile(p: PreparedPolicy): string {
  const lines = ['(version 1)', '(deny default)', '(allow process-exec)', '(allow sysctl-read)', '(allow mach-lookup (global-name "com.apple.system.logger"))', '(allow file-read-metadata)', '(allow file-read-data (literal "/"))'];
  for (const r of [...p.runtimeRoots, ...p.readRoots.map(r => r.path), ...p.writeRoots.map(r => r.path)]) lines.push(`(allow file-read* (subpath ${quote(r)}))`);
  for (const r of p.writeRoots) lines.push(`(allow file-write* (subpath ${quote(r.path)}))`);
  lines.push('(allow file-write-data (literal "/dev/null"))');
  if (p.network === 'full') lines.push('(allow network*)');
  // Explicit deny wins over a root allow. Name rules also cover files created after launch.
  for (const d of p.denied) lines.push('path' in d
    ? `(deny file-read* file-write* (subpath ${quote(d.path)}))`
    : `(deny file-read* file-write* (regex #${quote('(^|/)' + [...d.name].map(c => /[a-z]/i.test(c) ? '[' + c.toLowerCase() + c.toUpperCase() + ']' : c === '.' ? '[.]' : c.replace(/[^a-z0-9_-]/gi, '')).join('') + '(/|$)')}))`);
  // No process-fork permission: descendants cannot detach from the supervised process group.
  return lines.join('\n');
}
export async function detectSandbox(limitsHelper: string, platform: NodeJS.Platform = process.platform): Promise<SandboxDetection> {
  const unavailable = (reason: string, hint: string): SandboxDetection => ({ backend: 'none', strength: 'none', available: false,
    reason, hint, tasks: { mechanism: 'none', reason: 'The sandbox is unavailable.' } });
  if (platform === 'win32') return { ...unavailable('No restricted-token/AppContainer launcher is installed; taskkill is not filesystem isolation.',
    'Install a validated restricted-token + Job Object backend.'), tasks: { mechanism: 'none',
    reason: 'No sandbox backend on Windows; a future one sets a Job Object process limit.' } };
  try { await access(limitsHelper, constants.X_OK); } catch { return unavailable('Resource-limit launcher is missing.', 'Build/install the plur1bus-sandbox-limits binary alongside plur1bus.'); }
  const program = platform === 'darwin' ? '/usr/bin/sandbox-exec' : platform === 'linux' ? '/usr/bin/bwrap' : '';
  try { if (!program) throw Error(); await access(program, constants.X_OK); }
  catch { return unavailable(platform === 'linux' ? 'bubblewrap is not installed at /usr/bin/bwrap.' : 'Seatbelt sandbox-exec is unavailable.', platform === 'linux' ? 'Install bubblewrap with the OS package manager and enable unprivileged user namespaces.' : 'This macOS installation cannot run sandbox-required tools.'); }
  const args = platform === 'darwin'
    ? ['-p', '(version 1)(deny default)(allow process-exec)(allow file-read*)(allow sysctl-read)', '/usr/bin/true']
    : [...BWRAP_PROBE, '--', '/usr/bin/true'];
  const usable = await new Promise<boolean>(resolve => execFile(program, args, { timeout: 3000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } }, error => resolve(!error)));
  if (!usable) return unavailable('OS sandbox probe failed; no agent process was launched.', platform === 'linux' ? 'Check bubblewrap user namespaces and the distribution AppArmor policy.' : 'Check sandbox-exec availability on this macOS release.');
  const tasks: SandboxTasks = platform === 'darwin' ? await new Promise(resolve => {
    execFile(program, [...args.slice(0, -1), '/usr/bin/perl', '-e', 'print defined(fork()) ? "forked" : "denied"'],
      { timeout: 3000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => {
        resolve(!error && stdout === 'denied'
          ? { mechanism: 'fork-denied', reason: 'Seatbelt denies forking: one process per run; threads are not counted.' }
          : { mechanism: 'none', reason: 'The Seatbelt fork probe did not confirm that forking is denied.' });
      });
  }) : await probeTasks(limitsHelper);
  return { backend: platform === 'darwin' ? 'seatbelt' : 'bubblewrap', strength: 'partial', available: true, tasks,
    reason: platform === 'darwin' ? 'Seatbelt; 100ms RSS watchdog on macOS; no hard memory isolation claim.'
      : 'bubblewrap namespace isolation; CPU and memory limits are per process; the task cap is per run (see tasks). Launch may fail if user namespaces are disabled.' };
}
/** Snapshot masks protect existing credential names. A Linux mount backend cannot mask names created later. */
async function masks(p: PreparedPolicy): Promise<{ path: string; directory: boolean }[]> {
  const out = new Map<string, boolean>(); let visited = 0;
  const names = new Set(p.denied.filter(d => 'name' in d).map(d => (d as { name: string }).name.toLowerCase()));
  const walk = async (dir: string): Promise<void> => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 20000) throw new SandboxFailure('credential mask scan exceeds safety cap');
      const target = join(dir, d.name);
      if (names.has(d.name.toLowerCase())) out.set(target, d.isDirectory());
      else if (d.isDirectory()) await walk(target);
    }
  };
  for (const r of [...p.readRoots, ...p.writeRoots]) await walk(r.path);
  for (const d of p.denied) if ('path' in d) {
    const s = await lstat(d.path).catch(() => null);
    if (s && [...p.readRoots, ...p.writeRoots].some(r => d.path.startsWith(r.path + '/'))) out.set(d.path, s.isDirectory());
  }
  return [...out].sort(([a], [b]) => a.length - b.length).filter(([path], _, all) => !all.some(([parent]) => parent !== path && path.startsWith(parent + '/'))).map(([path, directory]) => ({ path, directory }));
}
export async function backendArgv(p: PreparedPolicy, d: SandboxDetection, argv: readonly string[]): Promise<string[]> {
  if (d.backend === 'seatbelt') return ['/usr/bin/sandbox-exec', '-p', seatbeltProfile(p), ...argv];
  if (d.backend !== 'bubblewrap') throw new SandboxFailure(d.reason);
  // Writable mounts could create/rename credential files after the mask scan. Refuse until a dynamic Landlock/seccomp layer exists.
  if (p.writeRoots.length) throw new SandboxFailure('bubblewrap writable roots require dynamic credential-name enforcement; backend refused');
  const args = ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--proc', '/proc', '--dev', '/dev'];
  if (p.network === 'full') args.push('--share-net');
  for (const r of [...p.runtimePaths, ...p.readRoots.map(r => r.path)]) args.push('--ro-bind', r, r);
  for (const m of await masks(p)) args.push(...(m.directory ? ['--tmpfs', m.path] : ['--ro-bind', '/dev/null', m.path]));
  const step = d.tasks.mechanism === 'namespace-limit' && p.limits.maxTasks > 0 ? tasksStep(p.limitsHelper, p.limits.maxTasks) : undefined;
  args.push(...(step?.bind ?? []), '--remount-ro', '/', '--chdir', p.cwd, '--', ...(step?.prefix ?? []), ...argv);
  return args;
}
