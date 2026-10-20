import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLoan, transitionLoan, modelWorkDecision, modelLease, lenderLoanView,
  type LoanState, type LoanOffer,
} from '../../src/federation/loan-model.ts';

const start = 1_000_000;
const offer = (patch: Partial<LoanOffer> = {}): LoanOffer => ({
  loanId: 'mission-1', agentId: 'bernd', lenderFingerprint: 'lender', borrowerFingerprint: 'borrower',
  createdAt: start, expiresAt: start + 2_592_000_000, keepMissionCopies: false,
  secretNames: ['calendar'], ...patch,
});
function accepted(side: 'lender' | 'borrower' = 'borrower'): LoanState {
  return transitionLoan(createLoan(offer(), side, start),
    side === 'borrower' ? { type: 'accept', borrowerProjectId: 'project-secret' } : { type: 'accept' }, start);
}
function active(side: 'lender' | 'borrower' = 'borrower'): LoanState {
  const s = accepted(side);
  return transitionLoan(s, { type: 'renew', lease: modelLease(s, start) }, start);
}

test('acceptance alone cannot run; a fresh lease enables only the one borrower project', () => {
  const s = accepted();
  assert.equal(modelWorkDecision(s, 'project-secret', start).allowed, false);
  const a = active();
  assert.deepEqual(modelWorkDecision(a, 'project-secret', start), { allowed: true });
  assert.equal(modelWorkDecision(a, 'another-project', start).allowed, false);
  assert.equal(modelWorkDecision(a, undefined, start).allowed, false);
  assert.equal(modelWorkDecision(active('lender'), 'project-secret', start).allowed, false);
});

test('lease expires at 120 seconds without a tick; heartbeat is due at 30 seconds', () => {
  const s = active();
  assert.equal(s.nextHeartbeatAt, 1_030_000);
  assert.equal(modelWorkDecision(s, 'project-secret', 1_119_999).allowed, true);
  assert.equal(modelWorkDecision(s, 'project-secret', 1_120_000).allowed, false);
  assert.equal(transitionLoan(s, { type: 'tick' }, 1_119_999).status, 'active');
  assert.equal(transitionLoan(s, { type: 'tick' }, 1_120_000).status, 'paused');
});

test('fresh renewal resumes a paused borrower and resets the heartbeat and offline clock', () => {
  const paused = transitionLoan(active(), { type: 'tick' }, 1_120_000);
  const renewed = transitionLoan(paused, { type: 'renew', lease: modelLease(paused, 1_150_000) }, 1_150_000);
  assert.equal(renewed.status, 'active');
  assert.equal(renewed.lastContactAt, 1_150_000);
  assert.equal(renewed.nextHeartbeatAt, 1_180_000);
  assert.equal(modelWorkDecision(renewed, 'project-secret', 1_269_999).allowed, true);
  assert.equal(paused.status, 'paused');
});

test('borrower pauses on lease expiry and ends at the inclusive 24-hour lender-offline boundary', () => {
  const s = active();
  assert.equal(transitionLoan(s, { type: 'tick' }, start + 86_399_999).status, 'paused');
  const ended = transitionLoan(s, { type: 'tick' }, start + 86_400_000);
  assert.equal(ended.status, 'returned-by-timeout');
  assert.equal(ended.removalConfirmed, false);
  assert.equal(transitionLoan(ended, { type: 'tick' }, start + 86_400_001).status, 'returned-by-timeout');
  assert.throws(() => transitionLoan(s, { type: 'renew', lease: modelLease(s, start + 86_400_000) }, start + 86_400_000), /ended/);
});

test('lender closes at the inclusive 15-minute borrower-offline boundary and late renewal cannot revive it', () => {
  const s = active('lender');
  assert.equal(transitionLoan(s, { type: 'tick' }, start + 899_999).status, 'paused');
  assert.equal(transitionLoan(s, { type: 'tick' }, start + 900_000).status, 'returned-by-timeout');
  assert.throws(() => transitionLoan(s, { type: 'renew', lease: modelLease(s, start + 900_000) }, start + 900_000), /ended/);
});

test('a successful heartbeat resets grace without accumulating earlier outages', () => {
  const s = active('lender');
  const renewed = transitionLoan(s, { type: 'renew', lease: modelLease(s, start + 30_000) }, start + 30_000);
  assert.equal(transitionLoan(renewed, { type: 'tick' }, start + 929_999).status, 'paused');
  assert.equal(transitionLoan(renewed, { type: 'tick' }, start + 930_000).status, 'returned-by-timeout');
});

for (const event of ['recall', 'revoke', 'return'] as const) {
  test(`${event} is terminal, preserves ownership and cannot be renewed`, () => {
    const s = active();
    const ended = transitionLoan(s, { type: event }, start + 1);
    assert.equal(ended.status, { recall: 'recalled', revoke: 'revoked', return: 'returned' }[event]);
    assert.equal(ended.offer.lenderFingerprint, 'lender');
    assert.equal(modelWorkDecision(ended, 'project-secret', start + 1).allowed, false);
    assert.throws(() => transitionLoan(ended, { type: 'renew', lease: modelLease(s, start + 2) }, start + 2), /ended/);
    assert.equal(transitionLoan(ended, { type: 'confirm-removal' }, start + 2).removalConfirmed, true);
  });
}

test('an offer accepts at most 30 days and cannot issue a lease beyond mission expiry', () => {
  assert.throws(() => createLoan(offer({ expiresAt: start + 2_592_000_001 }), 'borrower', start), /duration/);
  const s = transitionLoan(createLoan(offer({ expiresAt: start + 60_000 }), 'borrower', start),
    { type: 'accept', borrowerProjectId: 'p1' }, start);
  const lease = modelLease(s, start);
  assert.equal(lease.notAfter, start + 60_000);
  const a = transitionLoan(s, { type: 'renew', lease }, start);
  assert.equal(transitionLoan(a, { type: 'tick' }, start + 60_000).status, 'expired');
  assert.equal(modelWorkDecision(a, 'p1', start + 60_000).allowed, false);
});

test('unknown keys and secret-bearing fields are refused; secret references stay names only', () => {
  for (const patch of [{ secretValue: 'probe-secret' }, { credentials: 'probe-secret' }, { lenderProjectAccess: true }]) {
    assert.throws(() => createLoan({ ...offer(), ...patch }, 'borrower', start), /unknown/);
  }
  const names = ['calendar'];
  const input = offer({ secretNames: names });
  const s = createLoan(input, 'borrower', start);
  names.push('later');
  assert.deepEqual(s.offer.secretNames, ['calendar']);
  assert.ok(Object.isFrozen(s.offer.secretNames));
  assert.throws(() => createLoan(offer({ secretNames: ['calendar=value'] }), 'borrower', start), /secret name/);
});

test('borrower project stays local; lender record rejects it and public projection omits it', () => {
  const s = accepted();
  assert.equal(JSON.stringify(lenderLoanView(s)).includes('project-secret'), false);
  assert.equal('borrowerProjectId' in lenderLoanView(s), false);
  assert.throws(() => transitionLoan(createLoan(offer(), 'lender', start), { type: 'accept', borrowerProjectId: 'p1' }, start), /project/);
  assert.throws(() => transitionLoan(createLoan(offer(), 'borrower', start), { type: 'accept' }, start), /project/);
  assert.throws(() => transitionLoan(s, { type: 'accept', borrowerProjectId: 'another' }, start), /transition/);
});

test('expired offers, unsafe times and clock rollback fail closed', () => {
  for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createLoan(offer({ createdAt: value }), 'borrower', start), /time/);
  }
  assert.throws(() => createLoan(offer(), 'borrower', start - 1), /time/);
  assert.equal(transitionLoan(createLoan(offer(), 'borrower', start), { type: 'tick' }, start + 2_592_000_000).status, 'expired');
  assert.throws(() => transitionLoan(active(), { type: 'tick' }, start - 1), /time/);
  assert.equal(modelWorkDecision(active(), 'project-secret', start - 1).allowed, false);
});

test('wrong loan/agent/peer, future, oversized, expired and replayed leases are refused', () => {
  const s = active();
  const good = modelLease(s, start + 30_000);
  for (const lease of [
    { ...good, loanId: 'other' }, { ...good, agentId: 'other' }, { ...good, borrowerFingerprint: 'other' },
    { ...good, issuedAt: start + 30_001 }, { ...good, notAfter: start + 150_001 },
    { ...good, notAfter: start + 30_000 }, { ...good, secretValue: 'probe-secret' }, s.lease!,
  ]) assert.throws(() => transitionLoan(s, { type: 'renew', lease }, start + 30_000), /lease|unknown/);
});

test('seeded renewal/outage trace never allows work after lease expiry or a terminal state', () => {
  let state = active(); let now = start; let seed = 42;
  for (let i = 0; i < 500; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    now += (seed % 60_000) + 1;
    state = transitionLoan(state, { type: 'tick' }, now);
    if (i === 400) state = transitionLoan(state, { type: 'recall' }, now);
    const decision = modelWorkDecision(state, 'project-secret', now);
    if (decision.allowed) {
      assert.equal(state.status, 'active');
      assert.ok(state.lease && now < state.lease.notAfter && now < state.offer.expiresAt);
    }
    if ((state.status === 'active' || state.status === 'paused') && i < 400 && seed % 3 === 0) {
      state = transitionLoan(state, { type: 'renew', lease: modelLease(state, now) }, now);
    }
  }
  assert.equal(state.status, 'recalled');
});

test('fresh heartbeat capped at the same mission expiry is valid; replay still is not', () => {
  const pending = transitionLoan(createLoan(offer({ expiresAt: start + 60_000 }), 'borrower', start),
    { type: 'accept', borrowerProjectId: 'p1' }, start);
  const s = transitionLoan(pending, { type: 'renew', lease: modelLease(pending, start) }, start);
  const lease = modelLease(s, start + 30_000);
  assert.equal(lease.notAfter, start + 60_000);
  const renewed = transitionLoan(s, { type: 'renew', lease }, start + 30_000);
  assert.equal(renewed.lastContactAt, start + 30_000);
  assert.throws(() => transitionLoan(renewed, { type: 'renew', lease }, start + 30_001), /lease/);
});

test('decline is only valid before acceptance and return cannot invent an accepted loan', () => {
  const offered = createLoan(offer(), 'borrower', start);
  assert.equal(transitionLoan(offered, { type: 'decline' }, start).status, 'declined');
  assert.throws(() => transitionLoan(offered, { type: 'return' }, start), /transition/);
  assert.throws(() => transitionLoan(accepted(), { type: 'decline' }, start), /transition/);
  assert.throws(() => transitionLoan(offered, { type: 'renew', lease: modelLease(offered, start) }, start), /transition/);
  assert.throws(() => transitionLoan(active(), { type: 'confirm-removal' }, start), /transition/);
});

test('unknown event names including object prototype keys cannot create a state', () => {
  for (const type of ['unknown', 'constructor', '__proto__', 'toString']) {
    assert.throws(() => transitionLoan(active(), { type } as never, start), /transition/);
  }
});

test('a delayed lease response never postpones the already-due heartbeat beyond lease expiry', () => {
  const s = accepted();
  const lease = modelLease(s, start);
  const delayed = transitionLoan(s, { type: 'renew', lease }, start + 119_999);
  assert.equal(delayed.nextHeartbeatAt, start + 30_000);
  assert.ok(delayed.nextHeartbeatAt! < delayed.lease!.notAfter);
});
