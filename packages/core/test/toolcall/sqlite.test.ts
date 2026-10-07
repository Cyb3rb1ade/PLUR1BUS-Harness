import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
