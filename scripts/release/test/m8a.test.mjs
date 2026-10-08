import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../../..');
const cli = (name, args, cwd = root) => execFileSync(process.execPath, [join(root, 'scripts/release', name), ...args], { cwd, env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' } }).toString();
const fixture = fn => { const d = mkdtempSync(join(tmpdir(), 'release-')); try { fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test('tar and zip have the expected layout and identical hashes across runs', () => fixture(d => {
  writeFileSync(join(d, 'cli'), 'synthetic executable'); writeFileSync(join(d, 'core.tar.gz'), 'synthetic core');
  for (const ext of ['tar.gz', 'zip']) {
    const a = join(d, `a.${ext}`), b = join(d, `b.${ext}`);
    const args = ['0.1.0', 'linux-x64', join(d, 'cli'), join(d, 'core.tar.gz')];
    cli('package.mjs', [...args, a]); cli('package.mjs', [...args, b]);
    assert.deepEqual(readFileSync(a), readFileSync(b));
    const list = ext === 'zip' ? execFileSync('unzip', ['-Z1', a]).toString() : execFileSync('tar', ['-tf', a]).toString();
    assert.match(list, /bin\/plur1bus/); assert.match(list, /runtime\/core.tar.gz/); assert.match(list, /licenses\/LICENSE/);
  }
}));
test('checksum format, sorting, verification and tamper rejection', () => fixture(d => {
  writeFileSync(join(d, 'z.zip'), 'z'); writeFileSync(join(d, 'a.tar.gz'), 'a');
  cli('checksums.mjs', [d]);
  const sums = readFileSync(join(d, 'SHA256SUMS'), 'utf8');
  assert.match(sums, /^[a-f0-9]{64}  a.tar.gz\n[a-f0-9]{64}  z.zip\n$/);
  cli('checksums.mjs', ['--verify', d]);
  writeFileSync(join(d, 'z.zip'), 'tampered');
  assert.notEqual(spawnSync(process.execPath, [join(root, 'scripts/release/checksums.mjs'), '--verify', d]).status, 0);
}));
test('changelog groups Conventional Commits and links PRs from a local git fixture', () => fixture(d => {
  const git = (...a) => execFileSync('git', a, { cwd: d });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('commit', '--allow-empty', '-qm', 'initial'); git('tag', 'v0.0.1');
  git('commit', '--allow-empty', '-qm', 'feat(core): add test feature (#12)');
  git('commit', '--allow-empty', '-qm', 'fix: handle errors (#13)'); git('tag', 'v0.1.0');
  const notes = cli('notes.mjs', ['v0.0.1', 'v0.1.0'], d);
  assert.match(notes, /Features/); assert.match(notes, /Fixes/); assert.match(notes, /pull\/12/);
  assert.doesNotMatch(notes, /initial/);
}));
test('packaging renderer uses fixture checksums, rejects missing targets and unsafe versions', () => fixture(d => {
  const targets = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win-x64'];
  writeFileSync(join(d, 'SHA256SUMS'), targets.map(t => `${'a'.repeat(64)}  plur1bus-0.1.0-${t}.${t === 'win-x64' ? 'zip' : 'tar.gz'}\n`).join(''));
  cli('render.mjs', ['0.1.0', join(d, 'SHA256SUMS'), join(d, 'rendered')]);
  assert.match(readFileSync(join(d, 'rendered/scoop/plur1bus.json'), 'utf8'), /"hash": "a{64}"/);
  assert.match(readFileSync(join(d, 'rendered/homebrew/plur1bus.rb'), 'utf8'), /sha256 "a{64}"/);
  assert.equal(readdirSync(join(d, 'rendered/winget')).length, 3);
  assert.notEqual(spawnSync(process.execPath, [join(root, 'scripts/release/render.mjs'), '../unsafe', join(d, 'SHA256SUMS'), d]).status, 0);
}));

test('SBOM normalization removes invocation paths and keeps reference integrity', () => fixture(d => {
  const bom = (path, id) => ({ bomFormat: 'CycloneDX', serialNumber: 'random', metadata: { timestamp: 'now', component: { name: 'cargo', 'bom-ref': id } }, components: [{ type: 'file', name: `${path}/Cargo.lock`, 'bom-ref': 'lock' }], dependencies: [{ ref: id, dependsOn: ['lock'] }] });
  const a = join(d, 'a.json'), b = join(d, 'b.json');
  writeFileSync(a, JSON.stringify(bom('/tmp/one', 'one'))); writeFileSync(b, JSON.stringify(bom('/tmp/two', 'two')));
  cli('normalize-sbom.mjs', [a, b]);
  assert.deepEqual(readFileSync(a), readFileSync(b));
  const stable = JSON.parse(readFileSync(a));
  assert.equal(stable.metadata.component['bom-ref'], stable.dependencies[0].ref);
}));
test('file timing reporter preserves TAP counts and emits a sortable file report', () => fixture(d => {
  const t = join(d, 'example.test.mjs');
  writeFileSync(t, 'import {test} from "node:test"; test("synthetic", () => {});');
  const reporter = new URL('../timing-reporter.mjs', import.meta.url).href;
  const env = { ...process.env, TEST_TIMING_DIR: d };
  delete env.NODE_TEST_CONTEXT;
  const result = execFileSync(process.execPath, ['--test', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', t], { env }).toString();
  assert.match(result, /# tests 1/);
  cli('timing-summary.mjs', [d]);
  assert.match(readFileSync(join(d, 'top-20.txt'), 'utf8'), /example.test.mjs/);
}));
test('first release changelog works without a previous tag', () => fixture(d => {
  const git = (...a) => execFileSync('git', a, { cwd: d });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('commit', '--allow-empty', '-qm', 'feat: first release');
  assert.match(cli('notes.mjs', ['--initial', 'HEAD'], d), /first release/);
}));

test('shell package/checksum wrappers and offline SBOM scanner contract', () => fixture(d => {
  const tools = join(d, 'tools'), out = join(d, 'out'); mkdirSync(tools); mkdirSync(out);
  writeFileSync(join(d, 'cli'), 'fake-linux-binary'); writeFileSync(join(d, 'core.tar.gz'), 'fake-core');
  const sh = (script, args, env = {}) => execFileSync('bash', [join(root, 'scripts/release', script), ...args], { env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000', ...env } });
  sh('package.sh', ['0.1.0', 'linux-x64', join(d, 'cli'), join(d, 'core.tar.gz'), join(out, 'plur1bus.tar.gz')]);
  sh('checksums.sh', [out]); sh('checksums.sh', ['--verify', out]);
  const syft = join(tools, 'syft');
  writeFileSync(syft, `#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
if (process.argv[2] === 'version') console.log('Version: 1.20.0');
else {
 const arg = process.argv.at(-1), name = process.argv[process.argv.indexOf('--source-name') + 1];
 if (!arg.startsWith('cyclonedx-json=')) process.exit(1);
 writeFileSync(arg.slice('cyclonedx-json='.length), JSON.stringify({bomFormat:'CycloneDX',metadata:{component:{name,'bom-ref':'root'}},components:[{name:'fixture',type:'library'}]}));
}
`, { mode: 0o755 });
  sh('sbom.sh', [out], { PATH: `${tools}:${process.env.PATH}` });
  for (const name of ['cargo', 'pnpm']) assert.equal(JSON.parse(readFileSync(join(out, `${name}.cdx.json`))).bomFormat, 'CycloneDX');
}));
test('verification checks the pinned signature identity before checksums and provenance', () => fixture(d => {
  const tools = join(d, 'tools'), out = join(d, 'out'); mkdirSync(tools); mkdirSync(out);
  const log = join(d, 'calls');
  for (const name of ['cosign', 'gh']) writeFileSync(join(tools, name), `#!/usr/bin/env node
const fs=require('node:fs'); fs.appendFileSync(process.env.VERIFY_LOG, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');
if (${JSON.stringify(name)} === 'cosign' && process.env.FAIL_SIGNATURE) process.exit(1);
`, { mode: 0o755 });
  writeFileSync(join(out, 'asset.zip'), 'fixture'); cli('checksums.mjs', [out]);
  const env = { ...process.env, PATH: `${tools}:${process.env.PATH}`, VERIFY_LOG: log };
  const run = override => spawnSync('bash', [join(root, 'scripts/release/verify.sh'), out, 'v0.1.0'], { env: { ...env, ...override } });
  assert.equal(run({}).status, 0);
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.match(lines[0], /cosign verify-blob/); assert.match(lines[0], /release.yml@refs\/tags\/v0.1.0/);
  assert.match(lines[1], /gh attestation verify/); assert.match(lines[1], /--source-ref refs\/tags\/v0.1.0/);
  writeFileSync(log, ''); assert.notEqual(run({ FAIL_SIGNATURE: '1' }).status, 0);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /gh attestation/);
  writeFileSync(log, ''); writeFileSync(join(out, 'asset.zip'), 'tampered');
  assert.notEqual(run({}).status, 0); assert.doesNotMatch(readFileSync(log, 'utf8'), /gh attestation/);
}));

test('WSL outcome gate fails exhausted setup and accepts any successful attempt', () => fixture(d => {
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const start = workflow.indexOf('      - name: report WSL setup status');
  const end = workflow.indexOf('      - if:', start);
  assert.ok(start > 0 && end > start);
  const block = workflow.slice(start, end);
  const script = block.slice(block.indexOf('        run: |\n') + '        run: |\n'.length).split('\n').map(l => l.replace(/^ {10}/, '')).join('\n');
  const file = join(d, 'gate.sh'); writeFileSync(file, script);
  for (const [outcomes, status] of [
    [['failure', 'failure', 'failure'], 1],
    [['success', 'skipped', 'skipped'], 0],
    [['failure', 'success', 'skipped'], 0],
    [['failure', 'failure', 'success'], 0],
  ]) {
    const output = join(d, 'output'); writeFileSync(output, '');
    const r = spawnSync('bash', [file], { env: { ...process.env, ATTEMPT_1: outcomes[0], ATTEMPT_2: outcomes[1], ATTEMPT_3: outcomes[2], GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(d, 'summary') } });
    assert.equal(r.status, status, outcomes.join('/'));
    assert.match(readFileSync(output, 'utf8'), status === 0 ? /ready=true/ : /ready=false/);
  }
}));
