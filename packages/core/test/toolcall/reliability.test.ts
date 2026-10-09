import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArguments, prepareCall } from '../../src/toolcall/validation.ts';
import { compileDialect } from '../../src/toolcall/dialects.ts';
import { lookupQuirks } from '../../src/toolcall/quirks.ts';
import { capResult, idempotencyKey, executeBatch } from '../../src/toolcall/results.ts';
const schema = { type: 'object', properties: { count: { type: 'integer', minimum: 1 }, 'a/b~c': { type: 'string' } }, required: ['count'], additionalProperties: false };
test('validation combines constraints, escapes pointers and fails closed on unsupported schemas', () => {
  assert.equal(validateArguments(schema, { count: 0, 'a/b~c': 2 })[1]?.path, '/a~1b~0c');
  assert.ok(validateArguments({ type: 'integer', enum: [1.5] }, 1.5).length);
  assert.throws(() => validateArguments({ contains: { type: 'string' } }, []), /unsupported/);
});
test('deterministic repairs preserve string contents and log every change', async () => {
  const result = await prepareCall('count', schema, JSON.stringify('{"count":"2","a/b~c":"x,}",}'));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.arguments, { count: 2, 'a/b~c': 'x,}' });
  assert.deepEqual(result.repairs.map(r => r.kind), ['unwrap-json-string', 'trailing-comma', 'numeric-string']);
});
test('one model repair, then typed invalid result; no execution in validator', async () => {
  let calls = 0;
  const result = await prepareCall('count', schema, '{}', async req => { calls++; assert.match(req.message, /\/count/); return '{"count":0}'; });
  assert.equal(calls, 1); assert.equal(result.ok, false); assert.equal(result.repairRounds, 1);
  if (!result.ok) assert.equal(result.error.code, 'tool-call-invalid');
  assert.equal((await prepareCall('count', schema, '{}', async () => { throw Error('secret'); })).ok, false);
});
test('valid arguments and arrays are not silently reshaped', async () => {
  assert.equal((await prepareCall('count', schema, '[2]')).ok, false);
  assert.equal((await prepareCall('count', schema, '{"count":2}')).repairRounds, 0);
  assert.equal((await prepareCall('count', schema, '{"count":"Infinity"}')).ok, false);
});
test('dialects have exact wire envelopes, name checks and strict optional nullability', () => {
  const tool = { name: 'count', description: 'Count', parameters: schema };
  for (const family of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
    const result = compileDialect(tool, family);
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
    assert.throws(() => compileDialect({ ...tool, name: 'bad.name' }, family), /name/);
  }
  const wire = compileDialect(tool, 'openai-chat').wire as { function: { parameters: { required: string[]; properties: Record<string, { type: unknown }> } } };
  assert.deepEqual(wire.function.parameters.required, ['count', 'a/b~c']);
  assert.deepEqual(wire.function.parameters.properties['a/b~c']?.type, ['string', 'null']);
  assert.equal(lookupQuirks('unknown').parallel, false);
});
test('results cap whole structures, binaries reference full result, errors omit stacks', async () => {
  const stored: unknown[] = []; const port = { async put(v: unknown) { stored.push(v); return 'result:1'; } };
  const result = await capResult({ rows: ['x'.repeat(400)] }, port, 150);
  assert.equal(result.truncated, true); assert.equal(result.reference, 'result:1'); assert.equal(stored.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 150);
  assert.equal((await capResult(new Uint8Array([1]), port)).reference, 'result:1');
});
test('idempotency keys include scope and canonical arguments; parallel results ordered, duplicates execute once', async () => {
  assert.equal(idempotencyKey('task1', 'write', { a: 1, b: 2 }), idempotencyKey('task1', 'write', { b: 2, a: 1 }));
  assert.notEqual(idempotencyKey('task1', 'write', {}), idempotencyKey('task2', 'write', {}));
  let runs = 0; const events: string[] = [];
  const executor = async (call: { name: string }) => { runs++; events.push(call.name); return call.name; };
  const calls = [{ name: 'a', arguments: {}, parallelSafe: true }, { name: 'a', arguments: {}, parallelSafe: true }, { name: 'b', arguments: {}, parallelSafe: false }];
  assert.deepEqual(await executeBatch('t', calls, executor), ['a', 'a', 'b']); assert.equal(runs, 2); assert.deepEqual(events, ['a', 'b']);
});
