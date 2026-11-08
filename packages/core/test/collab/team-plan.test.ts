import assert from 'node:assert/strict';
import { test } from 'node:test';
import fixture from '../../../rpc-schema/fixtures/team/plan.json' with { type: 'json' };
import { assertTeamPlan, teamHash } from '../../src/collab/team/plan.ts';

test('TK1 plan is closed, bounded and never accepts a caller-chosen lane', () => {
  assertTeamPlan(fixture);
  for (const change of [
    (p: any) => { p.packages[0].lane = 'contained'; },
    (p: any) => { p.packages = Array.from({ length: 33 }, () => p.packages[0]); },
    (p: any) => { p.sections = Array.from({ length: 9 }, () => p.sections[0]); },
    (p: any) => { p.packages[0].objective = 'ü'.repeat(2001); },
    (p: any) => { p.packages[0].owns[0].glob = 'src/[ab]/**'; },
    (p: any) => { p.packages[0].checks[0].criterion = 4; },
    (p: any) => { p.packages[0].owns[0].glob = '../private/**'; },
    (p: any) => { p.packages[0].extra = true; },
  ]) {
    const plan = structuredClone(fixture); change(plan);
    assert.throws(() => assertTeamPlan(plan));
  }
});

test('TK1 plans reject duplicate keys and later-section dependencies before checking', () => {
  const plan = structuredClone(fixture);
  plan.sections.push({ ...plan.sections[0]!, key: 'later', mergeOrder: ['later'] });
  plan.packages.push({ ...plan.packages[0]!, key: 'later', section: 'later' });
  plan.packages[0]!.dependsOn.push({ package: 'later', kind: 'order', reason: 'A deliberate dependency' } as never);
  assert.throws(() => assertTeamPlan(plan));
  const duplicate = structuredClone(fixture);
  duplicate.packages.push(duplicate.packages[0]!);
  assert.throws(() => assertTeamPlan(duplicate));
});

test('TK1 hashes ignore object insertion order but retain array order and content', () => {
  assert.equal(teamHash({ a: 1, b: [2, 3] }), teamHash({ b: [2, 3], a: 1 }));
  assert.notEqual(teamHash({ a: [2, 3] }), teamHash({ a: [3, 2] }));
});

test('TK1 applies the D104 byte bound to the complete brief and refuses aggregate budget overflow', () => {
  const plan = structuredClone(fixture);
  plan.packages[0]!.objective = '';
  const overhead = Buffer.byteLength(JSON.stringify(plan.packages[0]), 'utf8');
  plan.packages[0]!.objective = 'x'.repeat(2000 - overhead);
  assertTeamPlan(plan);
  plan.packages[0]!.objective += 'ü';
  assert.throws(() => assertTeamPlan(plan));
  const budgets = structuredClone(fixture);
  budgets.sections[0]!.budget.tokens = Number.MAX_SAFE_INTEGER;
  budgets.sections.push({ ...budgets.sections[0]!, key: 'later', budget: { tokens: 1, wallTimeMs: 1 }, mergeOrder: [] });
  assert.throws(() => assertTeamPlan(budgets));
});
