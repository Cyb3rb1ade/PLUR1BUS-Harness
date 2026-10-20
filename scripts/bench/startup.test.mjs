import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startup, markdown, pollHealthy } from './startup.mjs';
test('missing executable produces a failed machine report', async () => {
  const r = await startup({ bin: '/missing/plur1bus-perf-test' });
  assert.equal(r.errors.length, 1);
  assert.equal(r.results.length, 0);
  assert.match(markdown(r), /ERROR:/);
});

const ready = { process: { state: 'ready' }, engine: { ready: true, degraded: null } };
const loading = { process: { state: 'ready' }, engine: { ready: false, degraded: null } };
const stall = () => Object.assign(new Error('core.status timed out'), { reason: 'call-timeout' });
const clock = (step) => { let n = 0; return () => (n += step); };

test('a core.status call-timeout is a counted stall, not a failure: polling goes on until the core is healthy', async () => {
  const script = [stall(), loading, stall(), stall(), ready];
  const calls = [];
  const r = await pollHealthy({ call: async (method, params, timeoutMs) => { calls.push([method, timeoutMs]); const v = script.shift(); if (v instanceof Error) throw v; return v; }, timeoutMs: 900_000, pauseMs: 0, now: clock(1) });
  assert.equal(r.stalls, 3);
  assert.deepEqual(script, []);
  assert.deepEqual(calls[0], ['core.status', 5000]);
});

test('a stalled core that never recovers fails at the startup timeout, with the stalls counted', async () => {
  let n = 0;
  await assert.rejects(pollHealthy({ call: async () => { n++; throw stall(); }, timeoutMs: 100, pauseMs: 0, now: clock(30) }), (e) => {
    assert.match(e.message, /healthy core timeout/);
    assert.equal(e.stalls, n);
    return true;
  });
  assert.ok(n >= 2, 'it polled again after the first stall');
});

test('any other error still fails at once: only a call-timeout is a stall', async () => {
  let n = 0;
  const closed = Object.assign(new Error('connection closed'), { reason: 'closed' });
  await assert.rejects(pollHealthy({ call: async () => { n++; throw closed; }, timeoutMs: 900_000, pauseMs: 0, now: clock(1) }), (e) => e === closed);
  assert.equal(n, 1);
});

test('the report names the stalls so the advisory run shows what it measured', () => {
  const report = { target: 't', methodology: 'm', results: [], errors: [], stalls: { warmup: 2, measured: 1, limitMs: 5000 } };
  assert.match(markdown(report), /core\.status stalls[^\n]*warm-up 2[^\n]*measured 1/);
  assert.doesNotMatch(markdown({ ...report, stalls: undefined }), /stalls/);
});
