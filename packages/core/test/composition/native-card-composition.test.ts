import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, copyFile, link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { composeTools } from '../../src/composition/tools.ts';
import { memoryAuditSink } from '../../src/rbac/audit.ts';
import type { ChatRequest } from '../../src/session/provider.ts';
import { ToolDispatcher } from '../../src/tools/dispatcher.ts';
import type { ToolRegistry } from '../../src/tools/registry.ts';
import type { ExecResult } from '../../src/tools/exec/types.ts';
import { WorktreeMount } from '../../src/tools/sandbox/worktree-mount.ts';
import { rig } from '../approvals/service-helpers.ts';
import { limitsHelper } from '../external-agents/fixture.ts';
import { nativeCardFixture } from './native-card-fixture.ts';

async function composed() {
  const b = nativeCardFixture(), approvals = await rig();
  const signal = new AbortController().signal;
  const grant = WorktreeMount.fromStore(b.store, join(b.home, 'state'), b.project.id, b.card.id, 'worker', 'lead');
  const program = process.platform === 'win32' ? process.execPath : '/usr/bin/touch';
  const request: ChatRequest = { sessionId: 'native-card-session', agentId: 'worker', principal: b.who.userId,
    authenticatedPerson: b.who.userId, projectId: b.project.id, codingWorktree: b.tree.path, worktreeMount: grant,
    summaries: [], memory: '', messages: [], signal };
  const options = { home: b.home, roots: [], audit: memoryAuditSink(), grants: approvals.stores.grants,
    sandbox: { required: true, limitsHelper }, exec: { mode: 'allowlist' as const, allowlist: [{ program }] } };
  const context = { agentId: 'worker', principal: b.who.userId, sessionId: request.sessionId, signal, surface: 1 as const };
  const dispatch = (registry: ToolRegistry, marker: string, ctx = context, cwd = b.tree.path) => {
    const dispatcher = new ToolDispatcher({ registry, approvals: approvals.service, grants: approvals.stores.grants,
      clock: { now: Date.now }, policyContext: () => ({ overrides: { 'shell.exec': 'allowed' } }) });
    return dispatcher.call({ id: 'native-exec', name: 'exec.run', args: { program,
      args: process.platform === 'win32' ? ['-e', 'process.exit(0)'] : [marker], cwd } }, ctx);
  };
  return { ...b, grant, request, options, context, program,
    dispatch,
    close() { approvals.service.dispose(); approvals.stores.db.close(); b.close(); },
    async call(marker: string, req = request) {
      const registry = await composeTools(options, req);
      return dispatch(registry, marker);
    } };
}

test('the actual native exec dispatcher writes only with its assigned opaque card grant', async () => {
  const b = await composed();
  try {
    const marker = join(b.tree.path, 'native-process-started');
    const result = await b.call(marker);
    assert.equal(result.isError, process.platform === 'win32', JSON.stringify(result));
    assert.equal(existsSync(marker), process.platform !== 'win32');
    if (!result.isError) assert.equal((result.value as ExecResult).exitCode, 0);
  } finally { b.close(); }
});

test('a raw coding path without the opaque grant retains the sandbox refusal', async () => {
  const b = await composed();
  try {
    const marker = join(b.tree.path, 'unbound-must-not-start');
    const unbound = { ...b.request };
    delete unbound.worktreeMount;
    const result = await b.call(marker, unbound);
    assert.equal(result.isError, true);
    assert.equal(existsSync(marker), false);
  } finally { b.close(); }
});

test('native composition rejects foreign agent, project and checkout bindings before offering tools', async () => {
  const b = await composed();
  try {
    for (const req of [{ ...b.request, agentId: 'other' }, { ...b.request, projectId: 'foreign-project' },
      { ...b.request, codingWorktree: b.repo }]) await assert.rejects(composeTools(b.options, req), /foreign|grant/i);
  } finally { b.close(); }
});

test('a native mount cannot upgrade a read-only turn or use the explicit unsandboxed owner bypass', async () => {
  const b = await composed();
  try {
    await assert.rejects(composeTools(b.options, { ...b.request, readOnlyWorktree: b.tree.path }), /read.only|grant/i);
    await assert.rejects(composeTools({ ...b.options, sandbox: { ...b.options.sandbox, required: false } }, b.request), /sandbox|grant/i);
  } finally { b.close(); }
});

test('host process tools inside a bound native turn receive no writable mount', async () => {
  const b = await composed();
  try {
    const registry = await composeTools(b.options, b.request);
    const tool = registry.get('proc.list');
    assert.ok(tool);
    await assert.rejects(tool.execute({}, b.context), /sandbox|deny|not.supported/i);
  } finally { b.close(); }
});

test('a held native tool registry refuses a revoked assignment and a different executing identity', async () => {
  const b = await composed();
  try {
    const registry = await composeTools(b.options, b.request), marker = join(b.tree.path, 'revoked-must-not-start');
    const foreign = await b.dispatch(registry, marker, { ...b.context, agentId: 'other' });
    assert.equal(foreign.isError, true);
    b.collab.boardStore.assign(b.project.id, b.card.id, { kind: 'agent', id: 'worker' }, false,
      { kind: 'person', id: b.who.userId });
    const revoked = await b.dispatch(registry, marker);
    assert.equal(revoked.isError, true);
    assert.equal(existsSync(marker), false);
  } finally { b.close(); }
});

for (const alias of ['symlink', 'outside-hardlink'] as const) test(`the real composed exec path rejects a ${alias} before starting a process`, async () => {
  const b = await composed();
  try {
    if (alias === 'symlink') await symlink(b.repo, join(b.tree.path, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    else await link(join(b.repo, 'notes.txt'), join(b.tree.path, 'alias'));
    const marker = join(b.tree.path, 'alias-must-not-start');
    const result = await b.call(marker);
    assert.equal(result.isError, true);
    assert.equal(existsSync(marker), false);
  } finally { b.close(); }
});

test('a contained store hardlink remains usable through the actual native process path', async () => {
  const b = await composed();
  try {
    await link(join(b.tree.path, 'notes.txt'), join(b.tree.path, 'contained-store-alias'));
    const marker = join(b.tree.path, 'contained-store-works');
    const result = await b.call(marker);
    assert.equal(result.isError, process.platform === 'win32', JSON.stringify(result));
    assert.equal(existsSync(marker), process.platform !== 'win32');
    if (!result.isError) assert.equal((result.value as ExecResult).exitCode, 0);
  } finally { b.close(); }
});

test('simultaneous assigned cards remain isolated from each other, the checkout, state and common Git metadata', async () => {
  const b = await composed();
  try {
    const card = b.collab.boardStore.createCard(b.project.id, { title: 'Other card',
      columnId: b.collab.boardStore.columns(b.project.id)[0]!.id }, { kind: 'person', id: b.who.userId });
    for (const agent of ['lead', 'other']) b.collab.boardStore.assign(b.project.id, card.id,
      { kind: 'agent', id: agent }, true, { kind: 'person', id: b.who.userId });
    const other = b.provisioner.fork({ projectId: b.project.id, cardId: card.id });
    const grant = WorktreeMount.fromStore(b.store, join(b.home, 'state'), b.project.id, card.id, 'other', 'lead');
    const otherRequest = { ...b.request, agentId: 'other', sessionId: 'other-card-session', codingWorktree: other.path, worktreeMount: grant };
    const registries = await Promise.all([composeTools(b.options, b.request), composeTools(b.options, otherRequest)]);
    const otherContext = { ...b.context, agentId: 'other', sessionId: otherRequest.sessionId };
    const markers = [join(b.tree.path, 'own-card'), join(other.path, 'own-card')];
    const starts = await Promise.allSettled([b.dispatch(registries[0]!, markers[0]!),
      b.dispatch(registries[1]!, markers[1]!, otherContext, other.path)]);
    for (const [i, result] of starts.entries()) {
      if (result.status !== 'fulfilled') throw result.reason;
      assert.equal(result.value.isError, process.platform === 'win32', JSON.stringify(result.value));
      assert.equal(existsSync(markers[i]!), process.platform !== 'win32');
      if (!result.value.isError) assert.equal((result.value.value as ExecResult).exitCode, 0);
    }
    if (process.platform === 'win32') return; // The asserted Windows result above is backend refusal, never isolation proof.
    const common = b.store.liveWorktree(b.project.id, b.card.id)!.commonGitDir!;
    for (const target of [join(other.path, 'foreign-card'), join(b.repo, 'root-checkout'),
      join(b.home, 'state', 'outside-card'), join(common, 'read-only-metadata')]) {
      const result = await b.dispatch(registries[0]!, target);
      assert.equal(existsSync(target), false, target);
      if (!result.isError) assert.notEqual((result.value as ExecResult).exitCode, 0);
    }
    const back = join(b.tree.path, 'foreign-other-agent');
    const result = await b.dispatch(registries[1]!, back, otherContext, other.path);
    assert.equal(existsSync(back), false);
    if (!result.isError) assert.notEqual((result.value as ExecResult).exitCode, 0);
  } finally { b.close(); }
});

if (process.platform === 'linux') test('native Linux runs the genuine Node runtime through its card mount and enforced task namespace', async () => {
  const b = await composed();
  try {
    const node = join(b.tree.path, 'node-runtime');
    await copyFile(process.execPath, node);
    await chmod(node, 0o700);
    const registry = await composeTools({ ...b.options, exec: { mode: 'allowlist', allowlist: [{ program: node }] } }, b.request);
    const approvals = await rig();
    try {
      const dispatcher = new ToolDispatcher({ registry, approvals: approvals.service, grants: approvals.stores.grants,
        clock: { now: Date.now }, policyContext: () => ({ overrides: { 'shell.exec': 'allowed' } }) });
      const result = await dispatcher.call({ id: 'native-linux-node', name: 'exec.run',
        args: { program: node, args: ['-p', 'process.version'], cwd: b.tree.path } }, b.context);
      assert.equal(result.isError, false, JSON.stringify(result));
      if (result.isError) return;
      const value = result.value as ExecResult;
      assert.equal(value.exitCode, 0, value.stderr);
      assert.equal(value.stdout.trim(), process.version);
    } finally { approvals.service.dispose(); approvals.stores.db.close(); }
  } finally { b.close(); }
});
