import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relevant } from './license-changes.mjs';

test('a pull request runs the licence legs when it touches an input of the report', () => {
  // One path per entry of the pull_request paths filter this selection replaced, plus the selection itself.
  for (const file of ['package.json', 'packages/core/package.json', 'pnpm-lock.yaml', 'Cargo.toml', 'crates/plur1bus/Cargo.toml',
    'Cargo.lock', 'apps/desktop/Cargo.lock', 'clients/python/plur1bus-memory-client/pyproject.toml',
    'hosts/hermes/plur1bus/__init__.py', 'docs/dependency-policy.md', 'docs/dependency-exceptions.json', 'scripts/audit-deps.mjs',
    'scripts/test/audit-deps.test.mjs', 'scripts/ci/license-workflow.test.mjs', 'scripts/ci/license-changes.mjs',
    '.github/workflows/dependency-licenses.yml'])
    assert.equal(relevant({ event: 'pull_request', files: ['README.md', file] }), true, file);
});

test('a pull request that touches no input of the report skips the legs', () => {
  for (const file of ['README.md', 'docs/ci.md', 'docs/dependency/notes.md', 'packages/core/src/core.ts', 'package.json.bak',
    'crates/plur1bus/Cargo.toml.orig', 'scripts/audit-deps.mjs.orig', 'scripts/ci/changes.mjs', '.github/workflows/ci.yml',
    'hosts/hermes/tests/test_binding.py'])
    assert.equal(relevant({ event: 'pull_request', files: [file] }), false, file);
});

test('every other event, and a pull request without a diff, runs the legs', () => {
  for (const event of ['push', 'schedule', 'workflow_dispatch', 'merge_group']) assert.equal(relevant({ event, files: [] }), true, event);
  assert.equal(relevant({ event: 'pull_request', files: [] }), true);
  assert.throws(() => relevant({ event: 'pull_request', files: 'pnpm-lock.yaml' }), /array of paths/);
});

test('the script writes the selection as a step output', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./license-changes.mjs', import.meta.url))], {
    encoding: 'utf8', env: { PATH: process.env.PATH, EVENT_NAME: 'push' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'relevant=true\n');
});
