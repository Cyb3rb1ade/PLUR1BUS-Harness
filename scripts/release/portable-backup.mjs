// Portable M8 backup: the ordinary verified backup and owner-readable vault values
// share one authenticated encrypted stream. No secret value is an argv or log field.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, openSync, closeSync, writeSync, readSync, fstatSync, fsyncSync, lstatSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('P1BACK01');
const HEADER = 52; // magic, 32-byte salt, 12-byte nonce; fixed KDF parameters in v1
const MAX_VAULT = 16 * 1024 * 1024;
const fail = () => new Error('portable backup failed; no secret or child-process output is reported');
const key = (password, salt) => scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
function writeAll(fd, data) { for (let n = 0; n < data.length;) n += writeSync(fd, data, n, data.length - n); }
function validateVault(vault) {
  if (!Array.isArray(vault) || vault.length > 10000) throw fail();
  const names = new Set();
  for (const entry of vault) {
    if (!entry || typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(entry.name) || names.has(entry.name)
      || typeof entry.value !== 'string' || !entry.value || Buffer.byteLength(entry.value) > 65536) throw fail();
    names.add(entry.name);
  }
  return vault;
}
export function readPassword(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || (process.platform !== 'win32' && (info.mode & 0o077))) throw fail();
  const password = readFileSync(path);
  if (password.length < 16) throw fail();
  return password; // exact bytes, including any newline; never an argument or environment variable
}
export async function encryptBackup(archive, vault, destination, password) {
  validateVault(vault);
  const raw = Buffer.from(JSON.stringify(vault));
  if (raw.length > MAX_VAULT) throw fail();
  const salt = randomBytes(32), nonce = randomBytes(12);
  const header = Buffer.concat([MAGIC, salt, nonce]);
  const derived = key(password, salt);
  const cipher = createCipheriv('aes-256-gcm', derived, nonce);
  derived.fill(0); cipher.setAAD(header);
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(raw.length));
  async function* plaintext() { yield length; yield raw; yield* createReadStream(archive); }
  let fd, failed = false;
  try {
    fd = openSync(destination, 'wx', 0o600);
    writeAll(fd, header);
    const source = Readable.from(plaintext());
    source.on('error', error => cipher.destroy(error));
    for await (const chunk of source.pipe(cipher)) writeAll(fd, chunk);
    writeAll(fd, cipher.getAuthTag()); fsyncSync(fd);
  } catch {
    failed = true; throw fail();
  } finally { raw.fill(0); if (fd !== undefined) { closeSync(fd); if (failed) rmSync(destination, { force: true }); } }
}
// Authenticate the complete stream before any destination-home mutation. Only the
// ordinary tar archive reaches scratch disk; vault plaintext stays in memory.
export async function decryptBackup(source, archive, password) {
  let input, output, failed = false;
  try {
    input = openSync(source, 'r');
    const size = fstatSync(input).size;
    if (size < HEADER + 16 + 8) throw fail();
    const header = Buffer.alloc(HEADER); readSync(input, header, 0, HEADER, 0);
    if (!header.subarray(0, 8).equals(MAGIC)) throw fail();
    const tag = Buffer.alloc(16); readSync(input, tag, 0, 16, size - 16);
    const derived = key(password, header.subarray(8, 40));
    const decipher = createDecipheriv('aes-256-gcm', derived, header.subarray(40));
    derived.fill(0); decipher.setAAD(header); decipher.setAuthTag(tag);
    output = openSync(archive, 'wx', 0o600);
    let prefix = Buffer.alloc(0), length, vault;
    const inputStream = createReadStream(source, { start: HEADER, end: size - 17 });
    inputStream.on('error', error => decipher.destroy(error));
    const stream = inputStream.pipe(decipher);
    for await (let chunk of stream) {
      if (vault === undefined) {
        prefix = Buffer.concat([prefix, chunk]);
        if (length === undefined && prefix.length >= 8) {
          const n = prefix.readBigUInt64LE();
          if (n > BigInt(MAX_VAULT)) throw fail();
          length = Number(n);
        }
        if (length === undefined || prefix.length < length + 8) continue;
        vault = validateVault(JSON.parse(prefix.subarray(8, length + 8).toString('utf8')));
        chunk = Buffer.from(prefix.subarray(length + 8)); prefix.fill(0); prefix = Buffer.alloc(0);
      }
      writeAll(output, chunk);
    }
    if (vault === undefined) throw fail();
    fsyncSync(output); return vault;
  } catch { failed = true; throw fail(); }
  finally { if (input !== undefined) closeSync(input); if (output !== undefined) { closeSync(output); if (failed) rmSync(archive, { force: true }); } }
}
function command(bin, home, args, input) {
  const r = spawnSync(bin, ['--json', '--home', home, ...args], { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  if (r.error || r.status !== 0) throw fail();
  try { return JSON.parse(r.stdout); } catch { throw fail(); }
}
function vaultOf(call) {
  return validateVault(call(['secret', 'ls']).secrets.map(({ name }) => ({ name, value: call(['secret', 'get', name, '--reveal']).value })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
class RestoreFailure extends Error {
  constructor(rollback, rolledBack) {
    super(`portable restore ${rolledBack ? 'failed and was rolled back' : 'and rollback failed'}; encrypted recovery artifact: ${rollback}`);
    this.rollback = rollback; this.rolledBack = rolledBack;
  }
}
function setVault(call, entries) {
  for (const { name, value } of entries) call(['secret', 'set', name], value + '\n');
  const keep = new Set(entries.map(e => e.name));
  for (const { name } of call(['secret', 'ls']).secrets) if (!keep.has(name)) call(['secret', 'rm', name, '--yes']);
}
export async function runPortable({ operation, bin, home, file, password, dryRun = false, execute = command }) {
  const scratch = mkdtempSync(join(tmpdir(), 'p1b-portable-'));
  const archive = join(scratch, 'state.tar.gz');
  const call = (args, input) => execute(bin, home, args, input);
  try {
    if (operation === 'create') {
      const before = vaultOf(call);
      const report = call(['backup', 'create', '--out', archive]);
      call(['backup', 'verify', archive]);
      if (JSON.stringify(before) !== JSON.stringify(vaultOf(call))) throw fail();
      const plan = { units: report.units, secrets: before.map(e => e.name) };
      if (!dryRun) await encryptBackup(archive, before, file, password);
      return { schema: 'portable-backup/1', operation, dryRun, plan };
    }
    const entries = await decryptBackup(file, archive, password);
    const verified = call(['backup', 'verify', archive]);
    const plan = { units: verified.units, secrets: entries.map(e => e.name) };
    if (operation === 'verify' || dryRun) return { schema: 'portable-backup/1', operation, dryRun, plan };
    if (operation !== 'restore') throw fail();
    // The target is an installed, running home. Persist an encrypted rollback
    // artifact before mutation; retain it until the owner explicitly removes it.
    const original = vaultOf(call), rollbackArchive = join(scratch, 'rollback.tar.gz');
    call(['backup', 'create', '--out', rollbackArchive]);
    const rollback = `${file}.rollback-${randomBytes(8).toString('hex')}`;
    await encryptBackup(rollbackArchive, original, rollback, password);
    try {
      call(['daemon', 'stop']);
      call(['backup', 'restore', '--yes', archive]);
      call(['daemon', 'start']);
      setVault(call, entries);
      if (JSON.stringify(vaultOf(call)) !== JSON.stringify(entries)) throw fail();
    } catch {
      try {
        call(['daemon', 'stop']); call(['backup', 'restore', '--yes', rollbackArchive]); call(['daemon', 'start']); setVault(call, original);
      } catch { throw new RestoreFailure(rollback, false); }
      throw new RestoreFailure(rollback, true);
    }
    return { schema: 'portable-backup/1', operation, dryRun, plan, rollback };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (!['create', 'verify', 'restore'].includes(operation)) throw fail();
  const o = { operation, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') { o.dryRun = true; continue; }
    const field = { '--bin': 'bin', '--home': 'home', '--file': 'file', '--passphrase-file': 'passwordFile' }[args[i]];
    if (!field || !args[i + 1] || Object.hasOwn(o, field)) throw fail();
    o[field] = resolve(args[++i]);
  }
  if (!o.bin || !o.home || !o.file || !o.passwordFile) throw fail();
  const password = readPassword(o.passwordFile);
  try { console.log(JSON.stringify(await runPortable({ ...o, password }))); } finally { password.fill(0); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ error: 'portable-backup-failed', ...(error instanceof RestoreFailure ? { rollback: error.rollback, rolledBack: error.rolledBack } : {}) })); process.exitCode = 1; });
