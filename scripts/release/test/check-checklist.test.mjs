import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateEvidence } from '../check-checklist.mjs';
const document = doc => doc.items.map(r => `| ${r.id} | ${r.status} | example | proof |`).join('\n') + '\n<!-- release-evidence:start -->\n```json\n' + JSON.stringify(doc) + '\n```\n<!-- release-evidence:end -->';
test('checklist rejects missing, escaped, duplicated and unsupported evidence and false fulfilled status', () => {
  const base = mkdtempSync(join(tmpdir(), 'checklist-test-')), root = join(base, 'repo'); mkdirSync(root);
  writeFileSync(join(root, 'proof'), 'proof'); writeFileSync(join(base, 'outside'), 'outside');
  const valid = { schema: 'plur1bus.release-evidence/1', items: Array.from({ length: 14 }, (_, i) => ({ id: i + 1, status: 'offen', evidence: ['proof'] })), localProofs: [] };
  try {
    assert.equal(validateEvidence(document(valid), root).items.length, 14);
    for (const change of [
      d => { d.items[0].evidence = ['missing']; },
      d => { d.items[0].evidence = ['../outside']; },
      d => { d.items[1].id = 1; },
      d => { d.items[0].status = 'erfüllt'; },
      d => { d.items[0].checks = ['arbitrary-shell-command']; },
      d => { d.items[0].status = 'green'; },
      d => { d.items.pop(); },
    ]) { const d = structuredClone(valid); change(d); assert.throws(() => validateEvidence(document(d), root)); }
    assert.throws(() => validateEvidence(document(valid).replace('| 1 | offen |', '| 1 | erfüllt |'), root), /table/);
    assert.throws(() => validateEvidence('no machine block', root));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
test('strict mode fails while the checked-in release has open or manual criteria', () => {
  const script = fileURLToPath(new URL('../check-checklist.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--strict'], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr); const report = JSON.parse(r.stdout.trim());
  assert.equal(report.evidenceValid, true); assert.equal(report.releaseReady, false); assert.ok(report.open.length); assert.ok(report.manual.length);
});
