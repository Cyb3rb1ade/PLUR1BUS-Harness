// Evidence integrity is distinct from release acceptance. No network/CI polling,
// no arbitrary commands read from Markdown, and missing evidence fails closed.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CHECKS = {
  'backup-crypto': ['--test', 'scripts/release/test/portable-backup.test.mjs'],
  'source-quality': ['scripts/release/check-source-quality.mjs'],
  'theme-regression': ['--test', 'scripts/release/test/source-quality.test.mjs'],
  'attribution-drift': ['scripts/release/third-party.mjs', '--check'],
};
const STATUSES = ['erfüllt', 'offen', 'manuell'];
export function validateEvidence(markdown, root = ROOT) {
  const match = /<!-- release-evidence:start -->\s*```json\s*([\s\S]*?)```\s*<!-- release-evidence:end -->/.exec(markdown);
  if (!match) throw new Error('missing release evidence block');
  const doc = JSON.parse(match[1]);
  if (doc.schema !== 'plur1bus.release-evidence/1' || !Array.isArray(doc.items) || doc.items.length !== 14 || !Array.isArray(doc.localProofs)) throw new Error('expected all 14 checklist items and localProofs');
  const ids = new Set();
  for (const row of [...doc.items, ...doc.localProofs]) {
    if (ids.has(row.id) || !STATUSES.includes(row.status) || !Array.isArray(row.evidence) || !row.evidence.length) throw new Error('duplicate id, invalid status or empty evidence');
    ids.add(row.id);
    if (row.status === 'erfüllt' && (!Array.isArray(row.checks) || !row.checks.length)) throw new Error('fulfilled evidence requires executable local checks; remote/manual proof remains explicit');
    for (const check of row.checks || []) if (!Object.hasOwn(CHECKS, check)) throw new Error('unknown local check');
    for (const pointer of row.evidence) {
      if (typeof pointer !== 'string') throw new Error('invalid evidence pointer');
      if (pointer.startsWith('https://')) {
        const url = new URL(pointer); if (url.username || url.password) throw new Error('credential-bearing evidence URL');
        continue; // presence only: never infer a green remote job from a URL
      }
      const path = resolve(root, pointer);
      if (!existsSync(path)) throw new Error(`missing local evidence: ${pointer}`);
      const rel = relative(realpathSync(root), realpathSync(path));
      if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('evidence escapes repository');
    }
  }
  for (let id = 1; id <= 14; id++) if (!doc.items.some(row => row.id === id)) throw new Error(`missing checklist item ${id}`);
  for (const row of doc.items) {
    const line = markdown.split('\n').find(l => l.startsWith(`| ${row.id} |`));
    if (!line || !line.includes(`| ${row.status} |`)) throw new Error(`table and machine status differ for item ${row.id}`);
  }
  return doc;
}
export function main(args = process.argv.slice(2)) {
  if (args.some(a => !['--run-local', '--strict'].includes(a))) throw new Error('usage: check-checklist.mjs [--run-local] [--strict]');
  const doc = validateEvidence(readFileSync(resolve(ROOT, 'docs/release-checklist-v0.1.0.md'), 'utf8'));
  const checks = [...new Set([...doc.items, ...doc.localProofs].flatMap(row => row.checks || []))];
  const results = {};
  if (args.includes('--run-local')) for (const id of checks) {
    const r = spawnSync(process.execPath, CHECKS[id], { cwd: ROOT, stdio: 'inherit' });
    results[id] = !r.error && r.status === 0;
  }
  const localGreen = checks.length > 0 && checks.every(id => results[id] === true);
  const releaseReady = localGreen && doc.items.every(row => row.status === 'erfüllt');
  console.log(JSON.stringify({ schema: 'release-checklist-check/1', evidenceValid: true, localChecks: args.includes('--run-local') ? results : 'not-executed', open: doc.items.filter(r => r.status === 'offen').map(r => r.id), manual: doc.items.filter(r => r.status === 'manuell').map(r => r.id), releaseReady }));
  return Object.values(results).includes(false) || (args.includes('--strict') && !releaseReady) ? 1 : 0;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { process.exitCode = main(); } catch (e) { console.error(`checklist: ${e.message}`); process.exitCode = 1; }
}
