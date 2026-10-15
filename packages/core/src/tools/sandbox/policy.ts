import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { canonicalisePath, checkSyntax, matchDeny, type DenyEntry, type PathRoot } from '../../policy/paths.ts';
import { denyEntriesFor } from '../../host-tools/denylist.ts';
import { isHostPlatform } from '../../host-tools/types.ts';
import { SandboxFailure, type SandboxPolicy } from './types.ts';
export interface PreparedPolicy extends SandboxPolicy { denied: readonly DenyEntry[]; runtimeRoots: readonly string[] }
// Runtime support is read-only and never includes a user or writable package-manager prefix.
export const RUNTIME_ROOTS = process.platform === 'darwin'
  ? ['/usr', '/bin', '/sbin', '/System/Library', '/Library/Apple', '/dev/null', '/dev/urandom', '/dev/random']
  : ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/dev/null', '/dev/urandom', '/dev/random'];
async function absolute(p: string): Promise<string> {
  const syntax = checkSyntax(p);
  if (!syntax.ok || !isAbsolute(p)) throw new SandboxFailure('sandbox paths must be absolute without traversal');
  return realpath(p);
}
export async function preparePolicy(p: SandboxPolicy): Promise<PreparedPolicy> {
  if (!isHostPlatform(process.platform)) throw new SandboxFailure('unsupported sandbox platform');
  if (!['none', 'egress', 'full'].includes(p.network)) throw new SandboxFailure('invalid network policy');
  for (const n of Object.values(p.limits)) if (!Number.isSafeInteger(n) || n <= 0) throw new SandboxFailure('sandbox limits must be positive safe integers');
  if (p.limits.maxOutputBytes > 4 * 1024 * 1024 || p.limits.timeoutMs > 600000) throw new SandboxFailure('sandbox limits exceed hard caps');
  const home = await absolute(p.home), userHome = await absolute(p.userHome);
  const denied: DenyEntry[] = [...denyEntriesFor(userHome, process.env, process.platform), { path: join(home, 'run') }, { path: join(home, 'state') }, { path: join(home, 'secrets') }, ...(p.deny ?? [])];
  if (denied.some(d => 'name' in d && !/^[a-z0-9_.-]+$/i.test(d.name))) throw new SandboxFailure('credential deny names require ASCII path segments');
  // Resolve protected aliases too (notably /var -> /private/var on macOS).
  for (const d of [...denied]) if ('path' in d) { const r = await realpath(d.path).catch(() => null); if (r) denied.push({ path: r }); }
  const roots = async (list: readonly PathRoot[]): Promise<PathRoot[]> => Promise.all(list.map(async r => {
    const c = await canonicalisePath(r.path, { roots: [r], deny: denied, home: userHome, access: 'read' });
    if (!c.ok || !(await stat(c.canonical)).isDirectory()) throw new SandboxFailure('sandbox root refused or identity changed');
    // A writable runtime tree would let the target replace its sandbox launcher or shared libraries.
    if (RUNTIME_ROOTS.some(s => c.canonical === s || s.startsWith(c.canonical + '/'))) throw new SandboxFailure('sandbox root overlaps runtime support');
    return { ...r, path: c.canonical };
  }));
  const readRoots = await roots(p.readRoots), writeRoots = await roots(p.writeRoots);
  const cwd = await absolute(p.cwd);
  if (![...readRoots, ...writeRoots].some(r => cwd === r.path || cwd.startsWith(r.path + '/')) || matchDeny(cwd, denied)) throw new SandboxFailure('sandbox cwd is outside roots');
  const runtimeRoots = (await Promise.all(RUNTIME_ROOTS.map(s => realpath(s).catch(() => null)))).filter((s): s is string => s !== null);
  return { ...p, home, userHome, cwd, readRoots, writeRoots, denied, runtimeRoots: [...new Set(runtimeRoots)] };
}
