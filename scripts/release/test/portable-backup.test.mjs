import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptBackup, decryptBackup, readPassword } from '../portable-backup.mjs';

const password = Buffer.from('a strong test-only passphrase');
const marker = 'test-secret-must-never-be-plaintext';
test('portable archive authenticates state and vault, uses fresh nonces, and refuses overwrite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portable-test-'));
  try {
    const state = join(root, 'state'); writeFileSync(state, Buffer.alloc(300000, 42));
    const vault = [{ name: 'provider/test', value: marker + '\n' }];
    const a = join(root, 'a'), b = join(root, 'b'), restored = join(root, 'restored');
    await encryptBackup(state, vault, a, password); await encryptBackup(state, vault, b, password);
    assert.equal(readFileSync(a).includes(marker), false);
    assert.notDeepEqual(readFileSync(a), readFileSync(b));
    assert.deepEqual(await decryptBackup(a, restored, password), vault);
    assert.deepEqual(readFileSync(restored), readFileSync(state));
    await assert.rejects(encryptBackup(state, vault, a, password));
    assert.deepEqual(await decryptBackup(a, join(root, 'again'), password), vault);
    if (process.platform !== 'win32') assert.equal(statSync(a).mode & 0o077, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('wrong passwords, truncated/header/body/tag tampering fail and discard scratch plaintext', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portable-test-'));
  try {
    const state = join(root, 'state'); writeFileSync(state, 'archive bytes');
    const a = join(root, 'a'); await encryptBackup(state, [{ name: 'test', value: marker }], a, password);
    const good = readFileSync(a);
    const variants = [good.subarray(0, 30), good.subarray(0, good.length - 1)];
    for (const i of [0, 12, 45, 60, good.length - 1]) { const bad = Buffer.from(good); bad[i] ^= 1; variants.push(bad); }
    for (const [i, bytes] of variants.entries()) {
      const bad = join(root, `bad${i}`), restored = join(root, `restored${i}`); writeFileSync(bad, bytes);
      await assert.rejects(decryptBackup(bad, restored, password), e => !String(e).includes(marker));
      assert.equal(existsSync(restored), false);
    }
    const out = join(root, 'wrong'); await assert.rejects(decryptBackup(a, out, Buffer.from('wrong password')));
    assert.equal(existsSync(out), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('passphrase files must be regular/private and at least 16 bytes; invalid vaults never publish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portable-test-'));
  try {
    const p = join(root, 'password'); writeFileSync(p, password, { mode: 0o600 }); assert.deepEqual(readPassword(p), password);
    writeFileSync(p, 'short'); assert.throws(() => readPassword(p));
    assert.throws(() => readPassword(root));
    const state = join(root, 'state'); writeFileSync(state, 'state');
    for (const v of [[{ name: 'bad name', value: marker }], [{ name: 'a', value: marker }, { name: 'a', value: marker }]]) {
      await assert.rejects(encryptBackup(state, v, join(root, 'out'), password));
      assert.equal(existsSync(join(root, 'out')), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed vault import rolls the state and old vault back and keeps an encrypted recovery artifact', async () => {
  const { runPortable } = await import('../portable-backup.mjs');
  const root = mkdtempSync(join(tmpdir(), 'portable-rollback-'));
  try {
    const state = join(root, 'new-state'), file = join(root, 'new-backup');
    writeFileSync(state, 'new'); await encryptBackup(state, [{ name: 'new', value: marker }], file, password);
    let current = 'old', failOnce = true; const secrets = new Map([['old', 'old-secret-value']]);
    const execute = (_bin, _home, a, input) => {
      if (a[0] === 'daemon') return {};
      if (a[0] === 'backup') {
        if (a[1] === 'create') writeFileSync(a[3], current);
        if (a[1] === 'restore') current = readFileSync(a[3], 'utf8');
        return { units: ['config.json'] };
      }
      if (a[1] === 'ls') return { secrets: [...secrets.keys()].map(name => ({ name })) };
      if (a[1] === 'get') return { value: secrets.get(a[2]) };
      if (a[1] === 'rm') { secrets.delete(a[2]); return {}; }
      if (a[1] === 'set') {
        if (a[2] === 'new' && failOnce) { secrets.set(a[2], input.slice(0, -1)); failOnce = false; throw new Error(marker); }
        secrets.set(a[2], input.slice(0, -1)); return {};
      }
      throw new Error('unexpected command');
    };
    await assert.rejects(runPortable({ operation: 'restore', bin: 'fixture', home: root, file, password, execute }), e => /was rolled back/.test(String(e)) && !String(e).includes(marker));
    assert.equal(current, 'old'); assert.deepEqual([...secrets], [['old', 'old-secret-value']]);
    const { readdirSync } = await import('node:fs');
    const recovery = readdirSync(root).find(n => n.startsWith('new-backup.rollback-'));
    assert.ok(recovery); assert.equal(readFileSync(join(root, recovery)).includes('old-secret-value'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('standalone CLI runs under a spaced path and native temp-directory aliases', async () => {
  const { copyFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'portable space '));
  try {
    const script = join(root, 'portable backup.mjs');
    copyFileSync(fileURLToPath(new URL('../portable-backup.mjs', import.meta.url)), script);
    const r = spawnSync(process.execPath, [script, 'invalid-operation'], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /portable-backup-failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
