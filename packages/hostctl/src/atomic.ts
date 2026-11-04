import { constants } from 'node:fs';
import { rename, unlink, stat, link } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openVerified, type CanonicalPath } from '../../core/src/policy/paths-index.ts';
import { fail } from './errors.ts';
type Canon = (path: string, access: 'read' | 'write') => Promise<CanonicalPath>;
const sameIdentity = (a: CanonicalPath['identity'], b: CanonicalPath['identity']) => a.dev === b.dev && a.ino === b.ino && a.birth === b.birth;
const publicationCollisions = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** Atomic publication with a final abort/identity check after staging, immediately before rename/link. */
export async function atomicWrite(input: string, data: Buffer, overwrite: boolean, canon: Canon, signal: AbortSignal, limit: number, afterStage?: () => Promise<void>) {
  signal.throwIfAborted(); if (data.length > limit) fail('TOO_LARGE', 'Write less than output.maxBytes per operation.');
  const target = await canon(input, 'write');
  if (target.exists && !overwrite) fail('EXISTS', 'Choose a destination that does not exist.');
  let mode = 0o600;
  if (target.exists) { const s = await stat(target.canonical); if (!s.isFile()) fail('DENIED', 'The target must be a regular file.'); mode = s.mode & 0o777; }
  const parent = await canon(dirname(target.canonical), 'write');
  const changed = (current: CanonicalPath, directory: CanonicalPath) => current.canonical !== target.canonical || current.exists !== target.exists ||
    (target.exists && !sameIdentity(current.identity, target.identity)) || !sameIdentity(directory.identity, parent.identity);
  const temp = await canon(join(parent.canonical, `.hostctl-${randomUUID()}.tmp`), 'write');
  const handle = await openVerified(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  if ('ok' in handle) fail('CHANGED', 'The directory changed before the temporary file was opened.');
  const opened = await handle.stat({ bigint: true });
  const clean = async () => {
    try { const current = await canon(temp.canonical, 'read'); if (current.exists && current.canonical === temp.canonical && current.identity.dev === String(opened.dev) && current.identity.ino === String(opened.ino) && (opened.birthtimeNs <= 0n || current.identity.birth === String(opened.birthtimeNs))) await unlink(current.canonical); } catch { /* Do not unlink through a changed or escaped parent. */ }
  };
  let live = true;
  try {
    try { if (process.platform !== 'win32') await handle.chmod(mode); await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    await afterStage?.();
    signal.throwIfAborted();
    const again = await canon(input, 'write'); const directory = await canon(parent.canonical, 'write');
    if (changed(again, directory)) fail('CHANGED', 'The target changed while staging; read it again before retrying.');
    signal.throwIfAborted();
    if (overwrite) {
      try { await rename(temp.canonical, target.canonical); }
      catch (error) {
        // Windows can deny replacement during a competing publication after the final check.
        // Report only a proven identity change; preserve permission failures and never retry the write.
        if (publicationCollisions.has((error as NodeJS.ErrnoException)?.code ?? '')) {
          const fresh = await Promise.all([canon(input, 'write'), canon(parent.canonical, 'write')]).catch(() => null);
          if (fresh && changed(fresh[0], fresh[1])) fail('CHANGED', 'The target changed during publication; read it again before retrying.');
        }
        throw error;
      }
      live = false;
    }
    else { await link(temp.canonical, target.canonical); await clean(); live = false; }
    return { bytesWritten: data.length, created: !target.exists };
  } finally { if (live) await clean(); }
}
