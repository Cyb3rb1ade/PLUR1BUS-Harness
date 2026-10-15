import { execFile } from 'node:child_process';
import { access, lstat, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import type { PreparedPolicy } from './policy.ts';
import { SandboxFailure, type SandboxDetection } from './types.ts';
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
  const unavailable = (reason: string, hint: string): SandboxDetection => ({ backend: 'none', strength: 'none', available: false, reason, hint });
  if (platform === 'win32') return unavailable('No restricted-token/AppContainer launcher is installed; taskkill is not filesystem isolation.', 'Install a validated restricted-token + Job Object backend.');
  try { await access(limitsHelper, constants.X_OK); } catch { return unavailable('Resource-limit launcher is missing.', 'Build/install the plur1bus-sandbox-limits binary alongside plur1bus.'); }
  const program = platform === 'darwin' ? '/usr/bin/sandbox-exec' : platform === 'linux' ? '/usr/bin/bwrap' : '';
  try { if (!program) throw Error(); await access(program, constants.X_OK); }
  catch { return unavailable(platform === 'linux' ? 'bubblewrap is not installed at /usr/bin/bwrap.' : 'Seatbelt sandbox-exec is unavailable.', platform === 'linux' ? 'Install bubblewrap with the OS package manager and enable unprivileged user namespaces.' : 'This macOS installation cannot run sandbox-required tools.'); }
  const args = platform === 'darwin'
    ? ['-p', '(version 1)(deny default)(allow process-exec)(allow file-read*)(allow sysctl-read)', '/usr/bin/true']
    : ['--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '--', '/usr/bin/true'];
  const usable = await new Promise<boolean>(resolve => execFile(program, args, { timeout: 3000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } }, error => resolve(!error)));
  if (!usable) return unavailable('OS sandbox probe failed; no agent process was launched.', platform === 'linux' ? 'Check bubblewrap user namespaces and the distribution AppArmor policy.' : 'Check sandbox-exec availability on this macOS release.');
  return { backend: platform === 'darwin' ? 'seatbelt' : 'bubblewrap', strength: 'partial', available: true, reason: platform === 'darwin' ? 'Seatbelt; forking denied. 100ms RSS watchdog on macOS; no hard memory isolation claim.' : 'bubblewrap namespace isolation; limits are per process, not aggregate cgroup limits. Launch may fail if user namespaces are disabled.' };
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
  const args = ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
  if (p.network === 'full') args.push('--share-net');
  for (const r of [...p.runtimeRoots, ...p.readRoots.map(r => r.path)]) args.push('--ro-bind', r, r);
  for (const m of await masks(p)) args.push(...(m.directory ? ['--tmpfs', m.path] : ['--ro-bind', '/dev/null', m.path]));
  args.push('--chdir', p.cwd, '--', ...argv);
  return args;
}
