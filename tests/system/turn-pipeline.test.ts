import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { BIN, cli, home, coreEnv, startDaemon, reapHome } from './helpers.ts';

for (const wire of ['chat_completions', 'anthropic_messages', 'codex_responses', 'gemini']) test(`${wire}: plur1bus chat --json → daemon → actual Core composition → file.read`, { timeout: 120000 }, async () => {
  const h = home();
  const env = coreEnv({ PLUR1BUS_CORE_JS: resolve('tests/system/fixtures/turn-core.mjs'), PLUR1BUS_TEST_TURN_WIRE: wire, PLUR1BUS_SECRETS_KEYRING: 'memory' });
  try {
    cli(h, ['agent', 'create', 'bernd']);
    writeFileSync(join(h, 'agents', 'bernd', 'workspace', 'fixture.txt'), 'synthetic file bytes');
    startDaemon(h, env);
    execFileSync(BIN, ['--home', h, '--json', 'secret', 'set', 'fixture.key'], { input: 'synthetic-fixture-value\n', env, timeout: 30000 });
    const turn = cli(h, ['chat', '--agent', 'bernd', 'read file fixture.txt'], { env });
    assert.deepEqual({ schema: turn.schema, state: turn.state, reply: turn.reply }, { schema: 'chat.turn/1', state: 'completed', reply: 'fixture done' });
    const sessionDb = new DatabaseSync(join(h, 'state', 'sessions.sqlite'), { readOnly: true });
    try { assert.ok(JSON.stringify(sessionDb.prepare("SELECT data FROM events WHERE type='tool.result'").all()).includes('synthetic file bytes')); } finally { sessionDb.close(); }
    const log = readFileSync(join(h, 'logs', 'core.log'), 'utf8'); assert.match(log, /tool-dispatch/); assert.match(log, /capture/); assert.ok(!log.includes('synthetic-fixture-value'));
    const audit = readFileSync(join(h, 'logs', 'audit.log'), 'utf8'); assert.match(audit, /policy.decision/);
    const db = new DatabaseSync(join(h, 'state', 'budget.sqlite'), { readOnly: true });
    try { const rows = db.prepare("SELECT COUNT(*) AS n FROM budget_call WHERE state='settled'").get() as { n: number }; assert.equal(rows.n, 2); } finally { db.close(); }
  } finally { cli(h, ['daemon', 'stop'], { env, allowFail: true }); await reapHome(h); rmSync(h, { recursive: true, force: true }); }
});
