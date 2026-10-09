import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileCatalogue, compileDialect } from '../../src/toolcall/dialects.ts';
import type { ProviderFamily } from '../../src/toolcall/quirks.ts';
import type { ToolDefinition } from '../../../providers/src/types.ts';
import { validateArguments, prepareCall } from '../../src/toolcall/validation.ts';
import { CapabilityIndex } from '../../src/toolcall/capabilities.ts';
import { capResult, executeBatch, MemoryIdempotency } from '../../src/toolcall/results.ts';
const golden = JSON.parse(readFileSync(new URL('../fixtures/tool-eval/dialects.json', import.meta.url), 'utf8')) as { input: ToolDefinition; expected: Record<ProviderFamily, unknown> };
test('independent golden wire envelopes for all four provider dialects', () => {
  for (const family of Object.keys(golden.expected) as ProviderFamily[]) assert.deepEqual(compileDialect(golden.input, family), golden.expected[family]);
});
test('constraints survive locally, dialect reductions are visible, schemas are not mutated', () => {
  const schema = { type: 'object', properties: { values: { type: 'array', items: { type: 'number', multipleOf: 2 }, uniqueItems: true } }, additionalProperties: false };
  const before = structuredClone(schema);
  const result = compileDialect({ name: 'numbers', parameters: schema }, 'gemini');
  assert.deepEqual(result.reductions.map(r => r.keyword), ['multipleOf', 'uniqueItems']);
  assert.match(JSON.stringify(result.wire), /Internal validation constraints/);
  assert.ok(validateArguments(schema, { values: [3, 3] }).length >= 2);
  assert.deepEqual(schema, before);
  assert.throws(() => compileDialect({ name: 'open', parameters: { type: 'object' } }, 'openai-chat'), /closed/);
  assert.throws(() => compileDialect(golden.input, 'gemini', { strict: true }), /unsupported/);
  assert.throws(() => compileCatalogue(Array.from({ length: 9 }, (_, i) => ({ ...golden.input, name: `t${i}` })), 'openai-chat', 'local-small'), /too many/);
});
test('unions, deep enums, null, additional schemas and Unicode string lengths', () => {
  assert.equal(validateArguments({ enum: [{ a: 1 }], type: 'object' }, { a: 1 }).length, 0);
  assert.equal(validateArguments({ type: ['string', 'null'], minLength: 2 }, null).length, 0);
  assert.equal(validateArguments({ type: 'string', maxLength: 1 }, '😀').length, 0);
  assert.ok(validateArguments({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 2).length);
  assert.ok(validateArguments({ type: 'object', additionalProperties: { type: 'boolean' } }, { unknown: 2 }).length);
  assert.ok(validateArguments({ type: 'null' }, false).length);
});
test('prototype keys preserved safely, malformed JSON stays invalid, repair never sees stack', async () => {
  const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"number"}},"additionalProperties":false}');
  const r = await prepareCall('proto', schema, '{"__proto__":"2"}'); assert.equal(r.ok, true);
  if (r.ok) assert.equal(Object.getPrototypeOf(r.arguments), Object.prototype);
  assert.equal((await prepareCall('proto', schema, '{broken}')).ok, false);
  const error = await capResult(Error('token-secret'), { async put() { return 'x'; } }); assert.ok(!JSON.stringify(error).includes('token-secret'));
});
test('category proportions, embedding tie break, low confidence and live registration', () => {
  const index = new CapabilityIndex({ score: (_, entries) => new Map(entries.map(e => [e.id, e.id === 'b0' ? 1 : 0])) });
  for (const c of ['a', 'b']) for (let i = 0; i < 12; i++) index.upsert({ id: `${c}${i}`, name: `${c}${i}`, description: 'test entry', category: `${c}.tools`, kind: 'tool', effect: 'read', risk: 'low', source: 'fixture', version: '1' });
  const route = index.route('test', { 'a.tools': .7, 'b.tools': .3 });
  assert.equal(route.items.filter(i => i.entry.category === 'a.tools').length, 8);
  assert.equal(route.items.filter(i => i.entry.category === 'b.tools').length, 4);
  assert.equal(index.search('test', { category: 'b.tools' })[0]?.entry.id, 'b0');
  assert.ok(index.route('test', { 'a.tools': .99, 'b.tools': .01 }, 12, .4).hint);
  let notify: ((e: { upsert?: Parameters<CapabilityIndex['upsert']>[0]; remove?: string }) => void) | undefined;
  let disposed = false;
  const disconnect = index.connect({ snapshot: () => [], subscribe(fn) { notify = fn; return () => { disposed = true; }; } });
  notify?.({ upsert: { id: 'new', name: 'New skill', description: 'Recently installed', category: 'a.tools', kind: 'skill', effect: 'read', risk: 'low', source: 'fixture', version: '2' } });
  assert.equal(index.search('Recently installed', { kind: 'skill' })[0]?.entry.id, 'new'); disconnect(); assert.equal(disposed, true);
});
test('parallel calls overlap but unsafe barrier waits and repeat port deduplicates across batches', async () => {
  let release: (() => void) | undefined; const gate = new Promise<void>(r => { release = r; }); const order: string[] = [];
  const calls = [{ name: 'a', arguments: {}, parallelSafe: true }, { name: 'b', arguments: {}, parallelSafe: true }, { name: 'c', arguments: {}, parallelSafe: false }];
  const port = new MemoryIdempotency();
  const execute = async (c: { name: string }) => { order.push(c.name); if (c.name === 'a') await gate; if (c.name === 'b') release!(); return c.name; };
  assert.deepEqual(await executeBatch('task', calls, execute, port), ['a', 'b', 'c']);
  await executeBatch('task', calls, execute, port); assert.deepEqual(order, ['a', 'b', 'c']);
});
test('non-JSON, cyclic and nonfinite arguments rejected before any repair or hashing', async () => {
  const cycle: Record<string, unknown> = {}; cycle['self'] = cycle;
  assert.ok(validateArguments({ type: 'object' }, cycle).length);
  assert.ok(validateArguments({ type: 'object' }, new Date()).length);
  assert.ok(validateArguments({ type: 'number' }, Infinity).length);
  assert.equal((await prepareCall('x', { type: 'object' }, cycle)).ok, false);
});
test('taxonomy prefix stable when installations introduce categories', async () => {
  const { CATEGORIES } = await import('../../src/toolcall/categories.ts'); assert.ok(CATEGORIES.length >= 80);
  const index = new CapabilityIndex(); const before = index.categoriesPrefix();
  index.upsert({ id: 'x', name: 'x', description: 'custom', category: 'custom.category', kind: 'extension', effect: 'read', risk: 'low', source: 'test', version: '1' });
  assert.equal(index.categoriesPrefix(), before); assert.equal(index.search('custom')[0]?.entry.id, 'x');
});
test('strict optional null restoration preserves authored nullable fields', async () => {
  const { restoreStrictArguments } = await import('../../src/toolcall/dialects.ts');
  const schema = { type: 'object', properties: { optional: { type: 'string' }, nullable: { type: ['string', 'null'] }, required: { type: ['string', 'null'] } }, required: ['required'] };
  assert.deepEqual(restoreStrictArguments(schema, { optional: null, nullable: null, required: null }), { nullable: null, required: null });
});
test('quirks drive the deterministic repair repertoire', async () => {
  const schema = { type: 'object', properties: { x: { type: 'number' } }, additionalProperties: false };
  const result = await prepareCall('x', schema, '{"x":"2",}', undefined, 'openai-responses');
  assert.equal(result.ok, false); assert.deepEqual(result.repairs, []);
});
test('structured dispatcher errors retain their error status and code without stacks', async () => {
  const result = await capResult({ isError: true, error: { code: 'tool-denied', hint: 'Choose another tool.\nRequest permission.', stack: 'private' } }, { async put() { return 'result:1'; } });
  assert.equal(result.isError, true); assert.equal(result.error?.code, 'tool-denied'); assert.equal(result.error?.hint.includes('\n'), false); assert.ok(!JSON.stringify(result).includes('private'));
});
