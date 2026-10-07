import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCallBudget } from '../../src/budget/calls.ts';
import { PriceBook } from '../../src/budget/prices.ts';
import { open, PRICES_V1 } from './helpers.ts';

it('simultaneous processes reserve under a write lock with no oversubscription', { timeout: 60000 }, async () => {
  const f = open();
  const gate = createCallBudget({ path: f.path, clock: f.clock, prices: new PriceBook([PRICES_V1]) });
  try {
    gate.setLimit({ scope: 'user', id: 'u1', period: 'day', metric: 'tokens', hard: 100 });
    const worker = fileURLToPath(new URL('./reservation-worker.ts', import.meta.url));
    const results = await Promise.all(Array.from({ length: 6 }, () => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--conditions=source', '--no-warnings=ExperimentalWarning', worker, f.path], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', error = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('reservation worker timeout')); }, 30000);
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { error += chunk; });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(Number(output)) : reject(new Error(error)); });
    })));
    assert.equal(results.reduce((a, b) => a + b, 0), 2);
  } finally { gate.close(); f.svc.close(); }
});

it('future call schema is refused before changing it', () => {
  const f = open(); f.svc.close();
  const db = new DatabaseSync(f.path);
  db.prepare("INSERT INTO settings VALUES ('budget_call_schema','999')").run(); db.close();
  assert.throws(() => createCallBudget({ path: f.path, clock: f.clock, prices: new PriceBook([PRICES_V1]) }), /newer|unsupported/);
});
