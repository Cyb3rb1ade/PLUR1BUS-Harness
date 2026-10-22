// Local transport acceptance remains green; these assertions track only missing native Kev evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const preflight = JSON.parse(readFileSync(new URL('../../../../docs/evidence/decision-kev/preflight.json', import.meta.url), 'utf8'));
function metrics() {
  assert.equal(preflight.schema, 'plur1bus.kev-spike-preflight/1');
  assert.ok(preflight.metrics && typeof preflight.metrics === 'object', 'real Kev measurements are absent');
  return preflight.metrics;
}
test('KNOWN GAP: real local Kev MLX inference supplies cold/cache latency and RSS', { todo: 'Frozen Python sync is blocked by files.pythonhosted.org DNS; no server or model inference ran' }, () => {
  assert.equal(preflight.inferencePerformed, true); assert.equal(preflight.serverStarted, true);
  assert.equal(preflight.machine, 'arm64'); assert.match(preflight.platform, /^macOS-/);
  const measured = metrics();
  for (const field of ['coldMs', 'cacheP50Ms', 'cacheP95Ms', 'maxRssKiB']) assert.ok(Number.isFinite(measured[field]) && measured[field] > 0, `${field} requires a native measurement`);
  assert.ok(measured.cacheP95Ms >= measured.cacheP50Ms);
});
test('KNOWN GAP: Kev German eligibility requires independently labelled paired native Accuracy/Brier evidence', { todo: 'No native Kev inference, independent labels or matched role comparison exist; production Kev remains ineligible' }, () => {
  const measured = metrics();
  assert.equal(measured.independentLabels, true); assert.match(measured.fixtureSha256, /^[a-f0-9]{64}$/);
  assert.equal(measured.roleComparison.fixtureSha256, measured.fixtureSha256);
  assert.ok(measured.pairedCases >= 60);
  for (const locale of ['de', 'en']) {
    assert.equal(measured[locale].n, measured.pairedCases);
    assert.ok(Number.isFinite(measured[locale].accuracy) && measured[locale].accuracy >= 0 && measured[locale].accuracy <= 1);
    assert.ok(Number.isFinite(measured[locale].brier) && measured[locale].brier >= 0);
  }
  assert.ok(measured.de.accuracy >= measured.en.accuracy - .05);
  assert.ok(measured.de.brier <= measured.en.brier + .05);
  assert.equal(preflight.automaticGermanEligibility, true);
});
