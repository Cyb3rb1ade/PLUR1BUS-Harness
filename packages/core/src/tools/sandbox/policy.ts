import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { canonicalisePath, checkSyntax, matchDeny, type DenyEntry, type PathRoot } from '../../policy/paths.ts';
import { denyEntriesFor } from '../../host-tools/denylist.ts';
import { isHostPlatform } from '../../host-tools/types.ts';
import { SandboxFailure, type SandboxPolicy } from './types.ts';
export interface PreparedPolicy extends SandboxPolicy { denied: readonly DenyEntry[]; runtimeRoots: readonly string[]; runtimePaths: readonly string[] }
// Runtime support is read-only and never includes a user or writable package-manager prefix.
export const RUNTIME_ROOTS = process.platform === 'darwin'
  ? ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/share', '/bin', '/sbin', '/System/Library', '/Library/Apple', '/dev/null', '/dev/urandom', '/dev/random']
  : ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/share', '/bin', '/sbin', '/lib', '/lib64', '/dev/null', '/dev/urandom', '/dev/random'];
async function absolute(p: string): Promise<string> {
  const syntax = checkSyntax(p);
  if (!syntax.ok || !isAbsolute(p)) throw new SandboxFailure('sandbox paths must be absolute without traversal');
  try { return await realpath(p); } catch { throw new SandboxFailure('sandbox path is unavailable'); }
}
export async function preparePolicy(p: SandboxPolicy): Promise<PreparedPolicy> {
  if (!isHostPlatform(process.platform)) throw new SandboxFailure('unsupported sandbox platform');
  if (!['none', 'egress', 'full'].includes(p.network)) throw new SandboxFailure('invalid network policy');
  for (const n of Object.values(p.limits)) if (!Number.isSafeInteger(n) || n <= 0) throw new SandboxFailure('sandbox limits must be positive safe integers');
  if (p.limits.maxOutputBytes > 4 * 1024 * 1024 || p.limits.timeoutMs > 600000) throw new SandboxFailure('sandbox limits exceed hard caps');
  const home = await absolute(p.home), userHome = await absolute(p.userHome);
  const denied: DenyEntry[] = [...denyEntriesFor(userHome, process.env, process.platform), { path: join(home, 'run') }, { path: join(home, 'state') }, { path: join(home, 'secrets') }, { path: join(home, 'config.json') }, { path: join(home, 'bin') }, { path: join(home, 'runtime') }, ...(p.deny ?? [])];
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
  const limitsHelper = await absolute(p.limitsHelper);
  if (writeRoots.some(r => limitsHelper.startsWith(r.path + '/'))) throw new SandboxFailure('sandbox launcher must be outside writable roots');
  // A pre-existing hard-link alias loses its protected source pathname at the kernel boundary.
  // Refuse the policy rather than letting a child rename an alias after a path mask was generated.
  let visited = 0;
  const scan = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 20000) throw new SandboxFailure('sandbox root alias scan exceeds safety cap');
      const target = join(dir, entry.name);
      if (matchDeny(target, denied)) continue;
      const info = await lstat(target);
      if (info.isFile() && info.nlink > 1) throw new SandboxFailure('sandbox root contains a hard-linked file; isolation cannot verify its source');
      if (info.isDirectory()) await scan(target);
    }
  };
  for (const r of [...readRoots, ...writeRoots]) await scan(r.path);
  const cwd = await absolute(p.cwd);
  if (![...readRoots, ...writeRoots].some(r => cwd === r.path || cwd.startsWith(r.path + '/')) || matchDeny(cwd, denied)) throw new SandboxFailure('sandbox cwd is outside roots');
  const runtime = (await Promise.all(RUNTIME_ROOTS.map(async source => { const canonical = await realpath(source).catch(() => null); return canonical ? { source, canonical } : null; }))).filter((s): s is {source:string;canonical:string} => s !== null);
  const runtimeRoots = runtime.map(r=>r.canonical), runtimePaths = runtime.map(r=>r.source);
  return { ...p, limitsHelper, home, userHome, cwd, readRoots, writeRoots, denied, runtimeRoots: [...new Set(runtimeRoots)], runtimePaths };
}
