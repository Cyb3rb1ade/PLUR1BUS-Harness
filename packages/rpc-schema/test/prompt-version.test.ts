import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('prompt import/export additions use their allocated Harness RPC 1.22 minor', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/rpc.schema.json', import.meta.url), 'utf8'));
  const capabilities = JSON.parse(readFileSync(new URL('../fixtures/capabilities/core.json', import.meta.url), 'utf8'));
  for (const name of ['memory.importText.preview', 'memory.importText.apply', 'memory.importText.rollback', 'memory.exportText']) {
    assert.equal(schema.$defs.methods[name]['x-since'], '1.22.0', name);
    assert.equal(capabilities.methods[name].since, '1.22.0', name);
  }
  for (const name of ['ParsedMemoryEntry', 'MemoryEntryTarget']) {
    assert.equal(schema.$defs[name]['x-since'], '1.22.0', name);
    assert.match(schema.$defs[name].description, /^1\.22\.0:/, name);
  }
  assert.equal(schema['x-rpc-version'], '1.27.0');
});
