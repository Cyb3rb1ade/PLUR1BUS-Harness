import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAllowlist, cvssSeverity, parsePnpm, parseCargo, evaluate, renderSummary, assertOwnerChange, assertNoPnpmIgnores } from '../audit-policy.mjs';

const id = 'GHSA-aaaa-bbbb-cccc';
const now = new Date('2026-10-15T12:00:00Z');
const exception = { advisoryId: id, crate: 'runtime', versionRange: '=1.0.0', reason: 'Owner acceptance with tracked remediation', created: '2026-10-15', expires: '2027-01-13' };
const policy = entry => ({ version: 1, exceptions: entry ? [entry] : [] });
const finding = (severity, packageName = 'runtime', version = '1.0.0') => ({ id, package: packageName, crate: packageName, version, severity });

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
  const report = { advisories: { 1: { github_advisory_id: id, module_name: 'runtime', severity: 'high', vulnerable_versions: '<=1.0.0' } }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } } };
  const parsed = parsePnpm(JSON.stringify(report));
  assert.deepEqual(parsed, [{ id, package: 'runtime', crate: 'runtime', severity: 'high', title: undefined }]);
  assert.equal(evaluate(parsed, [], validateAllowlist(policy(exception), now))[0].block, true, 'a report without an installed version cannot use an exception');
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
  assert.deepEqual(results.map(({ crate, version }) => ({ crate, version })), [{ crate: 'ruzstd', version: '0.9.0' }, { crate: 'ruzstd', version: '0.9.0' }]);
  assert.throws(() => parseCargo(JSON.stringify(report), ''));
  assert.throws(() => parseCargo(JSON.stringify({ ...report, settings: { ignore: [v.advisory.id], severity: null } }), summary));
  assert.throws(() => parseCargo(JSON.stringify(report), summary + '\n' + JSON.stringify({ type: 'diagnostic', fields: { severity: 'error', code: 'db-error' } })));
  assert.equal(evaluate([], results, new Map()).some(r => r.block), false);
});

test('summary exposes all warnings/exceptions and sanitizes Markdown table content', () => {
  const rows = evaluate([{ ...finding('high'), package: 'a|b\n<c>' }], [finding('critical', 'dev')], validateAllowlist(policy(exception), now));
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

test('an exception cannot hide the same advisory in another crate', () => {
  const advisory = 'RUSTSEC-2026-0367';
  const approved = validateAllowlist(policy({ ...exception, advisoryId: advisory, crate: 'zip', versionRange: '=4.6.1' }), now);
  const intended = { ...finding('high', 'zip', '4.6.1'), id: advisory, package: 'zip@4.6.1' };
  const others = [{ ...intended, crate: 'other-crate', package: 'other-crate@4.6.1' },
    { ...intended, version: '4.6.2', package: 'zip@4.6.2' }, { ...intended, id: 'RUSTSEC-2026-0368' }];
  assert.deepEqual(evaluate([intended, ...others], [], approved).map(row => row.block), [false, true, true, true]);
});

test('exceptions require explicit crate and version range and reject unsupported ranges', () => {
  for (const key of ['crate', 'versionRange']) {
    const missing = { ...exception }; delete missing[key];
    assert.throws(() => validateAllowlist(policy(missing), now));
  }
  for (const edit of [{ crate: undefined }, { crate: '' }, { crate: ' runtime' }, { crate: 1 },
    { versionRange: undefined }, { versionRange: null }, { versionRange: 1 }, { versionRange: '' }, { versionRange: '*' }, { versionRange: '^1.0.0' },
    { versionRange: '~1.0.0' }, { versionRange: '=1.0' }, { versionRange: '=01.0.0' },
    { versionRange: '=1.0.0-rc.1' }, { versionRange: '=1.0.0+build' }, { versionRange: '=9007199254740992.0.0' },
    { versionRange: '>=1.0.0' }, { versionRange: '>=2.0.0, <1.0.0' }, { versionRange: '>=1.0.0, <1.0.0' },
    { versionRange: '>1.0.0, <1.0.1' }, { versionRange: '=1.0.0 || =2.0.0' }]) {
    assert.throws(() => validateAllowlist(policy({ ...exception, ...edit }), now), JSON.stringify(edit));
  }
});

test('bounded stable-version ranges compare numeric components and enforce endpoints', () => {
  const maximum = String(Number.MAX_SAFE_INTEGER);
  for (const [range, yes, no] of [
    ['=0.0.0', ['0.0.0'], ['0.0.1']],
    ['>=1.9.0, <1.11.0', ['1.9.0', '1.10.0'], ['1.8.9', '1.11.0']],
    ['>1.9.0, <=1.10.0', ['1.9.1', '1.10.0'], ['1.9.0', '1.10.1']],
    ['>=1.0.0, <=1.0.0', ['1.0.0'], ['1.0.1']],
    [`>1.2.${maximum}, <1.3.1`, ['1.3.0'], [`1.2.${maximum}`, '1.3.1']],
  ]) {
    const approved = validateAllowlist(policy({ ...exception, versionRange: range }), now);
    for (const version of yes) assert.equal(evaluate([finding('high', 'runtime', version)], [], approved)[0].block, false, `${range}: ${version}`);
    for (const version of no) assert.equal(evaluate([finding('high', 'runtime', version)], [], approved)[0].block, true, `${range}: ${version}`);
  }
});

test('duplicate normalized tuples reject while distinct crate or version approvals coexist', () => {
  const approved = validateAllowlist({ version: 1, exceptions: [exception, { ...exception, crate: 'other' }, { ...exception, versionRange: '=1.0.1' }] }, now);
  assert.deepEqual(evaluate([finding('high'), finding('high', 'other'), finding('high', 'runtime', '1.0.1'), finding('high', 'runtime', '1.0.2')], [], approved).map(row => row.block), [false, false, false, true]);
  assert.throws(() => validateAllowlist({ version: 1, exceptions: [
    { ...exception, versionRange: '>=1.0.0,<2.0.0' }, { ...exception, versionRange: '>=1.0.0, <2.0.0' },
  ] }, now));
  assert.throws(() => validateAllowlist({ version: 1, exceptions: [exception,
    { ...exception, versionRange: '>=1.0.0, <=1.0.0' },
  ] }, now));
});

test('unrecorded or unsupported finding versions and display-only identities cannot be excepted', () => {
  const approved = validateAllowlist(policy(exception), now);
  for (const version of [undefined, null, '', '1.0', 'unknown', '1.0.0-rc.1', '1.0.0+build', 1])
    assert.equal(evaluate([{ ...finding('critical'), version }], [], approved)[0].block, true);
  assert.equal(evaluate([{ id, package: 'runtime@1.0.0', severity: 'critical' }], [], approved)[0].block, true);
});

test('production and dev reachability remain distinct for two versions of a crate', () => {
  const production = finding('high', 'runtime', '1.0.0'), dev = finding('critical', 'runtime', '2.0.0');
  const rows = evaluate([production], [production, dev], validateAllowlist(policy(exception), now));
  assert.deepEqual(rows.map(({ version, scope, block }) => ({ version, scope, block })), [
    { version: '1.0.0', scope: 'production', block: false }, { version: '2.0.0', scope: 'dev', block: false },
  ]);
});

test('Cargo package identity reaches exception matching without parsing display strings', () => {
  const advisoryId = 'RUSTSEC-2026-0367';
  const report = (...packages) => JSON.stringify({ vulnerabilities: packages.map(([name, version]) => ({
    advisory: { id: advisoryId, cvss: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' }, package: { name, version },
  })), warnings: {}, settings: { ignore: [], severity: null }, lockfile: { 'dependency-count': packages.length } });
  const summary = JSON.stringify({ type: 'summary', fields: { advisories: { errors: 1 } } });
  const rows = parseCargo(report(['zip', '4.6.1'], ['zip', '4.6.2'], ['other-crate', '4.6.1']), summary);
  const approved = validateAllowlist(policy({ ...exception, advisoryId, crate: 'zip', versionRange: '=4.6.1' }), now);
  assert.deepEqual(evaluate(rows, [], approved).map(row => row.block), [false, true, true]);
});
