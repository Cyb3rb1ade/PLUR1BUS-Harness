import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { CodingGate, detectVerifiers } from '../../src/collab/coding-gate.ts';
import { sandboxVerifier } from '../../src/collab/verifier.ts';
import { useTempDirs } from '../composition/helpers.ts';
const tmp = useTempDirs('m5-gate-');
function fixture() {
  const root = tmp.make();
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'check.cjs'), "const fs=require('node:fs');if(process.argv[2]==='test' && fs.existsSync('.red'))process.exit(1);\n");
  writeFileSync(join(root, '.plur1bus-verifiers.json'), JSON.stringify({ commands: Object.fromEntries(['format','lint','typecheck','test'].map(k => [k,['node','check.cjs',k]])) }));
  writeFileSync(join(root, 'code.ts'), '// base\n'); git('add', '.'); git('commit', '-m', 'fixture');
  return { root, git };
}
test('D98 detects Node/pnpm, Python, Rust, Go and Java/Gradle; project conventions win', () => {
  const manifests = [{ 'package.json': JSON.stringify({ packageManager: 'pnpm@10', scripts: { 'format:check':'fmt','lint':'lint','typecheck':'tsc','test':'test' } }) }, { 'pyproject.toml':'[project]' }, { 'Cargo.toml':'[package]' }, { 'go.mod':'module example' }, { 'build.gradle.kts':'plugins {}' }];
  assert.deepEqual(manifests.map(m => detectVerifiers(m).toolchain), ['node','python','rust','go','java']);
  for (const m of manifests) assert.deepEqual(detectVerifiers(m).commands.map(c => c.kind), ['format','lint','typecheck','test']);
  assert.equal(detectVerifiers(manifests[0]!).commands[0]!.argv[0], 'pnpm');
  assert.equal(detectVerifiers({ ...manifests[0], '.plur1bus-verifiers.json': JSON.stringify({ commands: Object.fromEntries(['format','lint','typecheck','test'].map(k => [k,['node','verify.cjs',k]])) }) }).toolchain, 'project');
});
test('lying delegate reports green, but external sandboxed red tests refuse; human override requires note and is audited', async t => {
  const f = fixture(), audit: object[] = [];
  const gate = new CodingGate({ path: ':memory:', audit: e => { audit.push(e); } }); t.after(() => gate.close());
  writeFileSync(join(f.root, '.red'), 'Delegate claims: done, all tests green.');
  const result = await gate.verify({ task: 'p/card', root: f.root, signal: new AbortController().signal });
  assert.equal(result.ok, false); assert.equal(result.reason, 'verifiers-failed'); assert.equal(result.checks.find(c => c.kind === 'test')!.exitCode, 1);
  await assert.rejects(gate.verify({ task: 'p/card', root: f.root, signal: new AbortController().signal, override: { person: 'owner', note: '' } }));
  const override = await gate.verify({ task: 'p/card', root: f.root, signal: new AbortController().signal, override: { person: 'owner', note: 'Accept fixture failure for demonstration' } });
  assert.equal(override.ok, true); assert.ok(audit.some(e => (e as { kind: string }).kind === 'coding.override'));
});
test('200 changed lines require independent exact-tree reviewer; later edits invalidate pass; documentation gaps listed', async t => {
  const f = fixture(), gate = new CodingGate({ path: ':memory:', audit() {} }); t.after(() => gate.close());
  writeFileSync(join(f.root, 'code.ts'), '// base\n' + '// change\n'.repeat(200));
  const first = await gate.verify({ task: 'p/card', root: f.root, signal: new AbortController().signal });
  assert.equal(first.ok, false); assert.equal(first.reason, 'review-required'); assert.ok(first.docGaps.length);
  assert.throws(() => gate.recordReview('p/card', gate.snapshot(f.root), 'a', 'a'));
  gate.recordReview('p/card', gate.snapshot(f.root), 'reviewer', 'a');
  assert.equal((await gate.verify({ task: 'p/card', root: f.root, signal: new AbortController().signal })).ok, true);
  writeFileSync(join(f.root, 'code.ts'), readFileSync(join(f.root, 'code.ts'), 'utf8') + '// later\n');
  assert.equal((await gate.verify({ task: 'p/card', root: f.root, signal: new AbortController().signal })).reason, 'review-required');
});
test('delegate cannot replace the committed verifier commands with a no-op', async t => {
  const f = fixture(), gate = new CodingGate({ path: ':memory:', audit() {} }); t.after(() => gate.close());
  writeFileSync(join(f.root, '.plur1bus-verifiers.json'), JSON.stringify({ commands: Object.fromEntries(['format','lint','typecheck','test'].map(k => [k,['true']])) }));
  assert.equal((await gate.verify({ task: 'p/card', root: f.root, signal: new AbortController().signal })).reason, 'verifier-conventions-changed');
});
test('real verifier sandbox blocks network and kills a timed-out process', async t => {
  const f = fixture(); let connections = 0;
  const server = createServer(s => { connections++; s.end(); }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address() as { port: number };
  writeFileSync(join(f.root, 'network.cjs'), `const net=require('node:net');const s=net.connect(${address.port},'127.0.0.1');s.on('connect',()=>process.exit(7));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(8),1000);`);
  const result = await sandboxVerifier(3000).run(f.root, { kind: 'test', argv: ['node','network.cjs'] }, { signal: new AbortController().signal, networkAllowed: false });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(connections, 0);
  writeFileSync(join(f.root, 'hang.cjs'), 'setInterval(()=>{},1000)');
  const timeout = await sandboxVerifier(20).run(f.root, { kind: 'test', argv: ['node','hang.cjs'] }, { signal: new AbortController().signal, networkAllowed: false });
  assert.equal(timeout.ok, false); assert.equal(timeout.reason, 'timeout');
});
test('task.complete cannot be bypassed by a green report; only an authenticated human lead can use the audited override RPC', async t => {
  const { createCollab } = await import('../../src/collab/service.ts');
  const { codingCompletionTool, codingMethods } = await import('../../src/collab/coding-surface.ts');
  const { ToolRegistry } = await import('../../src/tools/registry.ts');
  const { ToolDispatcher } = await import('../../src/tools/dispatcher.ts');
  const { guardMethods } = await import('../../src/rbac/guard.ts');
  const f = fixture(); writeFileSync(join(f.root, '.red'), 'red tests');
  const events: object[] = [], gate = new CodingGate({ path: ':memory:', audit: e => { events.push(e); } });
  const collab = createCollab({ path: ':memory:' }); t.after(() => { gate.close(); collab.close(); });
  const owner = { kind: 'person' as const, userId: 'owner', role: 'owner' as const };
  const p = collab.createProject(owner, { name: 'Gate' }); collab.addAgent(owner, p.id, 'worker');
  const card = collab.boardStore.createCard(p.id, { title: 'Coding', description: 'Delegate claims: all green.', columnId: collab.boardStore.columns(p.id)[0]!.id }, { kind: 'person', id: owner.userId });
  collab.boardStore.assign(p.id, card.id, { kind: 'agent', id: 'worker' }, true, { kind: 'person', id: owner.userId });
  const o = { gate, collab, worktrees: { root: () => f.root } };
  const registry = new ToolRegistry(); registry.register(codingCompletionTool(o, { projectId: p.id } as never, () => owner));
  const dispatcher = new ToolDispatcher({ registry, approvals: { async request() { throw Error('unexpected ask'); } }, grants: { get: () => undefined, list: () => [] }, clock: { now: Date.now }, policyContext: () => ({ overrides: { 'shell.exec': 'allowed' } }) });
  const ctx = { agentId: 'worker', principal: owner.userId, surface: 1 as const, signal: new AbortController().signal };
  const result = await dispatcher.call({ id: 'complete', name: 'task.complete', args: { projectId: p.id, cardId: card.id } }, ctx);
  assert.equal(result.isError, true); assert.equal(collab.boardStore.getCard(p.id, card.id).columnId, card.columnId);
  const bypass = await dispatcher.call({ id: 'bypass', name: 'task.complete', args: { projectId: p.id, cardId: card.id, overrideNote: 'agent override' } }, ctx);
  assert.equal(bypass.isError, true);
  const methods = guardMethods(codingMethods(o), { resolve: () => owner, audit: { append() {} }, now: Date.now });
  await methods['task.complete']!({ projectId: p.id, cardId: card.id, overrideNote: 'Owner accepts this fixture failure' }, { requestId: 'override', connectionId: 'owner', signal: ctx.signal });
  assert.equal(collab.boardStore.getCard(p.id, card.id).columnId, collab.boardStore.columns(p.id).find(c => c.titleKey === 'project.board.done')!.id);
  assert.ok(events.some(e => (e as { kind: string }).kind === 'coding.override'));
});
test('sandbox cannot read another private store outside its bound worktree', async () => {
  const f = fixture(), other = tmp.make(); writeFileSync(join(other, 'private.sqlite'), 'private-store-isolation-marker');
  writeFileSync(join(f.root, 'private.cjs'), `try{require('node:fs').readFileSync(${JSON.stringify(join(other,'private.sqlite'))});process.exit(9)}catch{process.exit(0)}`);
  const result = await sandboxVerifier().run(f.root, { kind: 'test', argv: ['node','private.cjs'] }, { signal: new AbortController().signal, networkAllowed: false });
  assert.equal(result.ok, true, JSON.stringify(result));
});
test('repository external-diff and textconv configuration cannot execute a host command during fingerprinting', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'probe.cjs'), "require('node:fs').writeFileSync('host-hook-ran','unexpected')");
  writeFileSync(join(f.root, '.gitattributes'), 'code.ts diff=hostprobe\n');
  f.git('config','diff.hostprobe.textconv', `${process.execPath} ${join(f.root,'probe.cjs')}`);
  f.git('config','diff.external', `${process.execPath} ${join(f.root,'probe.cjs')}`);
  writeFileSync(join(f.root, 'code.ts'), '// changed\n');
  const gate = new CodingGate({ path: ':memory:', audit() {} });
  try { gate.snapshot(f.root); assert.throws(() => readFileSync(join(f.root,'host-hook-ran'))); } finally { gate.close(); }
});
