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
for (const [key, platform] of [['linux-x64', 'linux'], ['win32-x64', 'win32']]) {
  test(`${key}: actual hash-matched native latency, cold/warm phases, RSS and environment receipt`, { todo: gates.measuredNativeReceipts[key] ? false : gates.blockers.native }, () => {
    const proof = receipt(gates.measuredNativeReceipts[key]);
    assert.equal(proof.schema, 'plur1bus.decision-spike/1'); assert.equal(proof.platform, platform); assert.equal(proof.arch, 'x64');
    assert.deepEqual(proof.manifest, manifest); assert.equal(proof.fixtureSha256, hash);
    assert.equal(proof.rows.length, fixture.cases.length * 2); assert.equal(proof.latency.n, proof.rows.length);
    assert.ok(proof.rows.every(row => !row.error));
    const expected = fixture.cases.flatMap(row => ['de','en'].map(locale => `${row.id}:${locale}`)).sort();
    assert.deepEqual(proof.rows.map(row => `${row.id}:${row.locale}`).sort(), expected);
    assert.ok(Number.isFinite(proof.latency.p50) && proof.latency.p50 > 0);
    assert.ok(Number.isFinite(proof.latency.p95) && proof.latency.p95 >= proof.latency.p50);
    assert.ok(Number.isFinite(proof.loadMs) && proof.loadMs > 0);
    assert.ok(Number.isFinite(proof.firstInferenceMs) && proof.firstInferenceMs > 0);
    assert.equal(proof.warmLatency.n, proof.latency.n - 1);
    assert.ok(proof.warmLatency.p50 > 0 && proof.warmLatency.p95 >= proof.warmLatency.p50);
    assert.equal(proof.fileCacheState, 'uncontrolled');
    assert.ok(Number.isFinite(proof.maxRssKiB) && proof.maxRssKiB > 0);
    for (const locale of ['de','en']) {
      const rows = proof.rows.filter(row => row.coreGate && row.locale === locale);
      assert.equal(rows.length, 60); evaluate(rows);
    }
    assert.equal(proof.automaticGermanEligibility, false, 'native timing alone never grants German admission');
    {
      const environment = receipt(gates.nativeEnvironmentReceipts?.[key]);
      assert.equal(environment.schema, 'plur1bus.laya-native-environment/1');
      assert.equal(environment.virtualMachine, true); assert.equal(environment.bareMetalAcceptance, false);
      assert.equal(environment.runtime.node, proof.node); assert.equal(environment.runtime.arch, 'x64');
      assert.equal(environment.runtime.platform, platform);
      assert.equal(environment.runtime.versions['onnxruntime-node'], '1.30.0');
      assert.equal(environment.runtime.versions['@huggingface/transformers'], '4.3.1');
      assert.ok(environment.system.TotalPhysicalMemory > 0 && environment.system.NumberOfLogicalProcessors > 0);
      if (platform === 'win32') assert.equal(environment.defenderConfiguration, 'unchanged');
      if (platform === 'linux') {
        // The Linux receipt comes from a cloud sandbox VM, not the owner NAS VM: that must stay on the record.
        assert.equal(environment.hostRole, 'cloud-sandbox');
        assert.ok(environment.operatingSystem.Kernel.length && environment.system.CpuModelName.length);
        assert.equal(typeof environment.system.CpuFlagsOfInterest.avx2, 'boolean');
        const timing = environment.timingRuns[gates.measuredNativeReceipts[key].split('/').at(-1)];
        assert.equal(timing.valid, true); assert.ok(timing.foreignCpuShare < 0.05, 'timing run must not overlap foreign CPU load');
      }
      for (const file of ['decision-laya.mjs','decision-laya-lib.mjs','decision-laya-paths.mjs','decision-laya-manifest.json','decision-eval-cases.json']) {
        assert.equal(environment.sourceSha256[file], createHash('sha256').update(readFileSync(new URL(`scripts/spikes/${file}`, root))).digest('hex'));
      }
    }
  });
}
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

for (const [name, platform] of [['windows', 'win32'], ['linux', 'linux']]) {
  test(`${name} thread receipts preserve every paired case and independently recomputed cold/warm summaries`,()=>{
    const reports=[read(`docs/evidence/decision/laya-${name}-x64-threads1.json`),read(`docs/evidence/decision/laya-${name}-x64-threads2.json`)];
    const mac=read('docs/evidence/decision/laya-macos-arm64-process-phases.json');
    const quantile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
    const picks=report=>report.rows.map(row=>`${row.id}:${row.locale}:${Object.entries(row.probabilities).sort((a,b)=>b[1]-a[1])[0][0]}`);
    for(const [index,report] of reports.entries()){
      assert.equal(report.threads,index+1);assert.equal(report.platform,platform);assert.equal(report.arch,'x64');
      assert.equal(report.fixtureSha256,hash);assert.deepEqual(report.manifest,manifest);
      assert.equal(report.rows.length,180);assert.ok(report.rows.every(row=>!row.error));
      const times=report.rows.map(row=>row.elapsedMs),warm=times.slice(1);
      assert.equal(report.firstInferenceMs,times[0]);assert.equal(report.warmLatency.n,179);
      for(const [field,p] of [['p50',.5],['p95',.95]]){
        assert.equal(report.latency[field],quantile(times,p));
        assert.equal(report.warmLatency[field],quantile(warm,p));
      }
      assert.deepEqual(picks(report),picks(mac));
      for(const locale of ['de','en'])assert.equal(evaluate(report.rows.filter(row=>row.coreGate&&row.locale===locale)).accuracy,locale==='de'?28/60:39/60);
    }
  });
}
