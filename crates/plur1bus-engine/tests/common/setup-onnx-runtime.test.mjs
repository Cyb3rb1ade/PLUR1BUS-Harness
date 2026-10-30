import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { extractRuntime, verifyFile } from './setup-onnx-runtime.mjs';

const data = Buffer.from('abc');
const expected = { path: 'package/bin/napi-v6/linux/x64/libonnxruntime.so.1', bytes: 3,
  sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' };
function entry(path, bytes, type = '0') {
  const header = Buffer.alloc(512); header.write(path); header.write('0000700\0', 100);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156); header.write(type, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
async function scratch(run) {
  const directory = await mkdtemp(join(tmpdir(), 'plur1bus-ort-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function archive(directory, entries) {
  const path = join(directory, 'fixture.tgz');
  await writeFile(path, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
  return path;
}
test('verifyFile checks exact bytes and SHA-256', () => scratch(async directory => {
  const file = join(directory, 'runtime'); await writeFile(file, data);
  assert.equal(await verifyFile(file, expected), true);
  await writeFile(file, Buffer.from('bad'));
  assert.equal(await verifyFile(file, expected), false);
  assert.equal(await verifyFile(join(directory, 'missing'), expected), false);
}));
test('extractRuntime extracts only the selected regular file and verifies its digest', () => scratch(async directory => {
  const path = await archive(directory, [entry('../../outside', Buffer.from('ignored')), entry(expected.path, data)]);
  const output = join(directory, 'runtime');
  await extractRuntime(path, output, expected);
  assert.deepEqual(await readFile(output), data);
  assert.deepEqual((await readdir(directory)).sort(), ['fixture.tgz', 'runtime']);
}));
test('extractRuntime refuses a same-size file with the wrong digest and removes partial output', () => scratch(async directory => {
  const path = await archive(directory, [entry(expected.path, Buffer.from('bad'))]);
  await assert.rejects(extractRuntime(path, join(directory, 'runtime'), expected), /SHA-256/);
  assert.deepEqual(await readdir(directory), ['fixture.tgz']);
}));
test('extractRuntime refuses a truncated tar stream', () => scratch(async directory => {
  const path = join(directory, 'fixture.tgz');
  await writeFile(path, gzipSync(entry(expected.path, data).subarray(0, 514)));
  await assert.rejects(extractRuntime(path, join(directory, 'runtime'), expected), /truncated/i);
}));
test('extractRuntime refuses a selected symlink rather than following it', () => scratch(async directory => {
  const path = await archive(directory, [entry(expected.path, data, '2')]);
  await assert.rejects(extractRuntime(path, join(directory, 'runtime'), expected), /regular file/);
}));
test('extractRuntime refuses duplicate selected members', () => scratch(async directory => {
  const path = await archive(directory, [entry(expected.path, data), entry(expected.path, data)]);
  await assert.rejects(extractRuntime(path, join(directory, 'runtime'), expected), /duplicate/);
}));
