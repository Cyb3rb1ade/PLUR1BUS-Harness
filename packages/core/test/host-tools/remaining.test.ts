import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHostTool } from '../../src/host-tools/index.ts';
import { makeCtx } from './helpers.ts';
for (const platform of ['darwin', 'linux', 'win32'] as const) test(`${platform}: remaining D106 names exist and memory is typed`, async () => {
  for (const name of ['sys.memory', 'sys.startupItems', 'sys.services', 'sys.updates', 'apps.focus', 'apps.quit', 'pkg.upgrade']) assert.ok(getHostTool(name), name);
  const { ctx } = makeCtx(platform);
  const r = await getHostTool('sys.memory')!.run({}, ctx) as { totalBytes: number; freeBytes: number };
  assert.equal(r.totalBytes, ctx.os.totalmem()); assert.equal(r.freeBytes, ctx.os.freemem());
  assert.equal(getHostTool('apps.open')!.capability, 'apps.launch');
  assert.equal(getHostTool('apps.open')!.riskClass, 'medium');
});
test('application automation accepts identifiers, never injected script source', async () => {
  const { ctx, exec } = makeCtx('darwin');
  await assert.rejects(getHostTool('apps.focus')!.run({ appId: 'x" & do shell script "id' }, ctx));
  await assert.rejects(getHostTool('apps.quit')!.run({ appId: 'com.apple.Finder', force: true }, ctx));
  assert.equal(exec.calls.length, 0);
});
for (const platform of ['darwin', 'linux', 'win32'] as const) test(`${platform}: app action passes validated target as fixed command arguments`, async () => {
  const { ctx, exec } = makeCtx(platform);
  exec.scripts.unshift({ match: () => true, stdout: '', exitCode: 0 });
  await getHostTool('apps.focus')!.run({ appId: 'demo.App' }, ctx);
  assert.equal(exec.calls.length, 1); assert.ok(exec.calls[0]!.args.some(a => a.includes('demo.App')));
  assert.equal(getHostTool('apps.focus')!.capability, 'apps.launch');
  assert.equal(getHostTool('apps.quit')!.capability, 'proc.signal');
});
test('upgrade is an explicit bounded dry-run plan and rejects option injection', async () => {
  const { ctx, exec } = makeCtx('darwin');
  const r = await getHostTool('pkg.upgrade')!.run({ name: 'ripgrep', manager: 'brew' }, ctx) as { plan: { args: string[]; executed: boolean } };
  assert.deepEqual(r.plan.args, ['upgrade', 'ripgrep']); assert.equal(r.plan.executed, false);
  assert.equal(exec.calls.length, 0);
  await assert.rejects(getHostTool('pkg.upgrade')!.run({ name: '--force', manager: 'brew' }, ctx));
});
test('shell layer refuses password and cached elevation tools even without T3', async () => {
  const { validateProgram } = await import('../../src/tools/exec/args.ts');
  for (const p of ['sudo', 'sudo.exe', 'runas', 'gsudo', 'expect', 'sshpass', '/usr/bin/pkexec']) assert.throws(() => validateProgram(p));
});
