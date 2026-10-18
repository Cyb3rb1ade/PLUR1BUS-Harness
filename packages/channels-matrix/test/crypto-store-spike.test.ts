import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecurePath } from '../../module-api/src/secure-path.ts';

test('persistence spike: built-in SQLite preserves a previously committed opaque key record across SIGKILL mid-transaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm4-sqlite-spike-'));
  const path = join(dir, 'probe.sqlite'); const script = join(dir, 'writer.mjs');
  await writeFile(path, '', { mode: 0o600 });
  assert.equal(createSecurePath()(path, { mode: 0o600 }).applied, true);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE records(id TEXT PRIMARY KEY, value BLOB)');
  db.prepare('INSERT INTO records VALUES (?,?)').run('committed', new Uint8Array([3, 4, 5])); db.close();
  await writeFile(script, `import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync(process.argv[2]); db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
db.prepare('UPDATE records SET value=? WHERE id=?').run(new Uint8Array([8,9]),'committed');
db.prepare('INSERT INTO records VALUES (?,?)').run('uncommitted',new Uint8Array([7]));
process.send('inside-transaction'); setInterval(()=>{},1000);`);
  const child = fork(script, [path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10_000) });
    assert.equal(message, 'inside-transaction');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const reopened = new DatabaseSync(path);
    try {
      const row = reopened.prepare('SELECT value FROM records WHERE id=?').get('committed')!;
      assert.deepEqual([...row.value as Uint8Array], [3, 4, 5]);
      assert.equal(reopened.prepare('SELECT * FROM records WHERE id=?').get('uncommitted'), undefined);
    } finally { reopened.close(); }
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});

test.todo('KNOWN-GAP: no complete IndexedDB-over-SQLite backend exists in the approved dependency set; actual WASM identity/session ratchets cannot be checkpointed to SQLite');
test.todo('KNOWN-GAP: five-target persistent crypto restart, cross-signing bootstrap and owner-approved recovery backup are not accepted');
