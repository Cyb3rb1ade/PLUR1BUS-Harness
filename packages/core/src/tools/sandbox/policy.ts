import { validateAcpMount } from "./acp-worktree.ts";
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalisePath, checkSyntax, matchDeny, type DenyEntry, type PathRoot } from '../../policy/paths.ts';
import { denyEntriesFor } from '../../host-tools/denylist.ts';
import { isHostPlatform } from '../../host-tools/types.ts';
import { SandboxFailure, type SandboxPolicy } from './types.ts';
export interface PreparedPolicy extends SandboxPolicy { denied: readonly DenyEntry[]; runtimeRoots: readonly string[]; runtimePaths: readonly string[] }
// Runtime support is read-only and never includes a user or writable package-manager prefix.
export const RUNTIME_ROOTS = process.platform === 'darwin'
  ? ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/share', '/bin', '/sbin', '/System/Library', '/Library/Apple', '/dev/null', '/dev/urandom', '/dev/random']
  : ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/share', '/bin', '/sbin', '/lib', '/lib64', '/dev/null', '/dev/urandom', '/dev/random'];
/**
 * Lexical gate for a trusted-composition path, before it touches the file system. It refuses what no later step can
 * repair (relative or drive-relative spellings, `..` with either separator, NUL, Win32 device namespaces) and maps the two
 * Win32 long-path spellings `\\?\X:\` and `\\?\UNC\` onto their plain form. It deliberately does NOT apply the D109 name
 * rules: `os.tmpdir()`/`%TEMP%` and profile paths on Windows routinely carry 8.3 aliases (`C:\Users\RUNNER~1\...`), which only
 * the volume can expand. The name rules run on the real path instead (see `absolute`), where every alias is resolved.
 */
export function lexicalSpelling(p: string, platform: NodeJS.Platform = process.platform): string {
  const fail = (): never => { throw new SandboxFailure('sandbox paths must be absolute without traversal'); };
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) fail();
  if (platform !== 'win32') { if (!p.startsWith('/') || p.split('/').includes('..')) fail(); return p; }
  let s = p.replaceAll('/', '\\');
  if (/^\\\\\?\\UNC\\/i.test(s)) s = '\\\\' + s.slice(8);
  else if (/^\\\\\?\\[A-Za-z]:\\/.test(s)) s = s.slice(4);
  // \\.\, \\?\GLOBALROOT, \\?\Volume{..}, \??\: device and object-manager namespaces, never a sandbox path.
  if (/^\\\\[?.](\\|$)/.test(s) || s.startsWith('\\??\\')) fail();
  if (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(s) || s.split('\\').includes('..')) fail();
  return s;
}
/** Real path as the policy compares it: Win32 long-path prefix stripped and the drive letter upper-cased (as in policy/paths.ts). */
function nativeForm(real: string): string {
  if (process.platform !== 'win32') return real;
  let r = real;
  if (r.startsWith('\\\\?\\UNC\\')) r = '\\\\' + r.slice(8);
  else if (r.startsWith('\\\\?\\')) r = r.slice(4);
  return /^[a-z]:/.test(r) ? r[0]!.toUpperCase() + r.slice(1) : r;
}
/**
 * Segment-aligned containment. `folded` compares case-insensitively on Windows (NTFS and ReFS directories are case-insensitive
 * by default, so `C:\WS\bin` and `c:\ws\BIN` are one directory); use it on the refusal side, where matching more is safe.
 */
export function within(child: string, parent: string, folded: boolean, platform: NodeJS.Platform = process.platform): boolean {
  const sep = platform === 'win32' ? '\\' : '/';
  const f = (x: string) => (folded && platform === 'win32' ? x.toLowerCase() : x);
  const c = f(child), q = f(parent);
  return c === q || c.startsWith(q.endsWith(sep) ? q : q + sep);
}
async function absolute(p: string, denied: readonly DenyEntry[] = []): Promise<string> {
  const spelled = lexicalSpelling(p);
  // The spelling itself may be the giveaway (a link called `.ssh`), so the deny-list sees it before resolution.
  if (matchDeny(spelled, denied)) throw new SandboxFailure('sandbox path is deny-listed');
  let real: string;
  try { real = nativeForm(await realpath(spelled)); } catch { throw new SandboxFailure('sandbox path is unavailable'); }
  // D109 name rules on the resolved form: no 8.3 alias, stream, device name, trailing dot/space or UNC survives here.
  if (!checkSyntax(real).ok) throw new SandboxFailure('sandbox path has no canonical form the path policy accepts');
  return real;
}
export async function preparePolicy(p: SandboxPolicy): Promise<PreparedPolicy> {
  if (!isHostPlatform(process.platform)) throw new SandboxFailure('unsupported sandbox platform');
  if (!['none', 'egress', 'full'].includes(p.network)) throw new SandboxFailure('invalid network policy');
  if (!Number.isSafeInteger(p.limits.maxTasks) || p.limits.maxTasks < 0 || p.limits.maxTasks > 65536)
    throw new SandboxFailure('sandbox task cap must be 0 to 65536');
  for (const [key, n] of Object.entries(p.limits)) if (key !== 'maxTasks' && (!Number.isSafeInteger(n) || n <= 0))
    throw new SandboxFailure('sandbox limits must be positive safe integers');
  if (p.limits.maxOutputBytes > 4 * 1024 * 1024 || p.limits.timeoutMs > 600000) throw new SandboxFailure('sandbox limits exceed hard caps');
  const mount = p.acpWorktree ? await validateAcpMount(p.acpWorktree, p.writeRoots.map(r => r.path)) : undefined;
  const home = await absolute(p.home), userHome = await absolute(p.userHome);
  const denied: DenyEntry[] = [...denyEntriesFor(userHome, process.env, process.platform), { path: join(home, 'run') }, ...(mount ? [] : [{ path: join(home, 'state') }]), { path: join(home, 'secrets') }, { path: join(home, 'config.json') }, { path: join(home, 'bin') }, { path: join(home, 'runtime') }, ...(p.deny ?? [])];
  if (denied.some(d => 'name' in d && !/^[a-z0-9_.-]+$/i.test(d.name))) throw new SandboxFailure('credential deny names require ASCII path segments');
  // Resolve protected aliases too (notably /var -> /private/var on macOS).
  for (const d of [...denied]) if ('path' in d) { const r = await realpath(d.path).then(nativeForm, () => null); if (r) denied.push({ path: r }); }
  const roots = async (list: readonly PathRoot[]): Promise<PathRoot[]> => Promise.all(list.map(async r => {
    // canonicalisePath applies the D109 name rules to its input; hand it the alias-free real spelling (identity is still checked).
    const spelled = await absolute(r.path, denied);
    const c = await canonicalisePath(spelled, { roots: [{ ...r, path: spelled }], deny: denied, home: userHome, access: 'read' });
    if (!c.ok || !(await stat(c.canonical)).isDirectory()) throw new SandboxFailure('sandbox root refused or identity changed');
    // A writable runtime tree would let the target replace its sandbox launcher or shared libraries.
    if (RUNTIME_ROOTS.some(s => within(s, c.canonical, true))) throw new SandboxFailure('sandbox root overlaps runtime support');
    return { ...r, path: c.canonical };
  }));
  const readRoots = await roots(p.readRoots), writeRoots = await roots(p.writeRoots);
  const limitsHelper = await absolute(p.limitsHelper);
  if (writeRoots.some(r => within(limitsHelper, r.path, true))) throw new SandboxFailure('sandbox launcher must be outside writable roots');
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
  const cwd = await absolute(p.cwd, denied).catch(() => { throw new SandboxFailure('sandbox cwd is outside roots'); });
  if (![...readRoots, ...writeRoots].some(r => within(cwd, r.path, false)) || matchDeny(cwd, denied)) throw new SandboxFailure('sandbox cwd is outside roots');
  const runtime = (await Promise.all(RUNTIME_ROOTS.map(async source => { const canonical = await realpath(source).catch(() => null); return canonical ? { source, canonical } : null; }))).filter((s): s is {source:string;canonical:string} => s !== null);
  const runtimeRoots = runtime.map(r=>r.canonical), runtimePaths = runtime.map(r=>r.source);
  if (mount) {
    // Only trusted Git metadata is readable; sibling worktrees and the rest of state are never mounted.
    runtimeRoots.push(mount.gitDir, mount.commonGitDir);
    runtimePaths.push(mount.gitDir, mount.commonGitDir);
  }
  return { ...p, limitsHelper, home, userHome, cwd, readRoots, writeRoots, denied, runtimeRoots: [...new Set(runtimeRoots)], runtimePaths };
}
