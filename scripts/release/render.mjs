import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { version, parseSums, files, REPO } from './common.mjs';
const [v, manifest, out] = process.argv.slice(2);
version(v);
if (!manifest || !out) throw new Error('usage: render.mjs VERSION SHA256SUMS OUT');
const sums = parseSums(readFileSync(manifest, 'utf8'));
const values = { VERSION: v, BASE: `https://github.com/${REPO}/releases/download/v${v}` };
for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win-x64']) {
  const name = `plur1bus-${v}-${target}.${target === 'win-x64' ? 'zip' : 'tar.gz'}`;
  const sum = sums.get(name);
  if (!sum) throw new Error(`missing checksum: ${name}`);
  values[`SHA_${target}`] = sum;
}
const root = fileURLToPath(new URL('../../packaging/', import.meta.url));
for (const { path, name } of files(root)) {
  if (!name.endsWith('.in')) continue;
  for (const arch of name.startsWith('nfpm/') ? ['amd64', 'arm64'] : ['']) {
    const text = readFileSync(path, 'utf8').replace(/@([A-Za-z0-9_-]+)@/g, (_, key) => {
      if (key === 'ARCH') return arch;
      if (!values[key]) throw new Error(`unknown placeholder ${key}`);
      return values[key];
    });
    const dest = join(out, name.replace(/\.in$/, '').replace('nfpm.yaml', `nfpm-${arch}.yaml`));
    mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, text);
  }
}
