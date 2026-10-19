import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIN } from './helpers.ts';

test('--help and subcommand help ignore invalid configuration and an unusable home', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1b-help-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{invalid');
    for (const args of [['--help'], ['memory', '--help']]) {
      const out = execFileSync(BIN, ['--home', dir, ...args], { encoding: 'utf8', timeout: 10_000 });
      assert.match(out, /Usage:/);
    }
    assert.deepEqual(readdirSync(dir).sort(), ['config.json']);
    // A regular file cannot be used as a home. Any attempted home initialisation would fail.
    assert.match(execFileSync(BIN, ['--home', join(dir, 'config.json'), '--help'], { encoding: 'utf8', timeout: 10_000 }), /Usage:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
