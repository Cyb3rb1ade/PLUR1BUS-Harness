import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE, validateAuditRecord } from '../src/index.ts';
const row = (action: string, detail: Record<string, unknown>) => ({ at: 1, actor: { user: 'owner', host: 'host' }, action, target: 'audit-chain', detail });

test('audit.log refusal markers accept exactly the Rust refusal codes', () => {
  for (const reason of ['tail-malformed', 'anchor-missing', 'anchor-invalid', 'chain-shorter-than-anchor', 'tail-anchor-mismatch', 'sequence-exhausted', 'rotation-target-exists', 'lock-timeout']) {
    assert.equal(validateAuditRecord({ ...row('setup.complete', {}), chain: 'refused', chainReason: reason }).ok, true, reason);
  }
  for (const extra of [{ chain: 'ok' }, { chainReason: 'tail-mismatch' }, { chainReason: 'arbitrary-content' }, { surprise: true }]) {
    assert.equal(validateAuditRecord({ ...row('setup.complete', {}), ...extra }).ok, false);
  }
});

test('config.set accepts the actual prepare-event attributes and rejects wrong phase/revision types', () => {
  const detail = { personId: 'p1', oldValue: 1, newValue: 2, targetRevision: 'rev-1', phase: 'prepare' };
  assert.equal(validateAuditRecord(row('audit.config.set', detail)).ok, true);
  assert.equal(validateAuditRecord(row('audit.config.set', { ...detail, phase: 'committed' })).ok, false);
  assert.equal(validateAuditRecord(row('audit.config.set', { ...detail, targetRevision: 42 })).ok, false);
  assert.equal(validateAuditRecord(row('audit.config.set', { ...detail, personId: null })).ok, false);
});

test('all recovery and journal events are registered with valid concrete examples', () => {
  for (const action of ['audit.chain.anchor-advanced', 'audit.chain.reanchored', 'audit.chain.pending_drained', 'audit.chain.pending_overflow']) {
    const entry = CATALOGUE.events.find(e => e.event === action);
    assert.ok(entry, action);
    assert.equal(entry.stream, 'audit');
    assert.equal(validateAuditRecord(entry.examples[0]).ok, true, action);
  }
});
