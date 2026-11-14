// Real portable recovery replaces distinct destination API credentials while retaining the encrypted rollback artifact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BIN, cli, coreEnv, ENGINE_IMPL, home, startDaemon, stopDaemon, reapHome } from './helpers.ts';
import { AccountStore } from '../../packages/api/src/account-store.ts';
import { LearnStore } from '../../packages/core/src/dreams/learn/store.ts';
import { DreamStore } from '../../packages/core/src/dreams/store.ts';

test('portable backup restores stores, vault, config, identities, API accounts, sessions and dream ledger', { timeout: 180000 }, async () => {
  const source = home(), target = home(), scratch = mkdtempSync(join(tmpdir(), 'p1b-portable-e2e-'));
  const password = join(scratch, 'passphrase'), file = join(scratch, 'complete.p1backup');
  const env = coreEnv({ PLUR1BUS_SECRETS_KEYRING: 'off', PLUR1BUS_TEST_CHAT_PROVIDER: 'fake' });
  writeFileSync(password, randomBytes(32).toString('hex'), { mode: 0o600 });
  const call = (h: string, args: string[], input?: string) => JSON.parse(execFileSync(BIN, ['--json', '--home', h, ...args], { encoding: 'utf8', env, ...(input === undefined ? {} : { input }) }));
  const portable = (operation: string, extra: string[] = []) => JSON.parse(execFileSync(process.execPath, [resolve('scripts/release/portable-backup.mjs'), operation, '--bin', BIN, '--home', operation === 'create' ? source : target, '--file', file, '--passphrase-file', password, ...extra], { encoding: 'utf8', env, timeout: 120000 }));
  const secret = randomBytes(32).toString('hex'), priorSecret = randomBytes(32).toString('hex');
  const accountHash = randomBytes(32).toString('hex'), priorAccountHash = randomBytes(32).toString('hex');
  try {
    for (const h of [source, target]) {
      cli(h, ['agent', 'create', 'bernd']);
      cli(h, ['config', 'set', 'secrets.fileFallback.enabled', 'true', '--yes']);
      startDaemon(h, env);
    }
    call(source, ['secret', 'set', 'provider/test'], secret);
    call(target, ['secret', 'set', 'target/old'], priorSecret);
    const turn = call(source, ['chat', '--agent', 'bernd', 'hello backup']);
    call(source, ['memory', 'add', '--agent', 'bernd', 'Please remember that the release backup meeting is at noon.']);
    stopDaemon(source);
    stopDaemon(target);
    const db = (path: string, action: (db: DatabaseSync) => void) => { const d = new DatabaseSync(path); try { action(d); } finally { d.close(); } };
    db(join(source, 'state', 'identity.sqlite'), d => d.prepare('INSERT INTO humans VALUES (?,?,?,?)').run('backup-user', 'Backup Person', 1, 'local-owner'));
    db(join(source, 'state', 'admin.sqlite'), d => d.prepare("INSERT INTO admin_roles(user_id,role) VALUES (?, 'member')").run('backup-user'));
    const accounts = new AccountStore({ path: join(source, 'state', 'api', 'accounts.db'), resolve: async () => null });
    try { await accounts.createPending('backup-user', 'backup-user', accountHash); await accounts.activate('backup-user'); } finally { accounts.close(); }
    const priorAccounts = new AccountStore({ path: join(target, 'state', 'api', 'accounts.db'), resolve: async () => null });
    try { await priorAccounts.createPending('prior-user', 'prior-user', priorAccountHash); await priorAccounts.activate('prior-user'); } finally { priorAccounts.close(); }
    const dreamsPath = join(source, 'state', 'dreams', 'dreams.db');
    mkdirSync(join(source, 'state', 'dreams'), { recursive: true });
    const dreams = new DreamStore(dreamsPath); dreams.close();
    db(dreamsPath, d => d.exec("INSERT INTO dream_run(run_id,agent_id,phase,job_id,idempotency_key,trigger,started_at,outcome) VALUES ('backup-dream','bernd','light','backup-job','backup-once','manual',1,'completed')"));
    const learn = new LearnStore(join(source, 'state', 'dreams', 'learn.db'));
    const learned = learn.begin({ scope: 'agent', owner: 'local-owner', agentId: 'bernd' }, { from: 0, to: 1 }, 1);
    learn.finish(learned, 'skipped', 'disabled', 2); learn.close();
    startDaemon(source, env);
    startDaemon(target, env);
    const created = portable('create');
    for (const unit of ['state/lancedb', 'config.json', 'state/identity.sqlite', 'state/admin.sqlite', 'state/api/accounts.db', 'state/sessions.sqlite', 'state/dreams/dreams.db', 'state/dreams/learn.db']) assert.ok(created.plan.units.includes(unit), unit);
    const expectedSecrets = ENGINE_IMPL === 'rust'
      ? ['approvals.chain-key.v1', 'approvals.signing-key.v1', 'provider/test']
      : ['provider/test'];
    assert.deepEqual(created.plan.secrets, expectedSecrets);
    assert.equal(JSON.stringify(created).includes(secret), false);
    assert.equal(readFileSync(file).includes(secret), false);
    const dry = portable('restore', ['--dry-run']);
    assert.equal(call(target, ['secret', 'get', 'target/old', '--reveal']).value, priorSecret);
    db(join(target, 'state', 'api', 'accounts.db'), d =>
      assert.equal(d.prepare('SELECT password_hash FROM accounts WHERE person_id=?').get('prior-user')?.password_hash, priorAccountHash));
    const restored = portable('restore');
    assert.deepEqual(restored.plan, dry.plan);
    assert.equal(JSON.stringify(dry).includes(secret), false);
    assert.equal(JSON.stringify(restored).includes(secret), false);
    assert.equal(call(target, ['secret', 'get', 'provider/test', '--reveal']).value, secret);
    assert.deepEqual(call(target, ['secret', 'ls']).secrets.map((s: any) => s.name), expectedSecrets);
    assert.equal(call(target, ['session', 'show', turn.sessionId]).session.turnCount, 1);
    assert.ok(call(target, ['memory', 'list', '--agent', 'bernd']).items.length > 0);
    stopDaemon(target);
    for (const [path, sql, expected] of [
      ['identity.sqlite', 'SELECT display_name AS value FROM humans WHERE id=\'backup-user\'', 'Backup Person'],
      ['admin.sqlite', 'SELECT role AS value FROM admin_roles WHERE user_id=\'backup-user\'', 'member'],
      ['api/accounts.db', 'SELECT password_hash AS value FROM accounts WHERE person_id=\'backup-user\'', accountHash],
      ['dreams/learn.db', "SELECT json_extract(metadata,'$.outcome') AS value FROM learn_run", 'skipped'],
      ['dreams/dreams.db', 'SELECT outcome AS value FROM dream_run WHERE run_id=\'backup-dream\'', 'completed'],
    ]) db(join(target, 'state', path!), d => assert.equal(d.prepare(sql!).get()!.value, expected));
    db(join(target, 'state', 'api', 'accounts.db'), d =>
      assert.equal(d.prepare('SELECT COUNT(*) AS count FROM accounts WHERE person_id=?').get('prior-user')?.count, 0));
    assert.equal(readFileSync(restored.rollback).includes(priorAccountHash), false);
    stopDaemon(source);
    for (const h of [source, target]) {
      for (const entry of readdirSync(join(h, 'logs'), { withFileTypes: true })) {
        if (entry.isFile()) for (const value of [secret, priorSecret, accountHash, priorAccountHash])
          assert.equal(readFileSync(join(h, 'logs', entry.name)).includes(value), false, 'credential value must not enter logs');
      }
    }
  } finally {
    for (const h of [source, target]) { try { stopDaemon(h); } catch { /* cleanup */ } await reapHome(h); rmSync(h, { recursive: true, force: true }); }
    rmSync(scratch, { recursive: true, force: true });
  }
});
