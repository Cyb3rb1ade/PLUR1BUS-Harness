// These executed assertions require checked-in actual Harness receipts, never adapter fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CORE_CONTRACT } from '../../src/engine.ts';
const root = new URL('../../../../', import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const gates = read('docs/evidence/media/harness-acceptance-gates.json');
const core = read('packages/core/package.json');
function receipt(path: unknown) {
  assert.equal(gates.schema, 'plur1bus.media-harness-acceptance-gates/1');
  assert.equal(typeof path, 'string', 'a checked-in actual Harness receipt is required');
  return read(path as string);
}
function pinned(proof: { enginePin: string }) {
  assert.match(proof.enginePin, /^[a-f0-9]{40}$/);
  assert.equal(core.dependencies['@cyb3rb1ade/plur1bus-memory'].split('#').at(-1), proof.enginePin);
}
test('KNOWN GAP: actual pinned Engine 1.19 exposes media API with Host Fetch before construction', { todo: gates.blockers.engineApiReceipt }, () => {
  const version = CORE_CONTRACT.split('.').map(Number);
  assert.ok(version[0] === 1 && version[1]! >= 19, `current contract ${CORE_CONTRACT} predates media`);
  const proof = receipt(gates.engineApiReceipt); pinned(proof);
  assert.equal(proof.engineContract, CORE_CONTRACT); assert.equal(proof.actualEngine, true);
  assert.equal(proof.hostFetchBeforeConstruction, true);
  for (const method of ['index', 'search', 'remove', 'setCaption', 'status', 'backfill.start', 'backfill.pause', 'backfill.resume', 'backfill.cancel']) assert.ok(proof.exercisedMethods.includes(method), method);
});
test('KNOWN GAP: production media reserves image/video units and leases secrets before cloud requests', { todo: gates.blockers.productionUnitBudgetReceipt }, () => {
  const proof = receipt(gates.productionUnitBudgetReceipt); pinned(proof);
  assert.equal(proof.productionComposition, true); assert.equal(proof.fakeEncodingBudget, false);
  assert.equal(proof.image.reservedImages, 1);
  assert.equal(proof.video.trustedSeconds, 2.25); assert.equal(proof.video.reservedSeconds, 3);
  for (const call of [proof.image, proof.video]) {
    assert.ok(call.reservationSequence < call.requestSequence);
    assert.ok(call.secretLeaseSequence < call.requestSequence); assert.equal(call.settled, true);
  }
  assert.equal(proof.requestsWithoutReservation, 0); assert.equal(proof.requestsWithoutSecretLease, 0);
});
test('KNOWN GAP: real Harness image/audio indexing returns scoped image query and caption-memory recall', { todo: gates.blockers.harnessEndToEndReceipt }, () => {
  const proof = receipt(gates.harnessEndToEndReceipt); pinned(proof);
  assert.equal(proof.actualHarness, true); assert.equal(proof.fakeEncoder, false);
  for (const fixture of [proof.image, proof.audio]) {
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/); assert.ok(fixture.indexedSegments > 0);
    assert.equal(fixture.captionMemoryRecalled, true); assert.equal(fixture.foreignAgentHits, 0);
  }
  assert.ok(proof.imageQuery.returnedExpectedImage); assert.equal(proof.imageQuery.foreignAgentHits, 0);
});
