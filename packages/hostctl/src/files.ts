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
const SEARCH_BATCH_FILES = 32, SEARCH_BATCH_CHARS = 8 << 20;
export function files(roots: readonly PathRoot[], extraDeny: readonly DenyEntry[], config: HostctlConfig, trash: (path: string, signal: AbortSignal) => Promise<void>, home = homedir(), env: NodeJS.ProcessEnv = process.env, afterStage?: () => Promise<void>) {
  const cwd = roots[0]?.path;
  const deny = [...denyEntriesFor(home, env, isHostPlatform(process.platform) ? process.platform : 'linux'), { name: '.env' }, { name: 'api-owner.token' }, { name: 'core.token' }, { name: 'supervisor.token' }, ...extraDeny];
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
    // Every configured root, not only the one this path resolved under: roots may be nested, and a folder that contains a root takes the root with it.
    const fold = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
    for (const r of roots) {
      const rootPath = fold(await canon(r.path, 'read').then(x => x.canonical, () => path.resolve(r.path)));
      const target = fold(c.canonical);
      if (rootPath === target || rootPath.startsWith(target.endsWith(path.sep) ? target : target + path.sep)) fail('DENIED', 'A configured root itself, or a folder that contains one, cannot be moved or trashed.');
    }
    const lexical = path.resolve(cwd!, input);
    if (await lstat(lexical).then(s => s.isSymbolicLink(), () => false)) fail('DENIED', 'Namespace operations do not follow symbolic links.');
    const parent = await canon(path.dirname(c.canonical), 'write');
    if (process.platform !== 'win32') { const handle = await openVerified(parent, constants.O_RDONLY); if ('ok' in handle) fail('CHANGED', 'Directory identity changed.'); await handle.close(); }
    if (await realpath(path.dirname(c.canonical)) !== parent.canonical) fail('CHANGED', 'Parent changed; review before retrying.');
    return c;
  };
  // The listing is produced lazily, so a caller that stops early (a search whose results are full) pays only for the entries it consumed:
  // every entry costs one canonicalisation, which resolves the deny-list and the roots again.
  const scan = (input: string, depth: number, limit: number, signal: AbortSignal) => {
    const state = { truncated: false, count: 0, scanned: 0 };
    async function* visit(dir: string, prefix: string, remaining: number): AsyncGenerator<{ path: string; type: string }> {
      signal.throwIfAborted(); if (++state.scanned > 1000) { state.truncated = true; return; }
      await canon(dir, 'read');
      const result = await fs.list({ path: dir, maxEntries: 1000 }, { signal }); state.truncated ||= result.truncated;
      for (const item of result.entries) {
        if (state.count >= limit) { state.truncated = true; return; }
        const full = path.join(dir, item.name); const relative = prefix + item.name;
        try { await canon(full, 'read'); } catch { continue; }
        state.count++; yield { path: relative, type: item.type };
        if (remaining > 0 && item.type === 'directory') yield* visit(full, relative + '/', remaining - 1);
      }
    }
    return { state, entries: visit(input, '', depth) };
  };
  const walk = async (input: string, depth: number, limit: number, signal: AbortSignal) => {
    const listing = scan(input, depth, limit, signal); const entries: { path: string; type: string }[] = [];
    for await (const entry of listing.entries) entries.push(entry);
    return { entries, truncated: listing.state.truncated };
  };
  return { canon, async run(op: string, a: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted(); const input = string(a, 'path') === '.' ? cwd! : string(a, 'path'); await canon(input, /^(read|list|search|stat)$/.test(op) ? 'read' : 'write');
    switch (op) {
      case 'read': return fs.read({ path: input, encoding: 'utf8', offset: integer(a.offset, 0, Number.MAX_SAFE_INTEGER), ...(a.length !== undefined ? { length: integer(a.length, 0, config.output.maxBytes) } : {}) }, { signal });
      case 'stat': return fs.stat({ path: input }, { signal });
      case 'write': return atomicWrite(input, Buffer.from(string(a, 'content')), true, canon, signal, config.output.maxBytes, afterStage);
      case 'append': case 'edit': {
        const old = await fs.read({ path: input, encoding: 'utf8' }, { signal }); let content: string;
        // Decoding drops a byte order mark; an edit or an append must not change bytes it was not asked to.
        const bom = Buffer.from((await fs.read({ path: input, encoding: 'base64', offset: 0, length: 3 }, { signal })).content, 'base64').equals(Buffer.from([0xef, 0xbb, 0xbf])) ? '\uFEFF' : '';
        if (op === 'append') content = old.content + string(a, 'content');
        else { const needle = string(a, 'oldText'); if (!needle || old.content.indexOf(needle) < 0 || old.content.indexOf(needle) !== old.content.lastIndexOf(needle)) fail('NOT_UNIQUE', 'oldText must occur exactly once; read the file and use more context.'); content = old.content.replace(needle, () => string(a, 'newText')); }
        return atomicWrite(input, Buffer.from(bom + content), true, canon, signal, config.output.maxBytes, afterStage);
      }
      case 'list': return walk(input, integer(a.depth, 0, 16), integer(a.limit, config.search.maxResults, 1000), signal);
      case 'search': {
        const matcher = await textMatcher();
        const query = string(a, 'query'); if (!query) fail('INVALID_ARGUMENT', 'Use a nonempty literal query.');
        const listing = scan(input, integer(a.depth, 8, 16), 1000, signal); const matches: { path: string }[] = []; let truncated = false, full = false;
        const limit = integer(a.limit, config.search.maxResults, config.search.maxResults);
        const take = (hit: string) => { if (matches.length >= limit) { truncated = true; full = true; } else matches.push({ path: hit }); };
        // Content mode reads each file through the verified path, then asks the matcher about a batch at a time: one ripgrep start per batch, not per file.
        let batch: { path: string; text: string }[] = [], batchBytes = 0;
        const flush = async () => {
          const pending = batch; batch = []; batchBytes = 0; if (pending.length === 0) return;
          let hits: boolean[];
          try { hits = await matcher.matchMany(pending.map(p => p.text), query, signal); } catch { signal.throwIfAborted(); hits = pending.map(p => p.text.includes(query)); }
          for (let i = 0; i < pending.length && !full; i++) if (hits[i]) take(pending[i]!.path);
        };
        for await (const item of listing.entries) {
          signal.throwIfAborted();
          if (a.mode !== 'content') { if (item.path.includes(query)) take(item.path); }
          else if (item.type === 'file') {
            let text: string;
            try { text = (await fs.read({ path: path.join(input, item.path), encoding: 'utf8' }, { signal })).content; } catch { continue; }
            batch.push({ path: item.path, text }); batchBytes += text.length;
            if (batch.length >= SEARCH_BATCH_FILES || batchBytes >= SEARCH_BATCH_CHARS) await flush();
          }
          if (full) break;
        }
        if (!full) await flush();
        if (!full) truncated = listing.state.truncated;
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
