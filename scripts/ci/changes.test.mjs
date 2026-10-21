import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './changes.mjs';

const selected = files => Object.entries(classify({ event: 'pull_request', files, enginePinChanged: false }))
  .filter(([, value]) => value).map(([name]) => name).sort();
const full = ['documents', 'engine-pin', 'python', 'rust', 'ts-core', 'web', 'workflows'];
for (const [name, files, expected] of [
  ['documentation', ['docs/user/de/audit.md', 'README.md'], ['docs-only']],
  ['web only', ['packages/web/src/app.tsx'], ['web']],
  ['Rust only', ['crates/plur1bus/src/main.rs'], ['rust']],
  ['Cargo manifest', ['Cargo.toml'], ['rust']],
  ['Cargo lock', ['Cargo.lock'], full.filter(x => x !== 'engine-pin' && x !== 'workflows')],
  ['toolchain', ['rust-toolchain.toml'], ['rust']],
  ['core', ['packages/core/src/core.ts'], ['ts-core']],
  ['Python', ['hosts/hermes/tests/x.py', 'clients/python/client.py'], ['python']],
  ['document rendering', ['packages/documents/src/render.ts'], ['documents', 'ts-core']],
  ['RPC schema', ['packages/rpc-schema/schema/rpc.schema.json'], ['python', 'rust', 'ts-core', 'web']],
  ['config schema', ['packages/config-schema/src/index.ts'], ['python', 'rust', 'ts-core', 'web']],
  ['log schema', ['packages/log-schema/schema/catalogue.json'], ['python', 'rust', 'ts-core', 'web']],
  ['workflow', ['.github/workflows/ci.yml'], full.filter(x => x !== 'engine-pin')],
  ['Core shard timing profile', ['.github/ci/core-test-timings.json'], full.filter(x => x !== 'engine-pin' && x !== 'workflows')],
  ['JS lock', ['pnpm-lock.yaml'], full.filter(x => x !== 'engine-pin' && x !== 'workflows')],
  ['unknown', ['future/new-runtime.bin'], full.filter(x => x !== 'engine-pin' && x !== 'workflows')],
  ['mixed docs and Rust', ['docs/a.md', 'crates/x/src/lib.rs'], ['rust']],
  ['rename out of crates (both sides)', ['docs/moved.md', 'crates/x/src/lib.rs'], ['rust']],
]) test(`affected suites: ${name}`, () => assert.deepEqual(selected(files), [...expected].sort()));

test('an Engine pin change triggers every suite without claiming a workflow change', () => {
  const r = classify({ event: 'pull_request', files: ['packages/core/package.json'], enginePinChanged: true });
  assert.deepEqual(Object.entries(r).filter(([, v]) => v).map(([k]) => k).sort(), full.filter(k => k !== 'workflows'));
});

test('main, nightly, dispatch and merge_group always run all suites', () => {
  for (const event of ['push', 'schedule', 'workflow_dispatch', 'merge_group']) {
    const r = classify({ event, files: ['docs/a.md'], enginePinChanged: false });
    for (const key of ['rust', 'ts-core', 'web', 'python', 'documents']) assert.equal(r[key], true, `${event}:${key}`);
    assert.equal(r['docs-only'], false);
  }
});

test('empty or invalid changed-file input cannot produce a documentation-only pass', () => {
  assert.equal(classify({ event: 'pull_request', files: [], enginePinChanged: false }).rust, true);
  assert.throws(() => classify({ event: 'pull_request', files: null }), /files/);
});

test('the CLI uses the real merge-base diff and detects a private Engine pin change', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const cwd = mkdtempSync(join(tmpdir(), 'gp5-changes-'));
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  try {
    git('init', '--quiet');
    mkdirSync(join(cwd, 'packages/core'), { recursive: true });
    const manifest = pin => writeFileSync(join(cwd, 'packages/core/package.json'), JSON.stringify({ dependencies: { '@fixture/plur1bus-memory': pin } }));
    manifest('commit-a'); git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    manifest('commit-b'); git('add', '.'); git('commit', '-qm', 'pin');
    const head = git('rev-parse', 'HEAD');
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('./changes.mjs', import.meta.url))], { cwd,
      env: { PATH: process.env.PATH, EVENT_NAME: 'pull_request', BASE_SHA: base, HEAD_SHA: head, LABELS: '[]' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^engine-pin=true$/m);
    assert.match(r.stdout, /^web=true$/m);
    assert.match(r.stdout, /^rust=true$/m);
    assert.match(r.stdout, /^proceed=true$/m);
    assert.match(r.stdout, /^docs-only=false$/m);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('runtime Markdown and Markdown test fixtures retain their owning suites', () => {
  for (const file of ['packages/core/src/agent-templates/SOUL.md', 'packages/core/test/fixtures/web-fetch/goldens/markdown-source-file.md']) {
    assert.deepEqual(selected([file]), ['ts-core']);
    assert.deepEqual(selected(['docs/a.md', file]), ['ts-core']);
  }
  assert.deepEqual(selected(['crates/plur1bus-ext/tests/fixtures/skill-hash/SKILL.md']), ['rust', 'ts-core']);
  assert.deepEqual(selected(['skills/plur1bus/SKILL.md']), ['documents', 'python', 'rust', 'ts-core', 'web']);
});

// These are concrete TypeScript readers, not Rust-only implementation inputs.
test('shared Rust fixtures and Rust source parity inputs select both language suites', () => {
  for (const file of ['crates/plur1bus-ext/tests/fixtures/skill-hash/expected.json',
    'crates/plur1bus/tests/fixtures/fake-api.mjs', 'crates/future/fixtures/nested/vector.json',
    'crates/plur1bus/src/backup/restore.rs']) {
    assert.deepEqual(selected([file]), ['rust', 'ts-core'], file);
    assert.deepEqual(selected(['docs/a.md', file]), ['rust', 'ts-core'], file);
  }
});
