import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AUDIT_PENDING_SAMPLE, createAuditHealth, readAuditHealth, type RotatedSummaries } from '../../src/audit/health.ts';
import { legacyReadAuditHealth } from './legacy-health.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const HEX0 = '0'.repeat(64);
const dir0 = () => mkdtempSync(join(tmpdir(), 'gp5-health-cache-'));
const rec = (action: string, at: number, user = 'owner') => ({ at, actor: { user, host: 'h' }, action, target: 't' });
// Builds chain lines (not a valid chain; health only observes the tail) numbered from `from`.
function lines(from: number, actions: string[], eol = '\n'): string {
  let prev = HEX0, out = '';
  actions.forEach((a, i) => { const l = JSON.stringify({ seq: from + i, prev, rec: rec(a, 1000 + from + i, `u${from + i}`) }); out += l + eol; prev = sha(l); });
  return out;
}
const rot = (n: number) => `audit-chain.${String(n).padStart(10, '0')}.jsonl`;
// The cached reader must equal the legacy full scan; only `pending` differs by design (newest sample).
const same = (dir: string, cache: RotatedSummaries, now = 5) => {
  const got = readAuditHealth(dir, now, cache), want = legacyReadAuditHealth(dir, now);
  assert.deepEqual({ ...got, pending: undefined }, { ...want, pending: undefined });
  assert.equal(JSON.stringify(got.pending), JSON.stringify(want.pending.slice(-AUDIT_PENDING_SAMPLE)));
  return got;
};

test('cached reader equals the legacy full scan on a multi-era fixture', () => {
  const dir = dir0(), cache: RotatedSummaries = new Map();
  same(dir, cache); // empty directory
  writeFileSync(join(dir, rot(1)), lines(1, ['a', 'audit.chain.anchor-advanced', 'b']));
  writeFileSync(join(dir, rot(2)), lines(4, ['c', 'audit.chain.reanchored', 'd'], '\r\n') + 'torn evidence without newline');
  writeFileSync(join(dir, rot(3)), 'not json\n{"rec":5}\n[1]\n' + lines(7, ['audit.chain.anchor-advanced']) + '\n\n');
  writeFileSync(join(dir, rot(4)), 'only damage\n');
  writeFileSync(join(dir, rot(5)), '');
  writeFileSync(join(dir, 'audit-chain.jsonl'), lines(8, ['e', 'f']));
  const a = same(dir, cache); // missing anchor
  assert.equal(a.reason, 'anchor-missing');
  assert.equal(a.lastAnchorAdvanced?.actor?.user, 'u7'); assert.equal(a.lastReanchor?.actor?.user, 'u5');
  assert.equal(cache.size, 5);
  const act = lines(8, ['e', 'f']).split('\n');
  writeFileSync(join(dir, 'audit-chain.anchor'), JSON.stringify({ v: 1, seq: 8, hash: sha(act[0]!) }));
  same(dir, cache);
  writeFileSync(join(dir, 'audit-chain.anchor'), 'broken'); same(dir, cache);
  writeFileSync(join(dir, 'audit-chain.pending.jsonl'), JSON.stringify({ pendingDropped: 3 }) + '\nmalformed\n' + JSON.stringify({ ...rec('audit.config.set', 9), chainReason: 'anchor-invalid' }) + '\n');
  same(dir, cache);
  // the active file changes between reads while rotated files stay cached
  writeFileSync(join(dir, 'audit-chain.jsonl'), lines(8, ['e', 'f', 'audit.chain.reanchored', 'g']));
  const b = same(dir, cache); assert.equal(b.lastReanchor?.actor?.user, 'u10');
  // the active file and a rotated file disappear (the cache entry is dropped)
  unlinkSync(join(dir, 'audit-chain.jsonl')); unlinkSync(join(dir, rot(3)));
  same(dir, cache); assert.equal(cache.size, 4); assert(!cache.has(rot(3)));
  // a fresh cache gives the same answer as a warm one
  assert.deepEqual(readAuditHealth(dir, 5, new Map()), readAuditHealth(dir, 5, cache));
});

test('a rotated file replaced under the same name is re-read when size or mtime differ', () => {
  const dir = dir0(), cache: RotatedSummaries = new Map(), p = join(dir, rot(1));
  writeFileSync(p, lines(1, ['audit.chain.anchor-advanced', 'x']));
  assert.equal(same(dir, cache).lastAnchorAdvanced?.actor?.user, 'u1');
  writeFileSync(p, lines(1, ['y', 'audit.chain.anchor-advanced', 'z'])); // different size
  assert.equal(same(dir, cache).lastAnchorAdvanced?.actor?.user, 'u2');
  const before = statSync(p);
  writeFileSync(p, readFileSync(p, 'utf8').replace('u2', 'u9')); // same size, new mtime
  utimesSync(p, before.atimeMs / 1000, before.mtimeMs / 1000 + 5);
  assert.equal(same(dir, cache).lastAnchorAdvanced?.actor?.user, 'u9');
});

test('an unchanged rotated file is not read again (its summary is reused)', () => {
  const dir = dir0(), cache: RotatedSummaries = new Map(), p = join(dir, rot(1));
  writeFileSync(p, lines(1, ['audit.chain.anchor-advanced']));
  const st = statSync(p);
  assert.equal(readAuditHealth(dir, 1, cache).lastAnchorAdvanced?.actor?.user, 'u1');
  writeFileSync(p, lines(1, ['audit.chain.anchor-advanced']).replace('u1', 'u2')); // same size, same mtime, same inode
  utimesSync(p, st.atimeMs / 1000, st.mtimeMs / 1000);
  assert.equal(readAuditHealth(dir, 2, cache).lastAnchorAdvanced?.actor?.user, 'u1');
  assert.equal(readAuditHealth(dir, 3, new Map()).lastAnchorAdvanced?.actor?.user, 'u2');
});

test('pending is a bounded newest sample; the total is preserved', () => {
  const dir = dir0();
  const n = AUDIT_PENDING_SAMPLE * 3 + 7;
  const rows = Array.from({ length: n }, (_, i) => JSON.stringify({ ...rec('audit.config.set', i), chainReason: 'anchor-invalid', detail: { secret: 'must-not-escape' } }));
  writeFileSync(join(dir, 'audit-chain.pending.jsonl'), JSON.stringify({ pendingDropped: 4 }) + '\n' + rows.join('\n') + '\n');
  const s = createAuditHealth({ dir }).status();
  assert.equal(s.pendingLines, n); assert.equal(s.pendingDropped, 4);
  assert.equal(s.pending.length, AUDIT_PENDING_SAMPLE);
  assert.equal(s.pending[0]?.at, n - AUDIT_PENDING_SAMPLE); assert.equal(s.pending.at(-1)?.at, n - 1);
  assert(!JSON.stringify(s).includes('must-not-escape'));
  // a short journal is returned whole; malformed rows count and show as unknown
  writeFileSync(join(dir, 'audit-chain.pending.jsonl'), 'junk\n' + rows[0] + '\n');
  const t = createAuditHealth({ dir }).status();
  assert.equal(t.pendingLines, 2); assert.deepEqual(t.pending.map(p => p.action), ['unknown', 'audit.config.set']);
});
