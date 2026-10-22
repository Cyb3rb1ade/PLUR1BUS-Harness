import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validate, restartClassOf, tierOf } from '../src/index.ts';
const config = (modelPolicy: unknown) => ({ ...defaults(), agents: { a: { modelPolicy } } });
test('model policy is optional and fixed by default, without migrating legacy agent configs', () => {
  const old = validate({ ...defaults(), agents: { a: {} } }); assert.equal(old.ok, true); if (old.ok) assert.equal(old.config.agents.a!.modelPolicy, undefined);
  const result = validate(config({})); assert.equal(result.ok, true); if (result.ok) assert.deepEqual(result.config.agents.a!.modelPolicy, { mode: 'fixed', tiers: [], perTurn: false });
});
test('auto uses a bounded unique ordered profile list and opt-in per-turn selection', () => {
  assert.equal(validate(config({ mode: 'auto', tiers: ['cheap', 'quality'] })).ok, true);
  assert.equal(validate(config({ mode: 'auto', tiers: ['quality'], perTurn: true })).ok, true);
  for (const value of [{ mode: 'auto' }, { mode: 'auto', tiers: [] }, { mode: 'auto', tiers: ['cheap', 'cheap'] }, { mode: 'auto', tiers: [' '] }, { mode: 'dynamic' }, { perTurn: 'true' }, { unknown: true }, { mode: 'auto', tiers: Array.from({ length: 17 }, (_, i) => `p${i}`) }]) assert.equal(validate(config(value)).ok, false, JSON.stringify(value));
});
test('policy changes are live with explicit tiers and per-turn config in advanced settings', () => {
  for (const path of ['agents.a.modelPolicy', 'agents.a.modelPolicy.mode', 'agents.a.modelPolicy.tiers', 'agents.a.modelPolicy.perTurn']) { assert.equal(restartClassOf(path), 'live'); assert.equal(tierOf(path), 'advanced'); }
});
