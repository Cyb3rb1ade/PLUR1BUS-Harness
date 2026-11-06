import assert from 'node:assert/strict';
import { link, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { backendArgv } from '../../src/tools/sandbox/backends.ts';
import { preparePolicy } from '../../src/tools/sandbox/policy.ts';
import type { SandboxDetection, SandboxPolicy } from '../../src/tools/sandbox/types.ts';
import { WorktreeMount } from '../../src/tools/sandbox/worktree-mount.ts';
import { sandboxPolicy } from '../../src/tools/sandbox/ports.ts';
import { memoryAuditSink } from '../../src/rbac/audit.ts';
import { limitsHelper } from '../external-agents/fixture.ts';
import { nativeCardFixture } from './native-card-fixture.ts';

const namespace: SandboxDetection = { backend: 'bubblewrap', strength: 'partial', available: true,
  tasks: { mechanism: 'namespace-limit', reason: 'explicit backend decision unit input' }, reason: 'backend argv unit case' };

function policy(b: ReturnType<typeof nativeCardFixture>): SandboxPolicy {
  const roots = [{ id: 'card', path: b.tree.path }];
  return { home: b.home, userHome: b.dir, cwd: b.tree.path, readRoots: roots, writeRoots: roots,
    worktreeMount: WorktreeMount.fromStore(b.store, join(b.home, 'state'), b.project.id, b.card.id, 'worker', 'lead'),
    network: 'none', envAllow: ['PATH'], env: { PATH: '/usr/bin:/bin' }, limitsHelper,
    limits: { timeoutMs: 10000, cpuSeconds: 30, memoryBytes: 512 * 1024 ** 2, maxOutputBytes: 4096, maxTasks: 16 } };
}

async function protectedAlias(b: ReturnType<typeof nativeCardFixture>) {
  const dir = join(b.tree.path, '.SSH');
  await mkdir(dir);
  const file = join(dir, 'fixture');
  await writeFile(file, 'fixture');
  await link(file, join(b.tree.path, 'public-alias'));
}

test('native Linux cards reuse the existing ACP process budget while ordinary exec and macOS retain theirs', () => {
  const b = nativeCardFixture();
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    const grant = policy(b).worktreeMount!;
    const options = { home: b.home, roots: [{ id: 'card', path: b.tree.path }], deny: [],
      audit: memoryAuditSink(), principal: b.who.userId };
    const spec = { program: '/usr/bin/true', args: [], cwd: b.tree.path, env: {} };
    // Synchronous policy-unit inputs only; these platform selections provide no kernel acceptance evidence.
    for (const platform of ['linux', 'darwin', 'win32']) {
      Object.defineProperty(process, 'platform', { ...original, value: platform });
      assert.equal(sandboxPolicy(options, spec).limits.memoryBytes, 512 * 1024 ** 2);
      assert.equal(sandboxPolicy(options, spec, grant).limits.memoryBytes,
        platform === 'linux' ? 8 * 1024 ** 3 : 512 * 1024 ** 2);
    }
  } finally { Object.defineProperty(process, 'platform', original); b.close(); }
});

test('fully internal hardlinks still cannot expose credential-name masked data through another path', async () => {
  const b = nativeCardFixture();
  try { await protectedAlias(b); await assert.rejects(preparePolicy(policy(b)), /protected|alias/i); }
  finally { b.close(); }
});

test('the final backend recheck refuses a protected alias added after initial policy preparation', async () => {
  const b = nativeCardFixture();
  try {
    const prepared = await preparePolicy(policy(b));
    await protectedAlias(b);
    await assert.rejects(backendArgv(prepared, namespace, ['/usr/bin/true']), /protected|alias/i);
  } finally { b.close(); }
});

test('every native Linux backend decision requires a positive enforced namespace task cap', async () => {
  const b = nativeCardFixture();
  try {
    const p = policy(b), prepared = await preparePolicy(p);
    for (const mechanism of ['none', 'fork-denied'] as const) await assert.rejects(
      backendArgv(prepared, { ...namespace, tasks: { mechanism, reason: 'explicit unavailable unit input' } }, ['/usr/bin/true']), /positive namespace task limit/);
    const zero = await preparePolicy({ ...p, limits: { ...p.limits, maxTasks: 0 } });
    await assert.rejects(backendArgv(zero, namespace, ['/usr/bin/true']), /positive namespace task limit/);
    const args = await backendArgv(prepared, namespace, ['/usr/bin/true']);
    assert.ok(args.includes('--tasks-required'));
    assert.ok(args.includes(String(p.limits.maxTasks + 1)));
  } finally { b.close(); }
});

test('large native trees pass all policy and credential-mask stages, not just the grant validator', async () => {
  const b = nativeCardFixture();
  try {
    const directory = join(b.tree.path, 'large-contained-store');
    await mkdir(directory);
    for (let base = 0; base < 20100; base += 32) await Promise.all(Array.from(
      { length: Math.min(32, 20100 - base) }, (_, i) => writeFile(join(directory, `entry-${base + i}`), 'fixture')));
    const prepared = await preparePolicy(policy(b));
    const args = await backendArgv(prepared, namespace, ['/usr/bin/true']);
    const at = args.indexOf('--bind');
    assert.equal(args[at + 1], b.tree.path);
    assert.equal(args[at + 2], b.tree.path);
  } finally { b.close(); }
});
