import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { writeTarGz } from './archive.mjs';
import { version, files } from './common.mjs';
// ZIP uses stored entries: no compressor version, source mtime, uid or host attributes enter the bytes.
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(dir, out) {
  const chunks = [], central = []; let offset = 0;
  for (const { name, path } of files(dir)) {
    const n = Buffer.from(name), data = readFileSync(path), crc = crc32(data);
    if (data.length > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP64 is not supported');
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(33, 12); // 1980-01-01, fixed DOS date
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(33, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    chunks.push(h, n, data); central.push(c, n); offset += h.length + n.length + data.length;
  }
  const c = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(c.length, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(out, Buffer.concat([...chunks, c, end]));
}
const [v, target, binary, core, out] = process.argv.slice(2);
version(v);
if (!['linux-x64', 'linux-arm64', 'linux-x64-musl', 'darwin-arm64', 'darwin-x64', 'darwin-universal', 'win-x64'].includes(target) || !out || !core || !binary) throw new Error('usage: package.mjs VERSION TARGET BINARY CORE.tar.gz OUT.tar.gz|zip');
if (!/\.(tar.gz|zip)$/.test(out)) throw new Error('unsupported archive');
const dir = mkdtempSync(join(tmpdir(), 'p1b-package-'));
try {
  for (const p of ['bin', 'runtime', 'licenses']) mkdirSync(join(dir, p));
  const exe = join(dir, 'bin', target === 'win-x64' ? 'plur1bus.exe' : 'plur1bus');
  copyFileSync(binary, exe); chmodSync(exe, 0o755);
  copyFileSync(core, join(dir, 'runtime/core.tar.gz'));
  copyFileSync(new URL('../../LICENSE', import.meta.url), join(dir, 'licenses/LICENSE'));
  writeFileSync(join(dir, 'README.txt'), `PLUR1BUS ${v} (${target})\nRequires Node 24.21.0. Extract runtime/core.tar.gz into runtime/core. ${target === "darwin-universal" ? "Then extract the matching darwin-arm64.tar.gz or darwin-x64.tar.gz into runtime/core." : ""} ${target === "linux-x64-musl" ? "The CLI uses musl; the included Core native dependencies require a glibc environment." : ""}\nSet PLUR1BUS_CORE_JS to runtime/core/core.js and PLUR1BUS_NODE to your Node executable (absolute paths).\nOptional online setup/update uses the separately managed signed native feed; see docs/manual-release.md.\n`);
  mkdirSync(dirname(out), { recursive: true });
  if (out.endsWith('.zip')) zip(dir, out); else await writeTarGz(dir, out);
} finally { rmSync(dir, { recursive: true, force: true }); }
