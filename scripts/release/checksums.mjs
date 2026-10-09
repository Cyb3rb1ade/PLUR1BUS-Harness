import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { files, parseSums, sha256 } from './common.mjs';
const args = process.argv.slice(2), verify = args[0] === '--verify', dir = args[verify ? 1 : 0];
if (!dir) throw new Error('usage: checksums.mjs [--verify] DIRECTORY');
if (verify) {
  for (const [name, sum] of parseSums(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'))) {
    if (sha256(join(dir, name)) !== sum) throw new Error(`checksum mismatch: ${name}`);
  }
} else {
  const list = files(dir).filter(f => !/(^|\/)SHA256SUMS(?:\.|$)/.test(f.name) && !/\.(sig|pem|sigstore.json|intoto.jsonl)$/.test(f.name));
  if (!list.length) throw new Error('no release files');
  writeFileSync(join(dir, 'SHA256SUMS'), list.map(f => `${sha256(f.path)}  ${f.name}\n`).join(''));
}
