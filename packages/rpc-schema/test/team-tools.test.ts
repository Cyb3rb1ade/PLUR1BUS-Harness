import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtures, validateParams, validateResult, METHODS_BY_SERVER } from '../src/index.ts';
import { teamHash } from '../../core/src/collab/team/plan.ts';

test('TK2 native and TypeScript consume the same closed method fixtures', () => {
  for (const method of ['tools.team.check', 'tools.team.diffcheck', 'tools.team.impact']) {
    const fixture = loadFixtures().methods[method]!;
    assert.equal(validateParams(method, fixture.params).ok, true);
    assert.equal(validateResult(method, fixture.result).ok, true);
    assert.equal(validateParams(method, { ...fixture.params as object, unknown: true }).ok, false);
    assert.ok(METHODS_BY_SERVER.tools.includes(method));
    assert.ok(!METHODS_BY_SERVER.core.includes(method));
  }
  const f = loadFixtures().methods['tools.team.check']! as { params: { plan: unknown; config: unknown }; result: { planHash: string; policyHash: string } };
  assert.equal(teamHash(f.params.plan), f.result.planHash);
  assert.equal(teamHash(f.params.config), f.result.policyHash);
});
