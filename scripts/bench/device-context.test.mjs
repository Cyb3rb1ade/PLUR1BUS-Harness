import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceContext } from './device-context.mjs';
test('VM roles preserve host provenance and exclude bare-metal acceptance', () => {
  for (const [role, os, architecture, host] of [['nas-windows-x64','win32','x64','NAS'], ['parallels-windows-arm64','win32','arm64','Owner-Mac'], ['nas-ubuntu-x64','linux','x64','NAS']]) {
    const result = deviceContext(role, { os, architecture });
    assert.equal(result.virtualMachine, true); assert.equal(result.hostRole, host);
    assert.equal(result.bareMetalComparisonEligible, false); assert.match(result.resourcesScope, /vCPUs/);
    assert.match(result.comparisonNote, /diagnostic only/);
  }
});
test('mislabeled and unknown devices cannot silently become reference hardware', () => {
  assert.throws(() => deviceContext('nas-windows-x64', { os: 'darwin', architecture: 'arm64' }));
  assert.throws(() => deviceContext('typo', { os: 'linux', architecture: 'x64' }));
  assert.equal(deviceContext(undefined, {}).bareMetalComparisonEligible, false);
  assert.equal(deviceContext('owner-mac', { os: 'darwin', architecture: 'arm64' }).virtualMachine, false);
});
