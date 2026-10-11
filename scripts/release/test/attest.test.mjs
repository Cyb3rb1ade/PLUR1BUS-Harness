import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { packageArchive } from '../package.mjs';
const root = resolve(import.meta.dirname, '../../..');
const fixture = async fn => { const d = mkdtempSync(join(tmpdir(), 'attest-release-')); try { await fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test('all release targets ship the exact helper beside the CLI with safe tar permissions', () => fixture(async d => {
  const assets = join(d, 'assets');
  mkdirSync(join(assets, 'completions'), { recursive: true }); mkdirSync(join(assets, 'man/man1'), { recursive: true });
  writeFileSync(join(d, 'cli'), 'cli'); writeFileSync(join(d, 'core'), 'core');
  writeFileSync(join(d, 'plur1bus-attest'), 'final helper bytes', { mode: 0o777 });
  writeFileSync(join(d, 'plur1bus-attest.exe'), 'final windows bytes');
  for (const target of ['linux-x64', 'linux-arm64', 'linux-x64-musl', 'darwin-arm64', 'darwin-x64', 'darwin-universal', 'win-x64']) {
    const windows = target === 'win-x64', name = `bin/plur1bus-attest${windows ? '.exe' : ''}`;
    const archive = join(d, `${target}.${windows ? 'zip' : 'tar.gz'}`);
    await packageArchive('0.1.0', target, join(d, 'cli'), join(d, 'core'), archive, assets);
    const out = join(d, target); mkdirSync(out);
    if (windows) execFileSync('unzip', ['-q', archive, '-d', out]);
    else execFileSync('tar', ['-xf', archive, '-C', out]);
    assert.equal(readFileSync(join(out, name), 'utf8'), windows ? 'final windows bytes' : 'final helper bytes');
    if (!windows) {
      assert.equal(statSync(join(out, name)).mode & 0o777, 0o755);
      assert.equal(statSync(join(out, 'bin')).mode & 0o022, 0);
      assert.equal(statSync(join(out, name)).uid, process.getuid());
      if (target.startsWith('linux-')) assert.equal(readFileSync(join(out, 'share/polkit-1/actions/org.plur1bus.approve.policy'), 'utf8'), readFileSync(join(root, 'crates/plur1bus-attest/policy/org.plur1bus.approve.policy'), 'utf8'));
    }
  }
  rmSync(join(d, 'plur1bus-attest'));
  await assert.rejects(packageArchive('0.1.0', 'linux-x64', join(d, 'cli'), join(d, 'core'), join(d, 'missing.tar.gz'), assets), /ENOENT|helper/i);
}));

test('helper preparation hashes after signing, and missing signer pins warn without failing', () => fixture(async d => {
  const { prepareHelper } = await import('../attest.mjs');
  const helper = join(d, 'helper'); writeFileSync(helper, 'unsigned');
  const warnings = [];
  const pins = prepareHelper(helper, { platform: 'darwin', env: { PLUR1BUS_ATTEST_TEAM_ID: 'ABCDEFGHIJ', PLUR1BUS_ATTEST_SIGN_IDENTITY: 'fixture identity' }, warn: s => warnings.push(s), run: (cmd, args) => {
    if (args.includes('--sign')) writeFileSync(helper, 'signed');
  } });
  assert.equal(pins.PLUR1BUS_ATTEST_SHA256, createHash('sha256').update('signed').digest('hex'));
  assert.equal(pins.PLUR1BUS_ATTEST_TEAM_ID, 'ABCDEFGHIJ');
  const fallback = prepareHelper(helper, { platform: 'win32', env: {}, warn: s => warnings.push(s), run: () => assert.fail('no signer configured') });
  assert.deepEqual(Object.keys(fallback), ['PLUR1BUS_ATTEST_SHA256']);
  assert.ok(warnings.some(s => /hash.*permissions/i.test(s)));
  assert.throws(() => prepareHelper(helper, { platform: 'darwin', env: { PLUR1BUS_ATTEST_TEAM_ID: 'invalid', PLUR1BUS_ATTEST_SIGN_IDENTITY: 'fixture' }, run: () => assert.fail('invalid pin must fail first') }), /team/i);
  assert.throws(() => prepareHelper(helper, { platform: 'win32', env: { PLUR1BUS_ATTEST_WIN_THUMBPRINT: 'A'.repeat(40) }, run: () => { throw new Error('signing failed'); } }), /signing failed/);
}));

test('release build without hash pin warns, debug builds do not; changing pins invalidates Cargo build', () => fixture(async d => {
  const executable = join(d, 'build-script');
  execFileSync('rustc', [join(root, 'crates/plur1bus/build.rs'), '-o', executable]);
  const env = { ...process.env, PROFILE: 'release' }; delete env.PLUR1BUS_ATTEST_SHA256;
  const run = extra => spawnSync(executable, [], { env: { ...env, ...extra }, encoding: 'utf8' });
  const missing = run({}); assert.equal(missing.status, 0); assert.match(missing.stdout, /cargo:warning=.*PLUR1BUS_ATTEST_SHA256/);
  assert.doesNotMatch(run({ PROFILE: 'debug' }).stdout, /cargo:warning=/);
  assert.match(run({ PLUR1BUS_ATTEST_SHA256: '' }).stdout, /cargo:warning=/);
  const pinned = run({ PLUR1BUS_ATTEST_SHA256: 'a'.repeat(64) }); assert.doesNotMatch(pinned.stdout, /cargo:warning=/);
  for (const key of ['SHA256', 'TEAM_ID', 'WIN_THUMBPRINT']) assert.match(pinned.stdout, new RegExp(`rerun-if-env-changed=PLUR1BUS_ATTEST_${key}`));
}));

test('workflow passes final helper hash before CLI build, including the universal archive', () => {
  const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /-p plur1bus-attest/);
  assert.match(workflow, /build:\n    needs: \[meta, attest\]/);
  assert.ok(workflow.indexOf('attest.mjs --load helper') < workflow.indexOf('pnpm gen && pnpm build'));
  assert.ok(workflow.indexOf('scripts/release/attest.mjs') < workflow.indexOf('cargo build --locked --release -p plur1bus --target'));
  assert.match(workflow, /vars.PLUR1BUS_ATTEST_TEAM_ID/); assert.match(workflow, /vars.PLUR1BUS_ATTEST_WIN_THUMBPRINT/);
  assert.match(workflow, /attest-darwin-universal/);
  for (const file of ['nfpm/nfpm.yaml.in', 'scoop/plur1bus.json.in', 'homebrew/plur1bus.rb.in']) assert.match(readFileSync(join(root, 'packaging', file), 'utf8'), /plur1bus-attest/);
});

test('downloaded helper hash reaches the real CLI build constant; altered bytes are rejected', () => fixture(async d => {
  const { prepareHelper } = await import('../attest.mjs');
  const helper = join(d, process.platform === 'win32' ? 'plur1bus-attest.exe' : 'plur1bus-attest');
  writeFileSync(helper, 'final distributed bytes');
  const pins = prepareHelper(helper, { platform: 'linux', env: {} });
  writeFileSync(join(d, 'pins.json'), JSON.stringify(pins));
  const githubEnv = join(d, 'github-env'); writeFileSync(githubEnv, '');
  const load = () => spawnSync(process.execPath, [join(root, 'scripts/release/attest.mjs'), '--load', d], { env: { ...process.env, GITHUB_ENV: githubEnv }, encoding: 'utf8' });
  assert.equal(load().status, 0);
  const exported = Object.fromEntries(readFileSync(githubEnv, 'utf8').trim().split('\n').map(line => line.split('=')));
  assert.equal(exported.PLUR1BUS_ATTEST_SHA256, pins.PLUR1BUS_ATTEST_SHA256);
  // Compile the real CLI function without pulling in unrelated dependencies or making network calls.
  const source = readFileSync(join(root, 'crates/plur1bus/src/install/pins.rs'), 'utf8');
  const fn = source.slice(source.indexOf('pub fn attest_helper_pins()'), source.indexOf('\n/// Where a release build'));
  const src = join(d, 'pin.rs'), binary = join(d, 'pin');
  writeFileSync(src, `${fn}\nfn main() { println!("{}", attest_helper_pins().0.unwrap()); }\n`);
  execFileSync('rustc', [src, '-o', binary], { env: { ...process.env, ...exported } });
  assert.equal(execFileSync(binary, [], { encoding: 'utf8', env: { ...process.env, PLUR1BUS_ATTEST_SHA256: 'b'.repeat(64) } }).trim(), pins.PLUR1BUS_ATTEST_SHA256);
  writeFileSync(helper, 'tampered');
  assert.notEqual(load().status, 0);
  assert.match(load().stderr, /does not match/);
}));
