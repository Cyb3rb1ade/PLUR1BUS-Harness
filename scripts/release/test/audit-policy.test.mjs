import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAllowlist, cvssSeverity, parsePnpm, parseCargo, collectVendoredRust, evaluate, renderSummary, assertOwnerChange, assertNoPnpmIgnores } from '../audit-policy.mjs';

const id = 'RUSTSEC-2026-0001';
const ghsaId = 'GHSA-aaaa-bbbb-cccc';
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
  const report = { advisories: { 1: { github_advisory_id: ghsaId, module_name: 'runtime', severity: 'high', vulnerable_versions: '<=1.0.0' } }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } } };
  const parsed = parsePnpm(JSON.stringify(report));
  assert.deepEqual(parsed, [{ id: ghsaId, package: 'runtime', crate: 'runtime', severity: 'high', title: undefined }]);
  assert.equal(evaluate(parsed, [], new Map([[ghsaId, [{ ...exception, advisoryId: ghsaId }]]]))[0].block, true, 'a report without an installed version cannot use an exception');
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


test('the checked-in audit allowlist has valid format and current expiry dates', () => {
  const checked = JSON.parse(readFileSync(new URL('../../../audit-allowlist.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validateAllowlist(checked));
});

test('exception intervals stay inside one major including an exclusive next-major boundary', () => {
  for (const range of ['>=1.0.0, <2.0.0', '>1.2.3, <=1.99.99', '>=0.1.0, <1.0.0']) {
    assert.doesNotThrow(() => validateAllowlist(policy({ ...exception, versionRange: range }), now), range);
  }
  for (const range of ['>=0.0.0, <9007199254740991.0.0', '>=1.0.0, <3.0.0',
    '>=1.0.0, <=2.0.0', '>=1.0.0, <2.0.1', '>0.0.0, <=1.0.0']) {
    assert.throws(() => validateAllowlist(policy({ ...exception, versionRange: range }), now), /one major/, range);
  }
});

test('GHSA exceptions explain the missing installed-version collector', () => {
  assert.throws(() => validateAllowlist(policy({ ...exception, advisoryId: ghsaId }), now),
    /GHSA.*installed version.*pnpm/i);
});

test('unused exception warnings name the exact tuple and do not create a blocking finding', () => {
  const approved = validateAllowlist({ version: 1, exceptions: [exception,
    { ...exception, versionRange: '=1.0.1' }, { ...exception, crate: 'unused-crate' }] }, now);
  const findings = evaluate([finding('high')], [], approved);
  assert.deepEqual(findings.map(row => row.block), [false]);
  const summary = renderSummary(findings, [], approved);
  assert.deepEqual(summary.split('\n').filter(line => line.startsWith('Warning: unused audit exception:')), [
    `Warning: unused audit exception: ${id}/runtime/=1.0.1`,
    `Warning: unused audit exception: ${id}/unused-crate/=1.0.0`,
  ]);
  assert.match(summary, /0 blocking findings; 0 collection\/policy errors/);
  assert.doesNotMatch(summary, /BLOCK:/);
});


test('unused interval warnings preserve both comparison operators when rendered', () => {
  const approved = validateAllowlist(policy({ ...exception, versionRange: '>=1.0.0, <2.0.0' }), now);
  const summary = renderSummary([], [], approved);
  assert.ok(summary.includes(`Warning: unused audit exception: ${id}/runtime/&gt;=1.0.0, &lt;2.0.0`),
    'warning must retain both comparison operators in its rendered version range');
});


function vendoredFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'plur1bus-vendor-audit-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'db');
  const scratch = join(dir, 'scratch');
  mkdirSync(scratch);
  const write = (path, body) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  };
  const packages = [];
  for (const [folder, name, version] of [
    ['crates/vendor', 'runtime', '1.0.0'],
    ['vendor', 'patched', '1.2.0'],
  ]) {
    const manifestPath = join(dir, folder, name, 'Cargo.toml');
    packages.push({ name, version, manifest_path: manifestPath });
    write(manifestPath, `[package]\nname = "${name}"\nversion = "${version}"\n[lib]\n`);
    write(join(dir, folder, name, 'src/lib.rs'), '');
    const advisoryId = name === 'runtime' ? id : 'RUSTSEC-2026-0002';
    write(join(db, 'crates', name, `${advisoryId}.md`), [
      '```toml',
      '[advisory]',
      `id = "${advisoryId}"`,
      `package = "${name}"`,
      'date = "2026-10-15"',
      'cvss = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"',
      '[versions]',
      'patched = [">= 1.1.0"]',
      '```',
      '',
      '# Synthetic audit fixture',
      '',
      'Exercises local path-patch advisory coverage.',
      '',
    ].join('\n'));
  }

  return { dir, db, scratch, packages };
}

function assertVendoredPolicy(found) {
  assert.deepEqual(found.map(item => [item.id, item.crate, item.version, item.severity]), [
    [id, 'runtime', '1.0.0', 'critical'],
  ]);
  assert.equal(evaluate(found, found, new Map())[0].block, true);
  assert.equal(evaluate(found, found, validateAllowlist(policy(exception), now))[0].block, false);
}

test('vendored audit submits both roots as registry identities and enforces release policy', t => {
  const { dir, db, scratch, packages } = vendoredFixture(t);
  const metadata = [];
  const vulnerable = { advisory: { id, cvss: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }, package: packages[0] };
  const report = {
    database: { 'advisory-count': 2 }, lockfile: { 'dependency-count': 2 },
    settings: { severity: null, ignore: [], target_arch: [], target_os: [], informational_warnings: ['unsound', 'unmaintained', 'notice'] },
    vulnerabilities: { found: true, count: 1, list: [vulnerable] }, warnings: {},
  };
  function invoke(command, args, cwd) {
    assert.equal(command, 'cargo');
    if (args[1] === '--version') {
      assert.deepEqual(args, ['audit', '--version']);
      assert.equal(cwd, scratch);
      return { status: 0, stdout: 'cargo-audit 0.22.2\n' };
    }
    if (args[0] === 'metadata') {
      assert.equal(cwd, dir);
      const manifest = args.at(-1);
      assert.deepEqual(args, ['metadata', '--format-version=1', '--no-deps', '--offline', '--manifest-path', manifest]);
      metadata.push(manifest);
      return { status: 0, stdout: JSON.stringify({ packages: packages.filter(pkg => pkg.manifest_path === manifest) }) };
    }
    assert.equal(cwd, scratch);
    const lock = join(scratch, 'vendored.Cargo.lock');
    assert.deepEqual(args, ['audit', '--no-fetch', '--no-yanked', '--json', '--db', db, '--file', lock]);
    assert.equal(readFileSync(lock, 'utf8'), `version = 3\n\n${packages.map(({ name, version }) =>
      `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"`).join('\n\n')}\n\n`);
    return { status: 1, stdout: JSON.stringify(report) };
  }
  assertVendoredPolicy(collectVendoredRust(dir, db, scratch, invoke));
  assert.deepEqual(metadata, packages.map(pkg => pkg.manifest_path));
  report.settings.ignore = [id];
  assert.throws(() => collectVendoredRust(dir, db, scratch, invoke), /Incomplete or filtered/);
});

// The named release workflow installs the exact tool before this test and
// must fail if it is missing. Generic release-script CI only tests the command
// contract above because that job has no RustSec installation step.
const realAudit = process.env.GITHUB_WORKFLOW === 'release-quality'
  || (!process.env.GITHUB_WORKFLOW && spawnSync('cargo', ['audit', '--version']).status === 0);
test('vendored crates use RustSec version requirements and the regular release policy', {
  skip: !realAudit && 'pinned cargo-audit integration runs in release-quality',
}, t => {
  const { dir, db, scratch } = vendoredFixture(t);
  assertVendoredPolicy(collectVendoredRust(dir, db, scratch));
});
