import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const generator = fileURLToPath(new URL('../src/gen-defaults.mjs', import.meta.url));
test('generator is byte-stable and read-only check detects stale descriptions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'config-gen-'));
  const run = (...args: string[]) => execFileSync(process.execPath, [generator, '--out', dir, ...args]);
  try {
    run();
    const first = readdirSync(dir).sort().map(n => readFileSync(join(dir, n)));
    run();
    assert.deepEqual(readdirSync(dir).sort().map(n => readFileSync(join(dir, n))), first);
    run('--check');
    const tier = join(dir, 'tier-cases.json');
    writeFileSync(tier, readFileSync(tier, 'utf8').replace('Per-agent settings', 'Stale settings'));
    const stale = readFileSync(tier);
    const result = spawnSync(process.execPath, [generator, '--out', dir, '--check']);
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /tier-cases.json/);
    assert.deepEqual(readFileSync(tier), stale);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
