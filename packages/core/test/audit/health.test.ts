import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditChain } from '../../src/audit/chain.ts';
import { createAuditHealth, projectAuditStatus } from '../../src/audit/health.ts';

const row = (action = 'audit.chain.anchor-advanced') => ({ at: 42, actor: { user: 'owner', host: 'host' }, action,
  target: 'audit-chain', detail: { fromSeq: 1, toSeq: 2, writer: 'core', confidential: 'must-not-escape' } });
const fixture = () => mkdtempSync(join(tmpdir(), 'gp5-health-'));

test('empty chain is readable without verifying it and exposes no details', () => {
  const health = createAuditHealth({ dir: fixture(), clock: () => 100, ttlMs: 30 });
  const status = health.status();
  assert.equal(status.state, 'ok'); assert.equal(status.lastSeq, 0);
  assert.equal(status.pendingLines, 0); assert.equal(status.lastVerifiedAt, null);
});

test('tail/anchor refusal is cached for TTL and status never repairs evidence', () => {
  const dir = fixture(); let now = 100;
  createAuditChain({ dir }).append(row());
  const h = createAuditHealth({ dir, clock: () => now, ttlMs: 30 });
  assert.equal(h.status().lastSeq, 1);
  const anchor = join(dir, 'audit-chain.anchor');
  writeFileSync(anchor, 'broken');
  assert.equal(h.status().state, 'ok');
  now = 131;
  assert.equal(h.status().state, 'refusing'); assert.equal(h.status().reason, 'anchor-invalid');
  assert.equal(readFileSync(anchor, 'utf8'), 'broken');
});

test('missing anchor refuses nonempty chain, but a one-line trailing anchor remains healable', () => {
  const dir = fixture(); const chain = createAuditChain({ dir }); chain.append(row());
  const anchor = readFileSync(join(dir, 'audit-chain.anchor'), 'utf8');
  chain.append(row()); writeFileSync(join(dir, 'audit-chain.anchor'), anchor);
  assert.equal(createAuditHealth({ dir }).status().state, 'ok');
  unlinkSync(join(dir, 'audit-chain.anchor'));
  assert.equal(createAuditHealth({ dir }).status().reason, 'anchor-missing');
});

test('pending and recovery views contain metadata only; journal header is not a pending row', () => {
  const dir = fixture(); const chain = createAuditChain({ dir }); chain.append(row()); chain.append(row('audit.chain.reanchored'));
  writeFileSync(join(dir, 'audit-chain.pending.jsonl'), JSON.stringify({ pendingDropped: 2 }) + '\n' + JSON.stringify({ ...row('audit.config.set'), chain: 'refused', chainReason: 'anchor-invalid' }) + '\n');
  const s = createAuditHealth({ dir }).status();
  assert.equal(s.pendingLines, 1); assert.equal(s.pendingDropped, 2);
  assert.deepEqual(s.lastAnchorAdvanced, { at: 42, actor: { user: 'owner', host: 'host' } });
  assert.deepEqual(s.lastReanchor, { at: 42, actor: { user: 'owner', host: 'host' } });
  assert.equal(s.pending[0]?.action, 'audit.config.set');
  assert(!JSON.stringify(s).includes('must-not-escape'));
});

test('only a completed successful explicit verification updates its timestamp', () => {
  const dir = fixture(); const h = createAuditHealth({ dir, clock: () => 123 });
  h.verified(false); assert.equal(h.status().lastVerifiedAt, null);
  h.verified(true); assert.equal(h.status().lastVerifiedAt, 123);
});

test('audit health is omitted for every principal except human Owner/Admin', () => {
  const status = { process: { state: 'ready' }, audit: { internal: 'private' } };
  for (const role of ['operator', 'member', 'viewer']) assert.equal('audit' in projectAuditStatus(status, { kind: 'person', role }), false);
  assert.equal('audit' in projectAuditStatus(status, { kind: 'agent', role: 'owner' }), false);
  assert.equal('audit' in projectAuditStatus(status, null), false);
  for (const role of ['owner', 'admin']) assert.deepEqual(projectAuditStatus(status, { kind: 'person', role }), status);
});

test('successful explicit verification survives restart; failed verification never overwrites it', () => {
  const dir = fixture();
  createAuditHealth({ dir, clock: () => 123 }).verified(true);
  const restarted = createAuditHealth({ dir, clock: () => 456 });
  assert.equal(restarted.status().lastVerifiedAt, 123);
  restarted.verified(false);
  assert.equal(createAuditHealth({ dir }).status().lastVerifiedAt, 123);
});

test('status preserves torn evidence byte for byte and does not create verification metadata', () => {
  const dir = fixture(); createAuditChain({ dir }).append(row());
  const file = join(dir, 'audit-chain.jsonl');
  const torn = readFileSync(file, 'utf8') + 'torn confidential evidence';
  writeFileSync(file, torn);
  const s = createAuditHealth({ dir }).status();
  assert.equal(s.lastSeq, 1); assert.equal(s.lastVerifiedAt, null);
  assert.equal(readFileSync(file, 'utf8'), torn);
});

test('a diagnostic-only token cannot read audit metadata even with the owner role', () => {
  const s = projectAuditStatus({ process: { state: 'ready' }, audit: {} }, { kind: 'person', role: 'owner', tokenScopes: ['doctor.read'] });
  assert.equal('audit' in s, false);
});

test('a matching newest tail is an append-health observation, never a claim that history was verified', () => {
  const dir = fixture(), chain = createAuditChain({ dir });
  chain.append(row()); chain.append(row()); chain.append(row());
  const file = join(dir, 'audit-chain.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8').replace('must-not-escape', 'older-tampering'));
  assert.equal(chain.verify().ok, false);
  const s = createAuditHealth({ dir }).status();
  assert.equal(s.state, 'ok'); assert.equal(s.lastVerifiedAt, null);
});

test('a malformed complete newest row takes precedence over a separately broken anchor', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'audit-chain.jsonl'), 'malformed\n');
  writeFileSync(join(dir, 'audit-chain.anchor'), 'broken');
  assert.equal(createAuditHealth({ dir }).status().reason, 'tail-malformed');
});
