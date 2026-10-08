import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const REPO = 'Cyb3rb1ade/PLUR1BUS-Harness';
export function version(v) {
  if (!/^\d+\.\d+\.\d+(?:-(?:rc|beta)[.\w-]*)?$/.test(v ?? '')) throw new Error('expected semver (optional rc/beta prerelease)');
  return v;
}
export const sha256 = p => createHash('sha256').update(readFileSync(p)).digest('hex');
export function files(dir, prefix = '') {
  return readdirSync(dir).sort().flatMap(n => {
    const path = join(dir, n), name = prefix + n, st = lstatSync(path);
    if (st.isSymbolicLink()) throw new Error(`symlink refused: ${name}`);
    if (st.isDirectory()) return files(path, `${name}/`);
    if (!st.isFile() || /[\r\n\\]/.test(name)) throw new Error(`invalid file: ${name}`);
    return [{ path, name }];
  });
}
export function parseSums(text) {
  const result = new Map();
  for (const line of text.trim().split('\n')) {
    const m = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(line);
    if (!m || m[2].split('/').includes('..') || result.has(m[2])) throw new Error('invalid or duplicate checksum entry');
    result.set(m[2], m[1]);
  }
  return result;
}
