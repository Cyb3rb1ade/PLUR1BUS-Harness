import { atomicWrite } from './atomic.ts';
import { textMatcher } from './search.ts';
import { constants } from 'node:fs';
import { mkdir, rename, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { canonicalisePath, openVerified, type PathRoot, type DenyEntry, type CanonicalPath } from '../../core/src/policy/paths-index.ts';
import { createFsOps } from '../../core/src/tools/fs/ops.ts';
import { denyEntriesFor, isHostPlatform } from '../../core/src/host-tools/index.ts';
import { fail, string, integer } from './errors.ts';
import type { HostctlConfig } from './config.ts';
export function files(roots: readonly PathRoot[], extraDeny: readonly DenyEntry[], config: HostctlConfig, trash: (path: string, signal: AbortSignal) => Promise<void>, home = homedir(), env: NodeJS.ProcessEnv = process.env, afterStage?: () => Promise<void>) {
  const cwd = roots[0]?.path;
  const deny = [...denyEntriesFor(home, env, isHostPlatform(process.platform) ? process.platform : 'linux'), { name: '.env' }, ...extraDeny];
  const fs = createFsOps({ roots, deny, home, limits: { maxReadBytes: config.output.maxBytes, maxWriteBytes: config.output.maxBytes } });
  const canon = async (input: string, access: 'read' | 'write'): Promise<CanonicalPath> => {
    if (input.split(/[\\/]/).some(p => /^\.env(?:\.|$)/i.test(p))) fail('DENIED', 'Environment credential files cannot be accessed.');
    if (input.split(/[\\/]/).includes('..') || /^\\\\|^\/\//.test(input)) fail('OUTSIDE_ROOT', 'Use a path inside a configured local root.');
    const c = await canonicalisePath(input, { roots, deny, home, access, ...(cwd ? { cwd } : {}) });
    if (!c.ok) fail(c.reason === 'deny-listed' ? 'DENIED' : 'OUTSIDE_ROOT', 'Use a non-sensitive path inside a configured root.');
    if (c.canonical.split(/[\\/]/).some(p => /^\.env(?:\.|$)/i.test(p))) fail('DENIED', 'Environment credential files cannot be accessed.');
    return c;
  };
  // Extra namespace operations are limited to non-root entries. Revalidate the parent immediately before mutation.
  const entry = async (input: string) => {
    const c = await canon(input, 'write');
    if (c.canonical === (await canon(roots.find(r => r.id === c.rootId)!.path, 'read')).canonical) fail('DENIED', 'A configured root itself cannot be moved or trashed.');
    const lexical = path.resolve(cwd!, input);
    if (await lstat(lexical).then(s => s.isSymbolicLink(), () => false)) fail('DENIED', 'Namespace operations do not follow symbolic links.');
    const parent = await canon(path.dirname(c.canonical), 'write');
    if (process.platform !== 'win32') { const handle = await openVerified(parent, constants.O_RDONLY); if ('ok' in handle) fail('CHANGED', 'Directory identity changed.'); await handle.close(); }
    if (await realpath(path.dirname(c.canonical)) !== parent.canonical) fail('CHANGED', 'Parent changed; review before retrying.');
    return c;
  };
  const walk = async (input: string, depth: number, limit: number, signal: AbortSignal) => {
    const entries: { path: string; type: string }[] = []; let truncated = false; let scanned = 0;
    const visit = async (dir: string, prefix: string, remaining: number) => {
      signal.throwIfAborted(); if (++scanned > 1000) { truncated = true; return; }
      await canon(dir, 'read');
      const result = await fs.list({ path: dir, maxEntries: 1000 }, { signal }); truncated ||= result.truncated;
      for (const item of result.entries) {
        if (entries.length >= limit) { truncated = true; return; }
        const full = path.join(dir, item.name); const relative = prefix + item.name;
        try { await canon(full, 'read'); } catch { continue; }
        entries.push({ path: relative, type: item.type });
        if (remaining > 0 && item.type === 'directory') await visit(full, relative + '/', remaining - 1);
      }
    };
    await visit(input, '', depth); return { entries, truncated };
  };
  return { canon, async run(op: string, a: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted(); const input = string(a, 'path') === '.' ? cwd! : string(a, 'path'); await canon(input, /^(read|list|search|stat)$/.test(op) ? 'read' : 'write');
    switch (op) {
      case 'read': return fs.read({ path: input, encoding: 'utf8', offset: integer(a.offset, 0, Number.MAX_SAFE_INTEGER), ...(a.length !== undefined ? { length: integer(a.length, 0, config.output.maxBytes) } : {}) }, { signal });
      case 'stat': return fs.stat({ path: input }, { signal });
      case 'write': return atomicWrite(input, Buffer.from(string(a, 'content')), true, canon, signal, config.output.maxBytes, afterStage);
      case 'append': case 'edit': {
        const old = await fs.read({ path: input, encoding: 'utf8' }, { signal }); let content: string;
        if (op === 'append') content = old.content + string(a, 'content');
        else { const needle = string(a, 'oldText'); if (!needle || old.content.indexOf(needle) < 0 || old.content.indexOf(needle) !== old.content.lastIndexOf(needle)) fail('NOT_UNIQUE', 'oldText must occur exactly once; read the file and use more context.'); content = old.content.replace(needle, () => string(a, 'newText')); }
        return atomicWrite(input, Buffer.from(content), true, canon, signal, config.output.maxBytes, afterStage);
      }
      case 'list': return walk(input, integer(a.depth, 0, 16), integer(a.limit, config.search.maxResults, 1000), signal);
      case 'search': {
        const matcher = await textMatcher();
        const query = string(a, 'query'); if (!query) fail('INVALID_ARGUMENT', 'Use a nonempty literal query.');
        const listing = await walk(input, integer(a.depth, 8, 16), 1000, signal); const matches: { path: string }[] = []; let truncated = listing.truncated;
        const limit = integer(a.limit, config.search.maxResults, config.search.maxResults);
        for (const item of listing.entries) {
          signal.throwIfAborted(); let match = a.mode !== 'content' && item.path.includes(query);
          if (a.mode === 'content' && item.type === 'file') {
            try { match = await matcher.matches((await fs.read({ path: path.join(input, item.path), encoding: 'utf8' }, { signal })).content, query, signal); } catch { continue; }
          }
          if (match) { if (matches.length >= limit) { truncated = true; break; } matches.push({ path: item.path }); }
        }
        return { matches, truncated, backend: matcher.backend };
      }
      case 'mkdir': { const c = await entry(input); signal.throwIfAborted(); await mkdir(c.canonical, { mode: 0o700 }); await canon(c.canonical, 'read'); return { created: true }; }
      case 'copy': case 'move': {
        const src = await entry(input), dest = await entry(string(a, 'destination'));
        if (dest.exists) fail('EXISTS', 'Choose a destination that does not exist.');
        const s = await lstat(src.canonical); if (!s.isFile() || s.isSymbolicLink()) fail('DENIED', 'Only regular files can be copied or moved.');
        if (op === 'copy') {
          const data = await fs.read({ path: src.canonical, encoding: 'base64' }, { signal });
          return atomicWrite(dest.canonical, Buffer.from(data.content, 'base64'), false, canon, signal, config.output.maxBytes, afterStage);
        }
        const handle = await openVerified(src, constants.O_RDONLY);
        if ('ok' in handle) fail('CHANGED', 'The source changed before opening.');
        await handle.close();
        const again = await entry(input), to = await entry(string(a, 'destination'));
        if (again.identity.dev !== src.identity.dev || again.identity.ino !== src.identity.ino || again.identity.birth !== src.identity.birth || to.exists) fail('CHANGED', 'Source or destination changed; review before retrying.');
        signal.throwIfAborted(); await rename(src.canonical, dest.canonical); return { moved: true };
      }
      case 'trash': { const c = await entry(input); signal.throwIfAborted(); await trash(c.canonical, signal); return { trashed: true }; }
      default: return fail('INVALID_ARGUMENT', 'Unknown file operation.');
    }
  } };
}
