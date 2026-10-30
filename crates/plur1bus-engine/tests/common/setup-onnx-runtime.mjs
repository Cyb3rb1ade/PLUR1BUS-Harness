// Test-only ONNX Runtime 1.30.0 CPU library, pinned to the Node engine's lockfile.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

export const VERSION = '1.30.0';
export const ARCHIVE = Object.freeze({
  url: 'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.30.0.tgz',
  bytes: 113507888,
  sha256: '6e3390d6b783e7be946fad629292799da28d0b42f84856e50d2c1b0383291e75',
  integrity: 'sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw==',
});
export const TARGETS = Object.freeze({
  'linux-x64': { path: 'package/bin/napi-v6/linux/x64/libonnxruntime.so.1', bytes: 45828512,
    sha256: 'ffb75a925ba05e47b235bb66e3e3911714a80b328a9c9425539feb204aa32a23' },
  'linux-arm64': { path: 'package/bin/napi-v6/linux/arm64/libonnxruntime.so.1', bytes: 25135496,
    sha256: '1f549d46250b005580b597f4164984aaf75b3bcb9f3aeb07c7f8a8fe60b23c76' },
  'darwin-arm64': { path: 'package/bin/napi-v6/darwin/arm64/libonnxruntime.1.30.0.dylib', bytes: 44589928,
    sha256: '685d2be5dba1309c89d3a5324b7fd06a5c42f1a61bfea32d14c4cc28d072121d' },
  'win32-x64': { path: 'package/bin/napi-v6/win32/x64/onnxruntime.dll', bytes: 28754232,
    sha256: '508c362f5673483dd3a086379c392795b2e42d10d5e6f3f90ebd7ac21c97af67' },
  'win32-arm64': { path: 'package/bin/napi-v6/win32/arm64/onnxruntime.dll', bytes: 29815136,
    sha256: '6c3a2abf5c6aca11c48a0d338a91af309f2266f25ce2e4084e6a87bbcb0fbfd0' },
});
const MAX_UNPACKED_BYTES = 350_000_000;
async function digestFile(path, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}
export async function verifyFile(path, expected) {
  try {
    const metadata = await stat(path);
    return metadata.isFile() && metadata.size === expected.bytes
      && await digestFile(path) === expected.sha256;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Keep only one compressed stream chunk and one 512-byte tar header in memory.
class TarReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.pending = Buffer.alloc(0); this.bytes = 0; }
  async consume(length, consume) {
    while (length > 0) {
      if (this.pending.length === 0) {
        const next = await this.iterator.next();
        if (next.done) throw new Error('truncated ONNX Runtime tar archive');
        this.bytes += next.value.length;
        if (this.bytes > MAX_UNPACKED_BYTES) throw new Error('ONNX Runtime tar exceeds extraction limit');
        this.pending = next.value;
      }
      const count = Math.min(length, this.pending.length);
      if (consume) await consume(this.pending.subarray(0, count));
      this.pending = this.pending.subarray(count); length -= count;
    }
  }
  async header() {
    const chunks = []; await this.consume(512, chunk => chunks.push(chunk)); return Buffer.concat(chunks);
  }
  async finish() {
    this.pending = Buffer.alloc(0);
    for (;;) {
      const next = await this.iterator.next(); if (next.done) return;
      this.bytes += next.value.length;
      if (this.bytes > MAX_UNPACKED_BYTES) throw new Error('ONNX Runtime tar exceeds extraction limit');
    }
  }
}
function octal(header, offset, length) {
  const text = header.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('invalid ONNX Runtime tar numeric header');
  return Number.parseInt(text, 8);
}
function tarName(header) {
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
  return prefix ? `${prefix}/${name}` : name;
}
export async function extractRuntime(archive, destination, expected) {
  const temporary = `${destination}.part-${process.pid}-${randomUUID()}`;
  const source = createReadStream(archive); const stream = createGunzip();
  source.on('error', error => stream.destroy(error)); source.pipe(stream);
  const reader = new TarReader(stream); let output; let found = false;
  try {
    output = await open(temporary, 'wx', 0o700);
    const hash = createHash('sha256');
    for (;;) {
      const header = await reader.header();
      if (header.every(byte => byte === 0)) {
        if (!(await reader.header()).every(byte => byte === 0)) throw new Error('invalid ONNX Runtime tar end marker');
        await reader.finish(); break;
      }
      const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (checksum !== octal(header, 148, 8)) throw new Error('invalid ONNX Runtime tar checksum');
      const size = octal(header, 124, 12);
      if (size > MAX_UNPACKED_BYTES) throw new Error('ONNX Runtime tar entry exceeds extraction limit');
      if (tarName(header) === expected.path) {
        if (found) throw new Error('duplicate ONNX Runtime tar member');
        if (header[156] !== 0 && header[156] !== 48) throw new Error('ONNX Runtime member must be a regular file');
        if (size !== expected.bytes) throw new Error('ONNX Runtime file size mismatch');
        found = true;
        await reader.consume(size, async chunk => { hash.update(chunk); await output.writeFile(chunk); });
      } else { await reader.consume(size); }
      await reader.consume((512 - size % 512) % 512);
    }
    if (!found) throw new Error(`ONNX Runtime archive is missing ${expected.path}`);
    if (hash.digest('hex') !== expected.sha256) throw new Error('ONNX Runtime file SHA-256 mismatch');
    await output.sync(); await output.close(); output = undefined;
    try { await rename(temporary, destination); }
    catch (error) { if (!await verifyFile(destination, expected)) throw error; }
  } finally {
    source.destroy(); stream.destroy();
    if (output) await output.close();
    await rm(temporary, { force: true });
  }
}
async function downloadArchive(path) {
  const response = await fetch(ARCHIVE.url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`ONNX Runtime archive HTTP ${response.status}`);
  const output = await open(path, 'wx', 0o600); let bytes = 0;
  const sha256 = createHash('sha256'); const sha512 = createHash('sha512');
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > ARCHIVE.bytes) throw new Error('ONNX Runtime archive exceeds pinned size');
      sha256.update(chunk); sha512.update(chunk); await output.writeFile(chunk);
    }
  } finally { await output.close(); }
  if (bytes !== ARCHIVE.bytes || sha256.digest('hex') !== ARCHIVE.sha256
      || `sha512-${sha512.digest('base64')}` !== ARCHIVE.integrity) throw new Error('ONNX Runtime archive SHA-256/SHA-512 integrity mismatch');
  console.error(`verified onnxruntime-node ${VERSION} archive: ${bytes} bytes SHA-256 ${ARCHIVE.sha256}`);
}
export async function setupRuntime({ targetDirectory, target = `${process.platform}-${process.arch}` }) {
  if (!targetDirectory) throw new Error('explicit --target-directory is required');
  const expected = TARGETS[target]; if (!expected) throw new Error(`unsupported ONNX Runtime test target: ${target}`);
  const destination = join(resolve(targetDirectory), 'ort', VERSION, target, basename(expected.path));
  if (await verifyFile(destination, expected)) return destination;
  await mkdir(dirname(destination), { recursive: true });
  const archive = join(dirname(destination), `.onnxruntime-node-${randomUUID()}.tgz`);
  try { await downloadArchive(archive); await extractRuntime(archive, destination, expected); }
  finally { await rm(archive, { force: true }); }
  if (!await verifyFile(destination, expected)) throw new Error(`ONNX Runtime file verification failed: ${destination}`);
  console.error(`verified ${target} CPU runtime SHA-256 ${expected.sha256}`);
  return destination;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index]; const value = process.argv[index + 1];
      if (!value || !['--target-directory', '--target'].includes(key)) throw new Error('usage: setup-onnx-runtime.mjs --target-directory <target> [--target <platform-arch>]');
      options[key === '--target' ? 'target' : 'targetDirectory'] = value;
    }
    console.log(await setupRuntime(options));
  } catch (error) { console.error(`ONNX Runtime test preparation failed: ${error.message}`); process.exitCode = 1; }
}
