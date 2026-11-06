import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { runChecked } from '../../src/host-tools/exec.ts';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { composeTools } from '../../src/composition/tools.ts';
import { createNodeHostContext } from '../../src/host-tools/context.ts';
import { memoryAuditSink } from '../../src/rbac/audit.ts';
import { createSecretRedaction } from '../../src/secrets/redaction.ts';
import { createSandboxHostExec } from '../../src/tools/sandbox/ports.ts';
import { limitsHelper } from '../external-agents/fixture.ts';
import { ToolDispatcher } from '../../src/tools/dispatcher.ts';
import { rig } from '../approvals/service-helpers.ts';

test('a composed host report masks a registered secret before cutting its output', { skip: process.platform === 'win32' }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'host-report-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const secret = randomBytes(48).toString('hex'), prefix = 'p'.repeat(40);
  // PATH contains only the fixture. No service manager or real service list is involved.
  await writeFile(join(home, 'systemctl'), "#!/bin/sh\nprintf '%s' '" + prefix + secret + "'\n", { mode: 0o700 });
  const approvals = await rig();
  t.after(() => { approvals.service.dispose(); approvals.stores.db.close(); });
  const signal = new AbortController().signal;
  const registry = await composeTools({ home, roots: [], sandbox: { required: false },
    host: createNodeHostContext({ platform: 'linux', maxOutputBytes: 64 }),
    grants: approvals.stores.grants, audit: memoryAuditSink() },
  { sessionId: 'test', agentId: 'agent', principal: 'owner', summaries: [], memory: '', messages: [], signal });
  const dispatcher = new ToolDispatcher({ registry, approvals: approvals.service, grants: approvals.stores.grants,
    clock: { now: Date.now }, secrets: () => [secret], policyContext: () => ({ overrides: { 'sys.read': 'allowed' } }) });
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = home;
    const result = await dispatcher.call({ id: 'report', name: 'sys.services', args: {} },
      { signal, agentId: 'agent', principal: 'owner', sessionId: 'test', surface: 1 });
    assert.equal(result.isError, false);
    const report = result.value as { output: string; truncated: boolean };
    assert.equal(report.truncated, true);
    assert.ok(report.output === prefix + '[REDACTED:secret]', 'the bounded service report must contain only the redacted prefix');
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test('host subprocess capture protects stdout and stderr at their own byte bounds', async () => {
  const secret = randomBytes(48).toString('hex'), prefix = 'p'.repeat(40);
  const redaction = createSecretRedaction();
  redaction.register(secret);
  const { exec } = createNodeHostContext();
  const output = await exec.run({ program: process.execPath,
    args: ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write(process.argv[1])', prefix + secret],
    maxOutputBytes: 64 }, undefined, () => redaction.snapshot());
  assert.equal(output.exitCode, 0);
  assert.equal(output.truncated, true);
  assert.ok([output.stdout, output.stderr].every(s => s === prefix + '[REDACTED:secret]'));
});

test('whole-output consumers reject redacted text that expands past their limit', async () => {
  const secret = randomBytes(4).toString('hex');
  const redaction = createSecretRedaction();
  redaction.register(secret);
  const ctx = createNodeHostContext({ knownSecrets: () => redaction.snapshot() });
  const req = { program: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', secret], maxOutputBytes: 8 };
  const result = await ctx.exec.run(req, undefined, ctx.knownSecrets);
  assert.equal(result.stdout, '[REDACTE');
  assert.equal(result.truncated, true);
  await assert.rejects(runChecked(ctx, req, { code: 'not_found', message: 'fixture unavailable' }, { whole: true }), { code: 'too_large' });
});

test('registry failures before spawn and after capture give a fixed path-free error', async t => {
  const home = await mkdtemp(join(tmpdir(), 'host-registry-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const marker = join(home, 'started');
  const redaction = createSecretRedaction();
  const req = { program: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], ""); process.stdout.write("fixture")', marker] };
  const fail = () => { throw new Error('synthetic registry failure'); };
  const expected = { code: 'permission_denied', message: 'could not protect host command output' };
  const { exec } = createNodeHostContext();
  await assert.rejects(exec.run(req, undefined, fail), expected);
  assert.equal(existsSync(marker), false);
  await assert.rejects(exec.run(req, undefined, () => existsSync(marker) ? fail() : redaction.snapshot()), expected);
  assert.equal(existsSync(marker), true);
});

if (process.platform === 'darwin') test('the sandboxed host adapter masks both streams before its limit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'host-sandbox-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home'), root = join(dir, 'workspace');
  await mkdir(home); await mkdir(root);
  const secret = randomBytes(48).toString('hex'), prefix = 'p'.repeat(40);
  const redaction = createSecretRedaction(); redaction.register(secret);
  const exec = createSandboxHostExec({ home, roots: [{ id: 'workspace', path: root }], deny: [],
    audit: memoryAuditSink(), principal: 'owner', sandbox: { required: true, limitsHelper } });
  const result = await exec.run({ program: '/bin/sh', args: ['-c', 'printf %s "$1"; printf %s "$1" >&2', 'fixture', prefix + secret],
    cwd: root, maxOutputBytes: 64 }, undefined, () => redaction.snapshot());
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.ok([result.stdout, result.stderr].every(s => s === prefix + '[REDACTED:secret]'));
});
