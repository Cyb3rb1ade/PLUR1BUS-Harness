// Make a Tauri-built .deb depend only on its contents and SOURCE_DATE_EPOCH.
//
// tauri-bundler (2.10) never reads SOURCE_DATE_EPOCH: it stamps the ar members and every tar entry of
// control.tar.gz and data.tar.gz with the modification time of the staged files, i.e. the build's wall
// clock, and walks the staging directories in readdir order. Two builds of identical sources therefore
// differ in nothing but those timestamps (and, in principle, the entry order). This rewrites the three ar
// members with mtime = SOURCE_DATE_EPOCH, uid/gid 0, entries sorted by name and a fixed gzip stream. File
// contents, modes, names and the member order (debian-binary, control, data) are kept byte for byte.
// Pure Node, no dpkg: the unit tests run on every desktop runner.
import {gunzipSync, gzipSync} from 'node:zlib';
import {readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const AR_MAGIC = Buffer.from('!<arch>\n', 'latin1');
const BLOCK = 512;
const GNU_MAGIC = Buffer.from('ustar  \0', 'latin1');
const POSIX_MAGIC = Buffer.from('ustar\0', 'latin1');
const MAX_EPOCH = 0o77777777777; // the largest value a tar mtime field holds

export function parseEpoch(value) {
  if (typeof value !== 'string' || !/^\d{1,11}$/.test(value)) throw new Error('deb-source-date-epoch-invalid');
  const epoch = Number(value);
  if (epoch > MAX_EPOCH) throw new Error('deb-source-date-epoch-invalid');
  return epoch;
}

function cString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
}

function octal(bytes, label) {
  if (bytes[0] & 0x80) throw new Error(`deb-tar-${label}-unsupported`);
  const text = cString(bytes).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`deb-tar-${label}-invalid`);
  return Number.parseInt(text, 8);
}

export function parseAr(buffer) {
  if (buffer.length < AR_MAGIC.length || !buffer.subarray(0, AR_MAGIC.length).equals(AR_MAGIC)) {
    throw new Error('deb-not-an-ar-archive');
  }
  const members = [];
  let at = AR_MAGIC.length;
  while (at < buffer.length) {
    if (at + 60 > buffer.length || buffer.subarray(at + 58, at + 60).toString('latin1') !== '`\n') {
      throw new Error('deb-ar-header-invalid');
    }
    const field = (from, to) => buffer.subarray(at + from, at + to).toString('latin1').trim();
    const name = field(0, 16);
    if (name.startsWith('#1/') || (name.startsWith('/') && name.length > 1)) throw new Error('deb-ar-long-name-unsupported');
    const sizeText = field(48, 58);
    if (!/^\d+$/.test(sizeText)) throw new Error('deb-ar-header-invalid');
    const size = Number(sizeText);
    if (at + 60 + size > buffer.length) throw new Error('deb-ar-truncated');
    members.push({
      name: name.endsWith('/') ? name.slice(0, -1) : name,
      mode: field(40, 48) || '100644',
      data: buffer.subarray(at + 60, at + 60 + size),
    });
    at += 60 + size + (size % 2);
  }
  return members;
}

export function buildAr(members, epoch) {
  const parts = [AR_MAGIC];
  for (const member of members) {
    const header = Buffer.alloc(60, 0x20);
    const put = (offset, text, width) => {
      const bytes = Buffer.from(text, 'latin1');
      if (bytes.length > width) throw new Error('deb-ar-field-too-long');
      bytes.copy(header, offset);
    };
    put(0, member.name, 16);
    put(16, String(epoch), 12);
    put(28, '0', 6);
    put(34, '0', 6);
    put(40, member.mode, 8);
    put(48, String(member.data.length), 10);
    header.write('`\n', 58, 'latin1');
    parts.push(header, member.data);
    if (member.data.length % 2) parts.push(Buffer.from('\n', 'latin1'));
  }
  return Buffer.concat(parts);
}

export function parseTar(buffer) {
  const entries = [];
  let at = 0;
  let longName = null;
  let longLink = null;
  while (at + BLOCK <= buffer.length) {
    const head = buffer.subarray(at, at + BLOCK);
    if (head.every((byte) => byte === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : head[i];
    if (octal(head.subarray(148, 156), 'checksum') !== sum) throw new Error('deb-tar-checksum-invalid');
    const size = octal(head.subarray(124, 136), 'size');
    const type = String.fromCharCode(head[156]);
    if (at + BLOCK + size > buffer.length) throw new Error('deb-tar-truncated');
    const body = Buffer.from(buffer.subarray(at + BLOCK, at + BLOCK + size));
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') { longName = cString(body); continue; }
    if (type === 'K') { longLink = cString(body); continue; }
    if (type === 'x' || type === 'g') throw new Error('deb-tar-pax-unsupported');
    let name = cString(head.subarray(0, 100));
    if (head.subarray(257, 263).equals(POSIX_MAGIC)) {
      const prefix = cString(head.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }
    entries.push({
      name: longName ?? name,
      type,
      mode: octal(head.subarray(100, 108), 'mode'),
      linkname: longLink ?? cString(head.subarray(157, 257)),
      data: body,
    });
    longName = null;
    longLink = null;
  }
  return entries;
}

function tarHeader({name, type, mode, linkname, size}, mtime) {
  const head = Buffer.alloc(BLOCK, 0);
  const text = (offset, value, width) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    if (bytes.length > width) throw new Error('deb-tar-field-too-long');
    bytes.copy(head, offset);
  };
  const number = (offset, value, width) => {
    const digits = value.toString(8).padStart(width - 1, '0');
    if (digits.length > width - 1) throw new Error('deb-tar-field-too-long');
    head.write(`${digits}\0`, offset, 'latin1');
  };
  text(0, name, 100);
  number(100, mode, 8);
  number(108, 0, 8);
  number(116, 0, 8);
  number(124, size, 12);
  number(136, mtime, 12);
  head.fill(0x20, 148, 156);
  head.write(type, 156, 'latin1');
  text(157, linkname, 100);
  GNU_MAGIC.copy(head, 257);
  number(329, 0, 8);
  number(337, 0, 8);
  let sum = 0;
  for (const byte of head) sum += byte;
  head.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return head;
}

function padBlock(bytes) {
  const rest = bytes.length % BLOCK;
  return rest === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(BLOCK - rest, 0)]);
}

// GNU long name (L) and long link (K) records: the real header carries the first 100 bytes, the record the rest.
function longRecord(type, bytes, mtime) {
  const body = Buffer.concat([bytes, Buffer.from([0])]);
  return [tarHeader({name: '././@LongLink', type, mode: 0, linkname: '', size: body.length}, mtime), padBlock(body)];
}

export function writeTar(entries, epoch, {sort = true} = {}) {
  const keyed = entries.map((entry) => ({entry, name: Buffer.from(entry.name, 'utf8'), link: Buffer.from(entry.linkname, 'utf8')}));
  if (sort) keyed.sort((a, b) => Buffer.compare(a.name, b.name));
  const parts = [];
  for (const {entry, name, link} of keyed) {
    if (name.length > 100) parts.push(...longRecord('L', name, epoch));
    if (link.length > 100) parts.push(...longRecord('K', link, epoch));
    parts.push(tarHeader({
      name: name.subarray(0, 100),
      type: entry.type,
      mode: entry.mode,
      linkname: link.subarray(0, 100),
      size: entry.data.length,
    }, epoch));
    if (entry.data.length) parts.push(padBlock(entry.data));
  }
  parts.push(Buffer.alloc(2 * BLOCK, 0));
  return Buffer.concat(parts);
}

export function normalizeTarGz(buffer, epoch) {
  return gzipSync(writeTar(parseTar(gunzipSync(buffer)), epoch), {level: 9});
}

export function normalizeDeb(buffer, epoch) {
  const members = parseAr(buffer);
  const names = members.map((member) => member.name);
  if (names[0] !== 'debian-binary' || names.length !== 3 || !/^control\.tar\./.test(names[1]) || !/^data\.tar\./.test(names[2])) {
    throw new Error('deb-members-unexpected');
  }
  return buildAr(
    members.map((member) => {
      if (!/\.tar\./.test(member.name)) return member;
      if (!member.name.endsWith('.tar.gz')) throw new Error('deb-member-compression-unsupported');
      return {...member, data: normalizeTarGz(member.data, epoch)};
    }),
    epoch,
  );
}

export async function normalizeDebFile(path, epoch) {
  const before = await readFile(path);
  const after = normalizeDeb(before, epoch);
  if (before.equals(after)) return false;
  const staged = `${path}.normalize-${process.pid}`;
  try {
    await writeFile(staged, after);
    await rename(staged, path);
  } finally {
    await rm(staged, {force: true});
  }
  return true;
}

// Where `tauri build` leaves the .deb files: <target dir>/[<triple>/]<release|debug>/bundle/deb.
export function debBundleDirectory({root, args, env}) {
  const own = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length);
  let triple = null;
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === '--target' || own[i] === '-t') triple = own[i + 1] ?? null;
    else if (own[i].startsWith('--target=')) triple = own[i].slice('--target='.length);
  }
  const targetDir = env.CARGO_TARGET_DIR ? resolve(root, env.CARGO_TARGET_DIR) : join(root, 'target');
  const profile = own.includes('--debug') || own.includes('-d') ? 'debug' : 'release';
  return join(targetDir, ...(triple ? [triple] : []), profile, 'bundle', 'deb');
}

// Called by scripts/tauri.mjs after a successful `tauri build`. Does nothing unless SOURCE_DATE_EPOCH is set.
export async function normalizeBuiltDebs({root, args, env = process.env}) {
  if (args[0] !== 'build' || env.SOURCE_DATE_EPOCH === undefined) return [];
  const epoch = parseEpoch(env.SOURCE_DATE_EPOCH);
  const directory = debBundleDirectory({root, args, env});
  const names = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const done = [];
  for (const name of names.filter((entry) => entry.endsWith('.deb')).sort()) {
    await normalizeDebFile(join(directory, name), epoch);
    done.push(join(directory, name));
  }
  return done;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const epoch = parseEpoch(process.env.SOURCE_DATE_EPOCH);
    const files = process.argv.slice(2);
    if (!files.length) throw new Error('usage: SOURCE_DATE_EPOCH=<seconds> node normalize-deb.mjs <file.deb>...');
    for (const file of files) await normalizeDebFile(file, epoch);
  } catch (error) {
    console.error(`normalize-deb: ${error.message}`);
    process.exitCode = 1;
  }
}
