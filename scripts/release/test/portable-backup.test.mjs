// Portable account inclusion and encrypted rollback preserve distinct prior credentials without exposing payload values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
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

test('portable creation explicitly includes API accounts before encrypting the forward archive', async () => {
  const { runPortable } = await import('../portable-backup.mjs');
  const root = mkdtempSync(join(tmpdir(), 'portable-accounts-'));
  try {
    const file = join(root, 'forward-backup'), recovered = join(root, 'recovered-state');
    const source = { config: { label: 'source' },
      accounts: { personId: 'source-person', passwordHash: randomBytes(32).toString('hex') } };
    const vault = [{ name: 'provider/source', value: randomBytes(32).toString('hex') }];
    const creates = [];
    const units = state => ['config.json', ...(state.accounts ? ['state/api/accounts.db'] : [])];
    const execute = (_bin, _home, args) => {
      if (args[0] === 'secret' && args[1] === 'ls') return { secrets: vault.map(({ name }) => ({ name })) };
      if (args[0] === 'secret' && args[1] === 'get') return { value: vault.find(v => v.name === args[2]).value };
      if (args[0] === 'backup' && args[1] === 'create') {
        creates.push([...args]);
        const state = { config: source.config,
          ...(args.includes('--include-api-accounts') ? { accounts: source.accounts } : {}) };
        writeFileSync(args[3], JSON.stringify(state));
        return { units: units(state) };
      }
      if (args[0] === 'backup' && args[1] === 'verify')
        return { units: units(JSON.parse(readFileSync(args[2], 'utf8'))) };
      throw new Error('unexpected command');
    };
    const result = await runPortable({ operation: 'create', bin: 'fixture', home: root, file, password, execute });
    assert.deepEqual(result.plan, { units: ['config.json', 'state/api/accounts.db'], secrets: ['provider/source'] });
    assert.equal(creates.length, 1);
    assert.equal(creates[0].at(-1), '--include-api-accounts');
    assert.deepEqual(await decryptBackup(file, recovered, password), vault);
    assert.deepEqual(JSON.parse(readFileSync(recovered, 'utf8')), source);
    for (const value of [source.accounts.passwordHash, vault[0].value]) {
      assert.equal(readFileSync(file).includes(value), false);
      assert.equal(JSON.stringify(result).includes(value), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed Vault import restores distinct prior accounts, config and Vault through an inclusive rollback archive', async () => {
  const { runPortable } = await import('../portable-backup.mjs');
  const root = mkdtempSync(join(tmpdir(), 'portable-rollback-'));
  try {
    const state = join(root, 'incoming-state'), file = join(root, 'incoming-backup');
    const incoming = { config: { label: 'incoming-source' },
      accounts: { personId: 'incoming-person', passwordHash: randomBytes(32).toString('hex') } };
    const previous = { config: { label: 'prior-target' },
      accounts: { personId: 'prior-person', passwordHash: randomBytes(32).toString('hex') } };
    const incomingVault = randomBytes(32).toString('hex'), priorVault = randomBytes(32).toString('hex');
    writeFileSync(state, JSON.stringify(incoming));
    await encryptBackup(state, [{ name: 'new', value: incomingVault }], file, password);
    let current = structuredClone(previous), failOnce = true;
    const secrets = new Map([['old', priorVault]]), creates = [], restored = [];
    const units = archive => ['config.json', ...(archive.accounts ? ['state/api/accounts.db'] : [])];
    const execute = (_bin, _home, args, input) => {
      if (args[0] === 'daemon') return {};
      if (args[0] === 'backup' && args[1] === 'create') {
        creates.push([...args]);
        const archive = { config: current.config,
          ...(args.includes('--include-api-accounts') ? { accounts: current.accounts } : {}) };
        writeFileSync(args[3], JSON.stringify(archive));
        return { units: units(archive) };
      }
      if (args[0] === 'backup') {
        const archive = JSON.parse(readFileSync(args[args[1] === 'restore' ? 3 : 2], 'utf8'));
        if (args[1] === 'restore') {
          // Ordinary restore preserves a database omitted from the archive; a missing opt-in cannot repair incoming accounts.
          current = { config: archive.config, accounts: archive.accounts ?? current.accounts };
          restored.push(structuredClone(current));
        }
        return { units: units(archive) };
      }
      if (args[1] === 'ls') return { secrets: [...secrets.keys()].map(name => ({ name })) };
      if (args[1] === 'get') return { value: secrets.get(args[2]) };
      if (args[1] === 'rm') { secrets.delete(args[2]); return {}; }
      if (args[1] === 'set') {
        secrets.set(args[2], input.slice(0, -1));
        if (args[2] === 'new' && failOnce) { failOnce = false; throw new Error(incomingVault); }
        return {};
      }
      throw new Error('unexpected command');
    };
    await assert.rejects(runPortable({ operation: 'restore', bin: 'fixture', home: root, file, password, execute }),
      e => /was rolled back/.test(String(e)) && !String(e).includes(incomingVault));
    assert.deepEqual(restored, [incoming, previous], 'the incoming account really replaced the distinct prior account before rollback');
    assert.deepEqual(current, previous);
    assert.deepEqual([...secrets], [['old', priorVault]]);
    assert.equal(creates.length, 1);
    assert.equal(creates[0].at(-1), '--include-api-accounts');
    const recovery = readdirSync(root).find(name => name.startsWith('incoming-backup.rollback-'));
    assert.ok(recovery);
    const recovered = join(root, 'recovered-rollback');
    assert.deepEqual(await decryptBackup(join(root, recovery), recovered, password), [{ name: 'old', value: priorVault }]);
    assert.deepEqual(JSON.parse(readFileSync(recovered, 'utf8')), previous);
    for (const value of [previous.accounts.passwordHash, priorVault])
      assert.equal(readFileSync(join(root, recovery)).includes(value), false);
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
