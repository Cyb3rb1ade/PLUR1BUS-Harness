import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoan, transitionLoan, type LoanOffer } from '../../src/federation/loan-model.ts';
import {
  makeMemoryBatches, receiveMemoryBatch, createMemoryOutbox, acknowledgeMemoryBatch,
  borrowerMemoryDisposition, foreignMemoryUse, selectedHomeMemories,
  type LoanMemoryRef, type MemoryBatch,
} from '../../src/federation/loan-memory-policy.ts';

const offer: LoanOffer = {
  loanId: 'loan-one', agentId: 'bernd', lenderFingerprint: 'home', borrowerFingerprint: 'away',
  createdAt: 1000, expiresAt: 1000 + 2_592_000_000, keepMissionCopies: false, secretNames: [],
};
const borrower = transitionLoan(createLoan(offer, 'borrower', 1000), { type: 'accept', borrowerProjectId: 'hidden-project' }, 1000);
const ref = (id: string, personKey = 'eva', level: LoanMemoryRef['level'] = 'shareable'): LoanMemoryRef => ({ id, personKey, level, contentHash: 'a'.repeat(64) });

test('continuous batches separate both relationship and level, with stable retry identity', () => {
  const items = [ref('s1'), ref('p1', 'eva', 'private'), ref('c1', 'eva', 'confidential'), ref('s2', 'chris'), ref('s3')];
  const batches = makeMemoryBatches(borrower, items);
  assert.equal(batches.length, 4);
  assert.deepEqual(batches.map(b => [b.relationshipKey, b.level, b.items.map(i => i.id)]), [
    ['rel:bernd:peer:away:chris', 'shareable', ['s2']],
    ['rel:bernd:peer:away:eva', 'confidential', ['c1']],
    ['rel:bernd:peer:away:eva', 'private', ['p1']],
    ['rel:bernd:peer:away:eva', 'shareable', ['s1', 's3']],
  ]);
  assert.deepEqual(makeMemoryBatches(borrower, [...items].reverse()), batches);
  assert.equal(JSON.stringify(batches).includes('hidden-project'), false);
  assert.deepEqual(makeMemoryBatches(borrower, []), []);
});

test('direct-import descriptors retain mission, foreign relationship, level and taint', () => {
  const batch = makeMemoryBatches(borrower, [ref('m1', 'eva', 'private')])[0]!;
  const result = receiveMemoryBatch([], offer, batch);
  assert.deepEqual(result.imports, [{
    id: 'm1', contentHash: 'a'.repeat(64), relationshipKey: 'rel:bernd:peer:away:eva', level: 'private',
    context: { kind: 'mission', missionId: 'loan-one' }, origin: { system: 'peer:away' },
    sourceRef: `mission:loan-one@away#${batch.batchId}:m1`, tainted: true,
  }]);
  assert.deepEqual(result.ack, { loanId: 'loan-one', batchId: batch.batchId });
  assert.equal(result.received.length, 1);
});

test('replayed batch yields the same acknowledgement and zero duplicate imports', () => {
  const batch = makeMemoryBatches(borrower, [ref('m1')])[0]!;
  const first = receiveMemoryBatch([], offer, batch);
  const replay = receiveMemoryBatch(first.received, offer, batch);
  assert.deepEqual(replay.ack, first.ack);
  assert.deepEqual(replay.imports, []);
  assert.deepEqual(replay.received, first.received);
});

test('forged content, foreign mission/peer and unknown credential fields cannot enter an inbox', () => {
  const batch = makeMemoryBatches(borrower, [ref('m1')])[0]!;
  for (const bad of [
    { ...batch, loanId: 'another' }, { ...batch, borrowerFingerprint: 'another' },
    { ...batch, agentId: 'another' }, { ...batch, relationshipKey: 'rel:bernd:peer:away:chris' },
    { ...batch, level: 'private' }, { ...batch, items: [{ id: 'm1', contentHash: 'b'.repeat(64) }] },
    { ...batch, secretValue: 'probe-secret' }, { ...batch, items: [{ ...batch.items[0]!, token: 'probe-secret' }] },
  ]) assert.throws(() => receiveMemoryBatch([], offer, bad as MemoryBatch), /batch|unknown/);
});

test('acknowledgements bind the mission and exact batch; repeated ack is harmless', () => {
  const batch = makeMemoryBatches(borrower, [ref('m1')])[0]!;
  const outbox = createMemoryOutbox([batch]);
  const ack = receiveMemoryBatch([], offer, batch).ack;
  assert.equal(outbox[0]!.acknowledged, false);
  const acknowledged = acknowledgeMemoryBatch(outbox, ack);
  assert.equal(acknowledged[0]!.acknowledged, true);
  assert.deepEqual(acknowledgeMemoryBatch(acknowledged, ack), acknowledged);
  assert.equal(outbox[0]!.acknowledged, false);
  assert.throws(() => acknowledgeMemoryBatch(outbox, { ...ack, loanId: 'another' }), /ack/);
  assert.throws(() => acknowledgeMemoryBatch(outbox, { ...ack, batchId: 'b'.repeat(64) }), /ack/);
});

test('return cleanup never discards unacknowledged data and retention needs the lender offer', () => {
  assert.equal(borrowerMemoryDisposition(offer, false, false), 'mission-store');
  assert.equal(borrowerMemoryDisposition(offer, true, false), 'mission-store');
  assert.equal(borrowerMemoryDisposition(offer, false, true), 'outbox');
  assert.equal(borrowerMemoryDisposition(offer, true, true), 'remove');
  assert.equal(borrowerMemoryDisposition({ ...offer, keepMissionCopies: true }, true, true), 'retained-copy');
  assert.equal(borrowerMemoryDisposition({ ...offer, keepMissionCopies: true }, false, true), 'outbox');
});

test('home private memories cannot enter the selected loan package and no selection defaults to empty', () => {
  assert.deepEqual(selectedHomeMemories(), []);
  assert.throws(() => selectedHomeMemories([ref('private-marker', 'chris', 'private')]), /private/);
  assert.deepEqual(selectedHomeMemories([ref('s'), ref('c', 'chris', 'confidential')]).map(x => x.id), ['s', 'c']);
});

test('foreign-memory rules exclude private content and prohibit disclosing confidential entries', () => {
  assert.equal(foreignMemoryUse('shareable'), 'show-with-origin');
  assert.equal(foreignMemoryUse('confidential'), 'use-without-disclosure');
  assert.equal(foreignMemoryUse('private'), 'exclude');
  assert.throws(() => foreignMemoryUse('unknown' as LoanMemoryRef['level']), /level/);
});

test('relationship delimiter injection, duplicate ids, invalid level/hash and secret payloads are refused', () => {
  for (const bad of [
    { ...ref('m'), personKey: 'eva:peer:other' }, { ...ref('m'), level: 'unknown' },
    { ...ref('m'), contentHash: 'bad' }, { ...ref('m'), secretValue: 'probe-secret' },
  ]) assert.throws(() => makeMemoryBatches(borrower, [bad as LoanMemoryRef]), /memory|unknown/);
  assert.throws(() => makeMemoryBatches(borrower, [ref('m'), ref('m', 'chris')]), /duplicate/);
  assert.throws(() => makeMemoryBatches(createLoan(offer, 'lender', 1000), [ref('m')]), /borrower/);
});

test('batch output and inbox receipts detach from caller mutation', () => {
  const input = [ref('m1')];
  const batch = makeMemoryBatches(borrower, input)[0]!;
  input[0]!.contentHash = 'b'.repeat(64);
  assert.equal(batch.items[0]!.contentHash, 'a'.repeat(64));
  assert.ok(Object.isFrozen(batch.items));
  const result = receiveMemoryBatch([], offer, batch);
  assert.ok(Object.isFrozen(result.received));
  assert.ok(Object.isFrozen(result.imports[0]));
});

test('overlapping continuous batches import each memory only once and conflicting re-use is refused', () => {
  const first = receiveMemoryBatch([], offer, makeMemoryBatches(borrower, [ref('m1')])[0]!);
  const next = receiveMemoryBatch(first.received, offer, makeMemoryBatches(borrower, [ref('m1'), ref('m2')])[0]!);
  assert.deepEqual(next.imports.map(i => i.id), ['m2']);
  const changed = makeMemoryBatches(borrower, [{ ...ref('m1'), contentHash: 'b'.repeat(64) }])[0]!;
  assert.throws(() => receiveMemoryBatch(next.received, offer, changed), /conflict/);
  const moved = makeMemoryBatches(borrower, [ref('m1', 'another', 'private')])[0]!;
  assert.throws(() => receiveMemoryBatch(next.received, offer, moved), /conflict/);
});

test('an inbox cannot mix missions and a forged receipt cannot suppress a direct import', () => {
  const batch = makeMemoryBatches(borrower, [ref('m1')])[0]!;
  assert.throws(() => receiveMemoryBatch([{ ...batch, loanId: 'another' }], offer, batch), /batch/);
});

test('restored receipt input cannot mutate the next accepted ledger snapshot', () => {
  const first = receiveMemoryBatch([], offer, makeMemoryBatches(borrower, [ref('m1')])[0]!);
  const restored = structuredClone(first.received) as { items: { contentHash: string }[] }[] & MemoryBatch[];
  const next = receiveMemoryBatch(restored, offer, makeMemoryBatches(borrower, [ref('m2')])[0]!);
  restored[0]!.items[0]!.contentHash = 'b'.repeat(64);
  assert.equal(next.received[0]!.items[0]!.contentHash, 'a'.repeat(64));
});
