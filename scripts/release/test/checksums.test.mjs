import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const script = resolve(import.meta.dirname, '../checksums.mjs');
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const fixture = fn => { const d = mkdtempSync(join(tmpdir(), 'checksums-')); try { fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test('generated SHA256SUMS verifies', () => fixture(d => {
  writeFileSync(join(d, 'plur1bus-1.0.0-linux-x64.tar.gz'), 'a');
  writeFileSync(join(d, 'SBOM.cdx.json'), 'b');
  assert.equal(run(d).status, 0);
  assert.match(readFileSync(join(d, 'SHA256SUMS'), 'utf8'), /^[a-f0-9]{64}  SBOM\.cdx\.json\n[a-f0-9]{64}  plur1bus-1\.0\.0-linux-x64\.tar\.gz\n$/);
  assert.equal(run('--verify', d).status, 0);
}));

test('a file name the verifier cannot read back is refused when the sums are written', () => fixture(d => {
  // `files` accepted spaces and non-ASCII names, `parseSums` does not: the release step succeeded and the later
  // verification of the very same SHA256SUMS failed (or, worse, the file was silently not covered).
  for (const name of ['with space.txt', 'ümlaut.txt', '-leading.txt']) {
    writeFileSync(join(d, name), 'x');
    const r = run(d);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /cannot be listed in SHA256SUMS/, name);
    rmSync(join(d, name));
  }
}));

test('verify fails on a modified file', () => fixture(d => {
  writeFileSync(join(d, 'a.txt'), 'a');
  assert.equal(run(d).status, 0);
  writeFileSync(join(d, 'a.txt'), 'tampered');
  const r = run('--verify', d);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /checksum mismatch: a\.txt/);
}));

test('tar.gz output carries the same gzip header on every platform (mtime 0, OS byte 255)', async () => {
  // zlib writes its build platform into the OS byte of the gzip header (3 on Linux, 19 on macOS, 10 on Windows), so the
  // "deterministic" archive differed by one byte between the release runners.
  const { writeTarGz } = await import('../archive.mjs');
  const d = mkdtempSync(join(tmpdir(), 'archive-gz-'));
  try {
    writeFileSync(join(d, 'f.txt'), 'x');
    const out = join(d, 'o.tar.gz');
    const digest = await writeTarGz([{ name: 'f.txt', data: 'x' }], out);
    const bytes = readFileSync(out);
    assert.deepEqual([...bytes.subarray(0, 10)], [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, bytes[8], 0xff]);
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
