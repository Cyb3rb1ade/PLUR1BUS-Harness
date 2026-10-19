import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAllowlist, cvssSeverity, parsePnpm, parseCargo, evaluate, renderSummary, assertOwnerChange, assertNoPnpmIgnores } from '../audit-policy.mjs';

const id = 'GHSA-aaaa-bbbb-cccc';
const now = new Date('2026-10-15T12:00:00Z');
const exception = { advisoryId: id, reason: 'Owner acceptance with tracked remediation', created: '2026-10-15', expires: '2027-01-13' };
const policy = entry => ({ version: 1, exceptions: entry ? [entry] : [] });
const finding = (severity, packageName = 'runtime') => ({ id, package: packageName, severity });

test('production High/Critical block; dev and lower severities warn, including mixed reachability', () => {
  const prod = ['low', 'moderate', 'high', 'critical', 'unknown'].map(s => finding(s, s));
  const results = evaluate(prod, [...prod, finding('critical', 'test-tool')], new Map());
  assert.deepEqual(results.filter(r => r.block).map(r => r.severity), ['high', 'critical', 'unknown']);
  assert.equal(results.find(r => r.package === 'test-tool').scope, 'dev');
  assert.equal(results.find(r => r.package === 'test-tool').block, false);
  assert.equal(evaluate([finding('high')], [finding('high')], new Map())[0].scope, 'production');
});

test('owner exceptions expire strictly, have a maximum 90-day lifetime, and cannot be malformed', () => {
  const allowed = validateAllowlist(policy(exception), now);
  assert.equal(evaluate([finding('critical')], [], allowed)[0].block, false);
  for (const edit of [
    { expires: '2027-01-14' }, { expires: '2026-10-15' }, { created: '2026-10-16' },
    { created: '2026-02-30' }, { reason: ' ' }, { advisoryId: 'anything' }, { extra: true },
  ]) assert.throws(() => validateAllowlist(policy({ ...exception, ...edit }), now));
  assert.throws(() => validateAllowlist({ version: 1, exceptions: [exception, exception] }, now));
  assert.throws(() => validateAllowlist(policy(exception), new Date('2027-01-13T00:00:00Z')));
  // An expired entry fails even when its advisory is no longer present.
  assert.throws(() => validateAllowlist(policy({ ...exception, created: '2026-07-01', expires: '2026-08-01' }), now));
});

test('CVSS base vectors preserve FIRST severity boundaries and unknown vectors fail closed', () => {
  const vectors = [
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 'critical'],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H', 'high'],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N', 'moderate'],
    ['CVSS:3.1/AV:L/AC:L/PR:H/UI:N/S:U/C:L/I:N/A:N', 'low'],
    ['CVSS:3.0/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N', 'moderate'],
    [null, 'unknown'], ['CVSS:4.0/AV:N', 'unknown'], ['CVSS:3.1/AV:bad', 'unknown'],
  ];
  for (const [vector, expected] of vectors) assert.equal(cvssSeverity(vector), expected, vector);
});

test('pnpm requires a complete report and canonical advisory IDs', () => {
  const report = { advisories: { 1: { github_advisory_id: id, module_name: 'runtime', severity: 'high' } }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } } };
  assert.deepEqual(parsePnpm(JSON.stringify(report)), [{ ...finding('high'), title: undefined }]);
  assert.throws(() => parsePnpm('{}'));
  assert.throws(() => parsePnpm(JSON.stringify({ ...report, advisories: {} })));
  assert.throws(() => parsePnpm(JSON.stringify({ ...report, error: { message: 'network failure' } })));
});

test('Rust production and dev reports include vulnerabilities and unsound warnings; collection errors block', () => {
  const v = { advisory: { id: 'RUSTSEC-2026-0344', cvss: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' }, package: { name: 'ruzstd', version: '0.9.0' } };
  const report = { vulnerabilities: [v], warnings: { unsound: [{ ...v, advisory: { ...v.advisory, id: 'RUSTSEC-2026-0001', cvss: null } }] }, settings: { ignore: [], severity: null }, lockfile: { 'dependency-count': 1 } };
  const summary = JSON.stringify({ type: 'summary', fields: { advisories: { errors: 1 } } });
  const results = parseCargo(JSON.stringify(report), summary);
  assert.deepEqual(results.map(r => r.severity), ['high', 'unknown']);
  assert.throws(() => parseCargo(JSON.stringify(report), ''));
  assert.throws(() => parseCargo(JSON.stringify({ ...report, settings: { ignore: [v.advisory.id], severity: null } }), summary));
  assert.throws(() => parseCargo(JSON.stringify(report), summary + '\n' + JSON.stringify({ type: 'diagnostic', fields: { severity: 'error', code: 'db-error' } })));
  assert.equal(evaluate([], results, new Map()).some(r => r.block), false);
});

test('summary exposes all warnings/exceptions and sanitizes Markdown table content', () => {
  const rows = evaluate([finding('high', 'a|b\n<c>')], [finding('critical', 'dev')], validateAllowlist(policy(exception), now));
  const text = renderSummary(rows, ['network failure']);
  assert.match(text, /dev.*critical.*warning/);
  assert.match(text, /owner exception until 2027-01-13/);
  assert.match(text, /BLOCK: network failure/);
  assert.doesNotMatch(text, /<c>/);
});

test('allowlist changes reject non-owner PR authors even when triggered by the owner', () => {
  assert.throws(() => assertOwnerChange(true, { pull_request: { user: { login: 'contributor' } } }, 'pull_request', 'Cyb3rb1ade'));
  assert.doesNotThrow(() => assertOwnerChange(false, {}, 'pull_request', 'Cyb3rb1ade'));
  assert.doesNotThrow(() => assertOwnerChange(true, { pull_request: { user: { login: 'Cyb3rb1ade' } } }, 'pull_request', 'Cyb3rb1ade'));
});

test('pnpm configuration cannot provide a second, unversioned advisory allowlist', () => {
  assert.doesNotThrow(() => assertNoPnpmIgnores(''));
  assert.doesNotThrow(() => assertNoPnpmIgnores('{"ignoreCves":[],"ignoreGhsas":[]}'));
  assert.throws(() => assertNoPnpmIgnores('{"ignoreCves":["CVE-2026-1234"]}'));
  assert.throws(() => assertNoPnpmIgnores('{"ignoreGhsas":["GHSA-aaaa-bbbb-cccc"]}'));
  assert.throws(() => assertNoPnpmIgnores('{"ignoreUnfixable":true}'));
});

test('KNOWN GAP: an exception is not scoped to the package it was approved for', { todo: 'KNOWN GAP: audit-allowlist.json entries match by advisory ID only, so RUSTSEC-2026-0367..0369 approved for zip 4.6.1 also hide other crates' }, () => {
  const approved = validateAllowlist(policy({ advisoryId: 'RUSTSEC-2026-0367', reason: 'zip 4.6.1 behind the signature-checked updater', created: '2026-10-15', expires: '2027-01-13' }), now);
  const other = { id: 'RUSTSEC-2026-0367', package: 'other-crate@1.0.0', severity: 'high' };
  assert.equal(evaluate([other], [], approved)[0].block, true);
});
