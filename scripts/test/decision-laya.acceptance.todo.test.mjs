// Executed acceptance assertions. A TODO failure is missing evidence, never native/model acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluate } from '../spikes/decision-laya-lib.mjs';
const root = new URL('../../', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const gates = read('docs/evidence/decision/laya-acceptance-gates.json');
const manifest = read('scripts/spikes/decision-laya-manifest.json');
const fixtureBytes = readFileSync(new URL('scripts/spikes/decision-eval-cases.json', root));
const fixture = JSON.parse(fixtureBytes), hash = createHash('sha256').update(fixtureBytes).digest('hex');
function receipt(path) {
  assert.equal(gates.schema, 'plur1bus.laya-acceptance-gates/1');
  assert.equal(typeof path, 'string', 'a checked-in acceptance receipt is required');
  return read(path);
}
function labels() {
  const review = receipt(gates.independentLabelReviewReceipt);
  assert.equal(review.fixtureSha256, hash);
  assert.equal(review.independent, true);
  assert.equal(typeof review.reviewer, 'string'); assert.ok(review.reviewer.length);
  assert.deepEqual([...review.reviewedCaseIds].sort(), fixture.cases.map(c => c.id).sort());
  assert.deepEqual([...review.locales].sort(), ['de', 'en']);
  return review;
}
test('KNOWN GAP: production Laya service or module has public backend, bounded abort and role fallback evidence', { todo: gates.blockers.productionBackendReceipt }, async () => {
  const proof = receipt(gates.productionBackendReceipt);
  assert.ok(['core-service', 'module'].includes(proof.integrationKind));
  if (proof.integrationKind === 'module') {
    const { validateManifest } = await import('../../packages/module-api/src/manifest.ts');
    const result = validateManifest(read(proof.moduleManifestPath));
    assert.equal(result.ok, true, 'module must satisfy the existing manifest schema');
  }
  assert.equal(proof.backend, 'laya'); assert.equal(proof.modelRevision, manifest.revision);
  assert.equal(proof.publicBackendPort, true); assert.equal(proof.deadlineAbortVerified, true);
  assert.equal(proof.roleFallbackVerified, true);
});
test('KNOWN GAP: Linux x64 and Windows x64 have actual hash-matched native latency/RSS receipts', { todo: gates.blockers.native }, () => {
  for (const [key, platform] of [['linux-x64', 'linux'], ['win32-x64', 'win32']]) {
    const proof = receipt(gates.measuredNativeReceipts[key]);
    assert.equal(proof.schema, 'plur1bus.decision-spike/1'); assert.equal(proof.platform, platform); assert.equal(proof.arch, 'x64');
    assert.equal(proof.manifest.revision, manifest.revision); assert.equal(proof.fixtureSha256, hash);
    assert.ok(proof.rows.length >= 120); assert.ok(proof.latency.n >= 120);
    assert.ok(Number.isFinite(proof.latency.p50) && proof.latency.p50 > 0);
    assert.ok(Number.isFinite(proof.latency.p95) && proof.latency.p95 >= proof.latency.p50);
    assert.ok(Number.isFinite(proof.maxRssKiB) && proof.maxRssKiB > 0);
  }
});
test('KNOWN GAP: independent labels cover the exact paired fixture hash before calibration admission', { todo: gates.blockers.labels }, () => { labels(); });
test('KNOWN GAP: role comparison uses independently reviewed identical German/English cases', { todo: gates.blockers.roleComparisonReceipt }, () => {
  const proof = receipt(gates.roleComparisonReceipt); labels();
  const laya = receipt(gates.measuredNativeReceipts['darwin-arm64']);
  assert.equal(proof.fixtureSha256, hash); assert.equal(laya.fixtureSha256, hash);
  assert.equal(typeof proof.modelRevision, 'string'); assert.ok(proof.modelRevision.length);
  const keys = rows => rows.filter(r => r.coreGate).map(r => `${r.id}:${r.locale}`).sort();
  assert.deepEqual(keys(proof.rows), keys(laya.rows));
  for (const locale of ['de', 'en']) {
    const rows = proof.rows.filter(r => r.coreGate && r.locale === locale);
    assert.equal(rows.length, 60);
    const metrics = evaluate(rows);
    assert.deepEqual(proof.metrics[locale], metrics, 'stored role metrics must recompute from the identical paired rows');
    assert.ok(Number.isFinite(metrics.accuracy)); assert.ok(Number.isFinite(metrics.brier));
  }
});
