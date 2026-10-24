import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync, gzipSync} from 'node:zlib';
import {
  buildAr, debBundleDirectory, normalizeBuiltDebs, normalizeDeb, normalizeTarGz, parseAr, parseEpoch, parseTar, writeTar,
} from '../normalize-deb.mjs';

const EPOCH = 1792539764;
const LONG = `usr/share/${'d'.repeat(60)}/${'f'.repeat(60)}/file.txt`;

// Entries as tauri-bundler writes them: GNU headers, the staging directory's wall-clock mtime, readdir order.
function entries() {
  return [
    {name: 'usr', type: '5', mode: 0o755, linkname: '', data: Buffer.alloc(0)},
    {name: 'usr/bin', type: '5', mode: 0o755, linkname: '', data: Buffer.alloc(0)},
    {name: 'usr/bin/app', type: '0', mode: 0o755, linkname: '', data: Buffer.from('binary-bytes')},
    {name: 'usr/bin/app-link', type: '2', mode: 0o777, linkname: 'app', data: Buffer.alloc(0)},
    {name: LONG, type: '0', mode: 0o644, linkname: '', data: Buffer.from('x'.repeat(1000))},
    {name: 'usr/share/ünïcode.txt', type: '0', mode: 0o644, linkname: '', data: Buffer.from('odd')},
  ];
}
function debWith({clock, order}) {
  const list = order === 'reverse' ? entries().reverse() : entries();
  const control = writeTar([{name: 'control', type: '0', mode: 0o644, linkname: '', data: Buffer.from('Package: demo\n')}], clock, {sort: false});
  const data = writeTar(list, clock, {sort: false});
  // Timestamps and ordering vary; contents never do. gzip level differs too, as a different build host's zlib could.
  return buildAr([
    {name: 'debian-binary', mode: '100644', data: Buffer.from('2.0\n')},
    {name: 'control.tar.gz', mode: '100644', data: gzipSync(control, {level: 1})},
    {name: 'data.tar.gz', mode: '100644', data: gzipSync(data, {level: 6})},
  ], clock);
}

test('control tars of two real Tauri builds differ only in mtimes and normalise to the same bytes', async () => {
  const [one, two] = await Promise.all(
    [1, 2].map((n) => readFile(new URL(`./fixtures/tauri-control-build-${n}.tar.gz`, import.meta.url))),
  );
  assert.notDeepEqual(one, two);
  assert.deepEqual(parseTar(gunzipSync(one)).map((e) => [e.name, e.data.toString('latin1')]), parseTar(gunzipSync(two)).map((e) => [e.name, e.data.toString('latin1')]));
  const first = normalizeTarGz(one, EPOCH);
  assert.deepEqual(first, normalizeTarGz(two, EPOCH));
  const parsed = parseTar(gunzipSync(first));
  assert.deepEqual(parsed.map((e) => e.name), ['control', 'md5sums']);
  assert.match(parsed[0].data.toString(), /^Package: plur1bus\n/);
  assert.equal(parsed[0].mode, 0o644);
});

test('a .deb is identical across build times and entry order, and keeps names, modes, links and bytes', () => {
  const early = debWith({clock: 1000000000, order: 'forward'});
  const late = debWith({clock: 1700000000, order: 'reverse'});
  assert.notDeepEqual(early, late);
  const a = normalizeDeb(early, EPOCH);
  const b = normalizeDeb(late, EPOCH);
  assert.deepEqual(a, b);
  assert.deepEqual(normalizeDeb(a, EPOCH), a, 'normalising twice changes nothing');
  assert.notDeepEqual(normalizeDeb(early, EPOCH + 1), a, 'the epoch is the only input besides the contents');

  const members = parseAr(a);
  assert.deepEqual(members.map((m) => m.name), ['debian-binary', 'control.tar.gz', 'data.tar.gz']);
  assert.equal(members[0].data.toString(), '2.0\n');
  const rows = parseTar(gunzipSync(members[2].data));
  const names = rows.map((r) => r.name);
  assert.deepEqual(names, [...names].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))));
  const byName = new Map(rows.map((r) => [r.name, r]));
  assert.equal(byName.get('usr/bin/app').data.toString(), 'binary-bytes');
  assert.equal(byName.get('usr/bin/app').mode, 0o755);
  assert.equal(byName.get('usr/bin/app-link').type, '2');
  assert.equal(byName.get('usr/bin/app-link').linkname, 'app');
  assert.equal(byName.get(LONG).data.length, 1000);
  assert.equal(byName.get('usr/share/ünïcode.txt').data.toString(), 'odd');
});

test('every ar member and tar entry carries SOURCE_DATE_EPOCH and root ownership', () => {
  const out = normalizeDeb(debWith({clock: 1234567890, order: 'forward'}), EPOCH);
  const header = out.subarray(8, 68).toString('latin1');
  assert.equal(header.slice(16, 28).trim(), String(EPOCH));
  assert.equal(header.slice(28, 34).trim(), '0');
  assert.equal(header.slice(34, 40).trim(), '0');
  for (const member of parseAr(out).slice(1)) {
    const raw = gunzipSync(member.data);
    for (let at = 0; at + 512 <= raw.length; ) {
      const head = raw.subarray(at, at + 512);
      if (head.every((byte) => byte === 0)) break;
      assert.equal(Number.parseInt(head.subarray(136, 147).toString('latin1'), 8), EPOCH);
      assert.equal(Number.parseInt(head.subarray(108, 115).toString('latin1'), 8), 0);
      assert.equal(Number.parseInt(head.subarray(116, 123).toString('latin1'), 8), 0);
      assert.equal(head.subarray(265, 329).every((byte) => byte === 0), true, 'no user or group names');
      at += 512 + Math.ceil(Number.parseInt(head.subarray(124, 135).toString('latin1'), 8) / 512) * 512;
    }
  }
});

test('the system tar and ar read what was written, when they exist', async (t) => {
  const probe = (cmd, args) => spawnSync(cmd, args, {encoding: 'utf8'});
  if (probe('tar', ['--version']).status !== 0 || probe('ar', ['--version']).status !== 0) {
    t.skip('tar or ar is not installed on this runner');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'normalize-deb-'));
  try {
    const deb = join(root, 'a.deb');
    await writeFile(deb, normalizeDeb(debWith({clock: 1000000000, order: 'forward'}), EPOCH));
    await mkdir(join(root, 'x'));
    // ar x extracts into the working directory, so run it inside the scratch directory.
    const here = spawnSync('ar', ['x', deb], {cwd: join(root, 'x'), encoding: 'utf8'});
    assert.equal(here.status, 0, here.stderr);
    // GNU tar reads a colon before the first slash in an archive name as host:file (a Windows C:\ path), so
    // name the members relative to the scratch directory; bsdtar is fine either way.
    const listed = spawnSync('tar', ['-tzf', 'data.tar.gz'], {cwd: join(root, 'x'), encoding: 'utf8'});
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(listed.stdout.split(/\r?\n/).includes(LONG), listed.stdout);
    const control = spawnSync('tar', ['-xzOf', 'control.tar.gz', 'control'], {cwd: join(root, 'x'), encoding: 'utf8'});
    assert.equal(control.stdout, 'Package: demo\n');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('input it cannot rewrite faithfully is refused, never guessed', () => {
  assert.throws(() => normalizeDeb(Buffer.from('not a deb'), EPOCH), /deb-not-an-ar-archive/);
  const xz = buildAr([
    {name: 'debian-binary', mode: '100644', data: Buffer.from('2.0\n')},
    {name: 'control.tar.xz', mode: '100644', data: Buffer.from('x')},
    {name: 'data.tar.xz', mode: '100644', data: Buffer.from('x')},
  ], 1);
  assert.throws(() => normalizeDeb(xz, EPOCH), /deb-member-compression-unsupported/);
  const odd = buildAr([{name: 'debian-binary', mode: '100644', data: Buffer.from('2.0\n')}], 1);
  assert.throws(() => normalizeDeb(odd, EPOCH), /deb-members-unexpected/);
  const pax = Buffer.alloc(1024);
  pax.write('pax_header', 0);
  pax.write('00000000000\0', 124, 'latin1');
  pax.write('x', 156, 'latin1');
  pax.write('ustar\0', 257, 'latin1');
  let sum = 8 * 0x20;
  for (let i = 0; i < 512; i += 1) if (i < 148 || i >= 156) sum += pax[i];
  pax.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  assert.throws(() => parseTar(pax), /deb-tar-pax-unsupported/);
  const damaged = Buffer.from(writeTar(entries(), 1));
  damaged[3] ^= 0xff;
  assert.throws(() => parseTar(damaged), /deb-tar-checksum-invalid/);
  for (const bad of ['', 'abc', '-1', '1.5', '999999999999', undefined]) assert.throws(() => parseEpoch(bad), /deb-source-date-epoch-invalid/);
  assert.equal(parseEpoch('0'), 0);
});

test('only a build with SOURCE_DATE_EPOCH is touched, and only the .deb files it produced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'normalize-deb-'));
  try {
    const dir = debBundleDirectory({root, args: ['build', '--bundles', 'deb', '--', '--locked'], env: {}});
    assert.equal(dir, join(root, 'target', 'release', 'bundle', 'deb'));
    assert.equal(debBundleDirectory({root, args: ['build', '--debug'], env: {}}), join(root, 'target', 'debug', 'bundle', 'deb'));
    assert.equal(
      debBundleDirectory({root, args: ['build', '--target', 'x86_64-unknown-linux-gnu', '--', '--target', 'ignored'], env: {CARGO_TARGET_DIR: 'out'}}),
      join(root, 'out', 'x86_64-unknown-linux-gnu', 'release', 'bundle', 'deb'),
    );
    const elsewhere = join(root, 'elsewhere');
    assert.equal(debBundleDirectory({root, args: ['build'], env: {CARGO_TARGET_DIR: elsewhere}}), join(elsewhere, 'release', 'bundle', 'deb'));

    await mkdir(dir, {recursive: true});
    const raw = debWith({clock: 1000000000, order: 'forward'});
    await writeFile(join(dir, 'PLUR1BUS.deb'), raw);
    await writeFile(join(dir, 'notes.txt'), 'leave alone');
    const args = ['build', '--bundles', 'deb'];
    assert.deepEqual(await normalizeBuiltDebs({root, args, env: {}}), []);
    assert.deepEqual(await readFile(join(dir, 'PLUR1BUS.deb')), raw, 'no epoch, no change');
    assert.deepEqual(await normalizeBuiltDebs({root, args: ['dev'], env: {SOURCE_DATE_EPOCH: String(EPOCH)}}), []);
    assert.deepEqual(await normalizeBuiltDebs({root, args, env: {SOURCE_DATE_EPOCH: String(EPOCH)}}), [join(dir, 'PLUR1BUS.deb')]);
    assert.deepEqual(await readFile(join(dir, 'PLUR1BUS.deb')), normalizeDeb(raw, EPOCH));
    assert.equal(await readFile(join(dir, 'notes.txt'), 'utf8'), 'leave alone');
    await assert.rejects(normalizeBuiltDebs({root, args, env: {SOURCE_DATE_EPOCH: 'yesterday'}}), /deb-source-date-epoch-invalid/);
    assert.deepEqual(await normalizeBuiltDebs({root: join(root, 'missing'), args, env: {SOURCE_DATE_EPOCH: String(EPOCH)}}), []);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
