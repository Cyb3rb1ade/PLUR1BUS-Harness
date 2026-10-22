import { it } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validate, restartClassOf, tierOf } from '../src/index.ts';

const config = (decision: unknown) => ({ ...defaults(), decision });
it('keeps existing decision timeout and model-class profiles valid', () => {
  const result = validate(config({ timeoutMs: 200, classProfiles: { small: 'cheap', frontier: 'quality' } }));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.config.decision.classProfiles, { small: 'cheap', frontier: 'quality' });
});
it('defaults to the existing role backend without requiring a new backend installation', () => {
  const legacy = defaults() as unknown as Record<string, unknown>; delete legacy.decision;
  const result = validate(legacy);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.config.decision, {
    backend: 'role', timeoutMs: 200, classProfiles: {},
    budgets: { triage: 200, routing: 200, pruning: 100, skills: 100, placement: 200, zoom: 150, compaction: 200 },
    confidence: { triage: 0, routing: .7, pruning: .7, skills: .7, placement: .7, zoom: .35, compaction: .7 },
  });
});
it('accepts every backend selection and rejects unknown backend names', () => {
  for (const backend of ['role', 'laya', 'kev', 'jev', 'auto']) assert.equal(validate(config({ backend })).ok, true, backend);
  assert.equal(validate(config({ backend: 'kevMac' })).ok, false);
});
it('rejects unknown decision keys and model classes', () => {
  for (const decision of [{ tiemoutMs: 200 }, { classProfiles: { tiny: 'cheap' } }, { classProfiles: { small: '' } }, { budgets: { zoomm: 150 } }, { confidence: { prunee: .7 } }]) assert.equal(validate(config(decision)).ok, false, JSON.stringify(decision));
});
it('bounds global and per-use-case budgets to positive integer milliseconds', () => {
  for (const value of [0, -1, 1.5, 60_001, '200', null]) {
    assert.equal(validate(config({ timeoutMs: value })).ok, false, `timeout ${value}`);
    assert.equal(validate(config({ budgets: { triage: value } })).ok, false, `triage ${value}`);
  }
  assert.equal(validate(config({ timeoutMs: 60_000, budgets: { zoom: 1 } })).ok, true);
});
it('rejects confidence outside the closed unit interval', () => {
  for (const value of [-.01, 1.01, '0.7', null]) assert.equal(validate(config({ confidence: { pruning: value } })).ok, false);
  for (const value of [0, 1]) assert.equal(validate(config({ confidence: { pruning: value } })).ok, true);
});
it('applies backend, budget and confidence changes live in advanced settings', () => {
  for (const path of ['decision.backend', 'decision.timeoutMs', 'decision.budgets.zoom', 'decision.confidence.pruning', 'decision.classProfiles.small']) {
    assert.equal(restartClassOf(path), 'live', path);
    assert.equal(tierOf(path), 'advanced', path);
  }
});
