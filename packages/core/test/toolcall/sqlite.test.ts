import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCapabilityRegistry } from '../../src/toolcall/sqlite-registry.ts';
import { CapabilityIndex } from '../../src/toolcall/capabilities.ts';
test('persistent registry survives restart; updates/disable/remove route immediately, agent stats separate', () => {
  const home = mkdtempSync(join(tmpdir(), 'toolcall-index-')); const path = join(home, 'index.sqlite');
  let registry = new SqliteCapabilityRegistry(path);
  try {
    const index = new CapabilityIndex(); const disconnect = index.connect(registry);
    const entry = { id: 'skill', name: 'make_report', description: 'Create document report', category: 'docs.create', kind: 'skill' as const, effect: 'read' as const, risk: 'low' as const, source: 'synthetic', version: '1' };
    registry.upsert(entry); assert.equal(index.search('report')[0]?.entry.id, 'skill');
    registry.record('skill', 'agent1', 'offered'); registry.record('skill', 'agent1', 'used'); registry.record('skill', 'agent1', 'succeeded');
    assert.equal(registry.stats('skill', 'agent2').used, 0);
    disconnect(); registry.close(); registry = new SqliteCapabilityRegistry(path);
    assert.equal(registry.snapshot()[0]?.version, '1'); assert.equal(registry.stats('skill', 'agent1').used, 1);
    const index2 = new CapabilityIndex(); index2.connect(registry);
    registry.upsert({ ...entry, version: '2', enabled: false }); assert.equal(index2.search('report').length, 0);
    registry.remove('skill'); assert.equal(registry.snapshot().length, 0);
  } finally { registry.close(); rmSync(home, { recursive: true, force: true }); }
});
test('a file registry writes ahead: a commit does not wait for the disk', () => {
  // The first turn of an agent upserts every tool in its own transaction; with the rollback journal each one cost about
  // four fsyncs (6 to 8 s of a blocked core on the Windows CI runner's C:). WAL is a property of the file, so a second
  // connection sees it; synchronous=NORMAL belongs to the registry's connection.
  const home = mkdtempSync(join(tmpdir(), 'toolcall-index-')); const path = join(home, 'capabilities.sqlite');
  const registry = new SqliteCapabilityRegistry(path);
  try {
    for (let i = 0; i < 3; i++) registry.upsert({ id: `tool:${i}`, name: `tool_${i}`, description: `Tool ${i}`, category: 'ops.system', kind: 'tool', effect: 'read', risk: 'low', source: 'turn:x', version: '1' });
    assert.ok(existsSync(`${path}-wal`), 'commits go to the write-ahead log');
    const other = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(other.prepare('PRAGMA journal_mode').get()?.['journal_mode'], 'wal'); } finally { other.close(); }
    assert.equal(registry.snapshot().length, 3);
  } finally { registry.close(); rmSync(home, { recursive: true, force: true }); }
});
