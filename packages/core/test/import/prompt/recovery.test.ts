import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type * as E from '@cyb3rb1ade/plur1bus-memory/types/engine.js';
import { deriveUserPrincipal } from '../../../src/identity/principals.ts';
import { agentsOfOwnPromptRuns, executePromptImport, type ExecutePromptImportOptions } from '../../../src/import/prompt/execute.ts';

function options(t: TestContext, engine: E.Engine): ExecutePromptImportOptions {
  const home = mkdtempSync(join(tmpdir(), 'p-import-recovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const principal: E.Principal = { agentId: 'main', workspace: 'workspace:v1:main', channel: 'cli',
    accountId: 'fixture', chat: { id: 'fixture', kind: 'direct' }, trust: 'proved', user: deriveUserPrincipal('alice') };
  return { home, engine, principal, principalFor: () => principal, importedBy: 'alice',
    entries: [{ category: 'Projects', sourceType: 'memory', text: 'Synthetic project fact', warnings: [], idempotencyKey: 'fixture' }],
    targets: [{ target: 'agent', agentIds: ['main'] }] };
}

test('a rejected first batch is rolled back even if it persisted a card before rejecting', async t => {
  const rows = new Set(['unrelated-run']), failure = new Error('first batch interrupted');
  let runId = '', cleanups = 0;
  const opts = options(t, { memory: {
    import: async (req: E.MemoryImportRequest) => { runId = req.importRunId!; rows.add(runId); throw failure; },
    unimport: async (req: E.MemoryUnimportRequest, principal: E.Principal) => {
      assert.equal(req.agentId, 'main'); assert.equal(req.importRunId, runId);
      assert.deepEqual(principal, opts.principal);
      cleanups++; rows.delete(req.importRunId); return { unimported: 1 };
    },
  } } as unknown as E.Engine);
  await assert.rejects(executePromptImport(opts), error => error === failure);
  assert.equal(cleanups, 1);
  assert.deepEqual([...rows], ['unrelated-run']);
});

test('the saved recovery report identifies target agents before the first Engine side effect', async t => {
  let agentsDuringImport: string[] = [];
  const opts = options(t, { memory: {
    import: async (req: E.MemoryImportRequest) => {
      agentsDuringImport = agentsOfOwnPromptRuns(opts.home, 'alice');
      const report = JSON.parse(readFileSync(join(opts.home, 'imports', req.importRunId!, 'report.json'), 'utf8'));
      assert.equal(report.status, 'started');
      return { created: 1, matchedExisting: 0, rejected: 0,
        cards: [{ outcome: 'created', id: 'fixture-card', idempotencyKey: req.cards[0]!.idempotencyKey }] };
    },
  } } as unknown as E.Engine);
  await executePromptImport(opts);
  assert.deepEqual(agentsDuringImport, ['main']);
});

test('a failed report update cannot prevent cleanup of a partly written first batch', async t => {
  let cleanups = 0;
  const opts = options(t, { memory: {
    import: async (req: E.MemoryImportRequest) => {
      const report = join(opts.home, 'imports', req.importRunId!, 'report.json');
      rmSync(report); mkdirSync(report);
      throw new Error('partly written batch');
    },
    unimport: async () => { cleanups++; return { unimported: 1 }; },
  } } as unknown as E.Engine);
  await assert.rejects(executePromptImport(opts));
  assert.equal(cleanups, 1);
});

test('a rejected dry run never unimports data', async t => {
  let cleanups = 0;
  const opts = options(t, { memory: {
    import: async (req: E.MemoryImportRequest) => { assert.equal(req.dryRun, true); throw new Error('dry run interrupted'); },
    unimport: async () => { cleanups++; return { unimported: 1 }; },
  } } as unknown as E.Engine);
  await assert.rejects(executePromptImport({ ...opts, dryRun: true }), /dry run interrupted/);
  assert.equal(cleanups, 0);
});
