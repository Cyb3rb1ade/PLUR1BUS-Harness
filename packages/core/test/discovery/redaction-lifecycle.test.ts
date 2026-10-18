import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('core shutdown removes secret subscriptions before closing its log sinks', () => {
  const run = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--experimental-strip-types', '--conditions=source', fileURLToPath(new URL('./fixtures/redaction-lifecycle.ts', import.meta.url))], {
    env: { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: '1', PLUR1BUS_SECRETS_KEYRING: 'memory' }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
});
