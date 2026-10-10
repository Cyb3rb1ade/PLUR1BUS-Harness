import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, chmodSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const COMPLETIONS = [
  ['bash', 'plur1bus.bash'],
  ['zsh', '_plur1bus'],
  ['fish', 'plur1bus.fish'],
  ['powershell', 'plur1bus.ps1'],
];

export function targetRunsOnHost(target, platform = process.platform, arch = process.arch) {
  if (target === 'darwin-universal') return platform === 'darwin';
  if (target === 'linux-x64-musl') return false;
  const hostTarget = {
    linux: { x64: 'linux-x64', arm64: 'linux-arm64' },
    darwin: { x64: 'darwin-x64', arm64: 'darwin-arm64' },
    win32: { x64: 'win-x64' },
  }[platform]?.[arch];
  return target === hostTarget;
}

export function hostBinary(target, binary, { platform = process.platform, arch = process.arch, buildHost } = {}) {
  if (targetRunsOnHost(target, platform, arch)) return binary;
  if (buildHost) return buildHost();
  execFileSync('cargo', ['build', '--locked', '--release', '-p', 'plur1bus'], { cwd: ROOT, stdio: 'inherit' });
  const targetDir = process.env.CARGO_TARGET_DIR ? resolve(ROOT, process.env.CARGO_TARGET_DIR) : join(ROOT, 'target');
  const host = join(targetDir, 'release', `plur1bus${platform === 'win32' ? '.exe' : ''}`);
  if (!existsSync(host)) throw new Error(`host CLI was not built at ${host}`);
  return host;
}

export function generateAssets(cli, dir, run = execFileSync) {
  const completions = join(dir, 'completions');
  const man1 = join(dir, 'man', 'man1');
  mkdirSync(completions, { recursive: true });
  mkdirSync(man1, { recursive: true });
  for (const [shell, name] of COMPLETIONS) {
    writeFileSync(join(completions, name), run(cli, ['completions', shell], { encoding: 'utf8' }));
  }
  run(cli, ['__manpages', man1], { stdio: 'ignore' });
}

export async function packageArchive(v, target, binary, core, out, assets) {
  version(v);
  if (!['linux-x64', 'linux-arm64', 'linux-x64-musl', 'darwin-arm64', 'darwin-x64', 'darwin-universal', 'win-x64'].includes(target) || !out || !core || !binary) {
    throw new Error('usage: package.mjs VERSION TARGET BINARY CORE.tar.gz OUT.tar.gz|zip [ASSETS_DIR]');
  }
  if (!/\.(tar.gz|zip)$/.test(out)) throw new Error('unsupported archive');
  const dir = mkdtempSync(join(tmpdir(), 'p1b-package-'));
  try {
    for (const p of ['bin', 'runtime', 'licenses', 'completions', 'man/man1']) mkdirSync(join(dir, p), { recursive: true });
    const exe = join(dir, 'bin', target === 'win-x64' ? 'plur1bus.exe' : 'plur1bus');
    copyFileSync(binary, exe); chmodSync(exe, 0o755);
    copyFileSync(core, join(dir, 'runtime/core.tar.gz'));
    copyFileSync(new URL('../../LICENSE', import.meta.url), join(dir, 'licenses/LICENSE'));
    if (assets) {
      cpSync(join(assets, 'completions'), join(dir, 'completions'), { recursive: true });
      cpSync(join(assets, 'man'), join(dir, 'man'), { recursive: true });
    } else {
      generateAssets(hostBinary(target, binary), dir);
    }
    writeFileSync(join(dir, 'README.txt'), `PLUR1BUS ${v} (${target})\nRequires Node 24.21.0. Extract runtime/core.tar.gz into runtime/core. ${target === "darwin-universal" ? "Then extract the matching darwin-arm64.tar.gz or darwin-x64.tar.gz into runtime/core." : ""} ${target === "linux-x64-musl" ? "The CLI uses musl; the included Core native dependencies require a glibc environment." : ""}\nSet PLUR1BUS_CORE_JS to runtime/core/core.js and PLUR1BUS_NODE to your Node executable (absolute paths).\nOptional online setup/update uses the separately managed signed native feed; see docs/manual-release.md.\n`);
    mkdirSync(dirname(out), { recursive: true });
    if (out.endsWith('.zip')) zip(dir, out); else await writeTarGz(dir, out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [v, target, binary, core, out, assets] = process.argv.slice(2);
    await packageArchive(v, target, binary, core, out, assets);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
