import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createCallBudget, CallBudgetExceededError } from '../../src/budget/calls.ts';
import { allocateContext, checkZones, DEFAULT_ZONE_POLICY } from '../../src/budget/context.ts';
import { RetryBudget, RetryBudgetExceededError } from '../../src/budget/retry.ts';
import { capSubagentResult, estimateResultTokens } from '../../src/budget/subagent.ts';
import { mediaCostMicros, PriceBook } from '../../src/budget/prices.ts';
import { periodBounds } from '../../src/budget/period.ts';
import { open, PRICES_V1 } from './helpers.ts';

const request = { principal: 'u1', project: 'p1', agent: 'a1', model: 'm-small', estimatedInputTokens: 30, maxOutputTokens: 10 };
function fixture() {
  const f = open();
  const events: { type: string }[] = [];
  const gate = createCallBudget({ path: f.path, clock: f.clock, prices: new PriceBook([PRICES_V1]), emitter: { emit: e => events.push(e) } });
  return { ...f, gate, events, close() { gate.close(); f.svc.close(); } };
}

it('refuses without changing input/output caps; typed error and no provider invocation', async () => {
  const f = fixture();
  try {
    f.gate.setLimit({ scope: 'agent', id: 'a1', period: 'day', metric: 'tokens', hard: 39 });
    const original = { ...request };
    const d = f.gate.checkBeforeCall(request);
    assert.equal(d.kind, 'refuse');
    if (d.kind === 'refuse') assert.deepEqual([d.reason, d.scope, d.limit, d.used], ['hard', 'agent', 39, 0]);
    let invoked = false;
    await assert.rejects(f.gate.run(request, async () => { invoked = true; return { value: 1, usage: { inputTokens: 30, outputTokens: 10 } }; }), CallBudgetExceededError);
    assert.equal(invoked, false);
    assert.deepEqual(request, original);
    assert.ok(f.events.some(e => e.type === 'refuse'));
  } finally { f.close(); }
});

it('tightest remaining hierarchy wins, including existing RPC limits and legacy usage', () => {
  const f = fixture();
  try {
    for (const [scope, id, hard] of [['user', 'u1', 200], ['project', 'p1', 90], ['agent', 'a1', 100]] as const)
      f.gate.setLimit({ scope, id, period: 'month', metric: 'tokens', hard });
    const first = f.gate.checkBeforeCall({ ...request, agent: 'a2', estimatedInputTokens: 50 });
    assert.equal(first.kind, 'allow');
    const d = f.gate.checkBeforeCall(request);
    assert.equal(d.kind, 'refuse');
    if (d.kind === 'refuse') assert.equal(d.scope, 'project');
    f.svc.setLimit({ scope: 'global', period: 'day', metric: 'tokens', hard: 10 });
    f.svc.recordUsage({ agent: 'a1', model: 'm-small', inputTokens: 10, outputTokens: 0 });
    const old = f.gate.checkBeforeCall({ ...request, project: 'p2', principal: 'u2' });
    assert.equal(old.kind, 'refuse');
    if (old.kind === 'refuse') assert.equal(old.scope, 'global');
  } finally { f.close(); }
});

it('concurrent reservations through separate connections cannot overbook; settlement corrects and is idempotent', async () => {
  const f = fixture();
  const second = createCallBudget({ path: f.path, clock: f.clock, prices: new PriceBook([PRICES_V1]) });
  try {
    f.gate.setLimit({ scope: 'user', id: 'u1', period: 'day', metric: 'tokens', hard: 100 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => (i % 2 ? second : f.gate).checkBeforeCall(request))));
    const allowed = results.filter(r => r.kind === 'allow');
    assert.equal(allowed.length, 2);
    const id = allowed[0]!.reservationId;
    assert.equal(second.settle(id, { inputTokens: 5, outputTokens: 5 }).recorded, true);
    assert.equal(f.gate.settle(id, { inputTokens: 5, outputTokens: 5 }).recorded, false);
    assert.equal(f.gate.checkBeforeCall(request).kind, 'allow');
    assert.equal(f.svc.status().periods[0]!.total.inputTokens, 5);
    assert.ok(f.events.some(e => e.type === 'reserve'));
  } finally { second.close(); f.close(); }
});

it('reservations survive reopen; pending calls still count after a period rollover (within the reservation TTL)', () => {
  const f = fixture();
  try {
    f.gate.setLimit({ scope: 'agent', id: 'a1', period: 'day', metric: 'tokens', hard: 40 });
    const d = f.gate.checkBeforeCall(request);
    assert.equal(d.kind, 'allow');
    f.clock.advance(86400000);
    const other = createCallBudget({ path: f.path, clock: f.clock, prices: new PriceBook([PRICES_V1]), reservationTtlMs: 2 * 86400000 });
    try { assert.equal(other.checkBeforeCall(request).kind, 'refuse'); } finally { other.close(); }
    if (d.kind === 'allow') f.gate.settle(d.reservationId, { inputTokens: 0, outputTokens: 0 });
    assert.equal(f.gate.checkBeforeCall(request).kind, 'allow');
  } finally { f.close(); }
});

it('cost estimation, unpriced refusal, warnings and actual overage are explicit', () => {
  const f = fixture();
  try {
    f.gate.setLimit({ scope: 'project', id: 'p1', period: 'week', metric: 'cost', hard: 100 });
    const unknown = f.gate.checkBeforeCall({ ...request, model: 'unknown' });
    assert.equal(unknown.kind, 'refuse');
    if (unknown.kind === 'refuse') assert.equal(unknown.reason, 'unpriced-model');
    const d = f.gate.checkBeforeCall(request); // 30 + 10*5 = 80, default warn at 80%
    assert.equal(d.kind, 'allow');
    assert.ok(f.events.some(e => e.type === 'warn'));
    if (d.kind === 'allow') {
      const s = f.gate.settle(d.reservationId, { inputTokens: 50, outputTokens: 20 });
      assert.equal(s.costMicros, 150);
      assert.ok(s.overages.length > 0);
    }
    assert.equal(f.gate.checkBeforeCall(request).kind, 'refuse');
  } finally { f.close(); }
});

it('weeks start on Monday in local time, including DST and year boundaries', () => {
  const b = periodBounds(Date.UTC(2026, 2, 29, 12), 'Europe/Berlin', 'week');
  assert.equal(new Date(b.start).toISOString(), '2026-03-22T23:00:00.000Z');
  assert.equal(new Date(b.end).toISOString(), '2026-03-29T22:00:00.000Z');
  assert.equal(periodBounds(Date.UTC(2027, 0, 1), 'UTC', 'week').key, '2026-12-28');
});

it('zone allocation properties: integer bounds, minima, maxima, sum <= window; reports overflow without truncation', () => {
  for (let window = 0; window <= 10000; window += 13) {
    const a = allocateContext(window, DEFAULT_ZONE_POLICY);
    assert.equal(a.kind, 'allocated');
    if (a.kind !== 'allocated') continue;
    assert.ok(Object.values(a.budgets).reduce((x, y) => x + y, 0) <= window);
    for (const zone of Object.keys(a.budgets) as (keyof typeof a.budgets)[]) {
      assert.ok(a.budgets[zone] >= Math.ceil(window * DEFAULT_ZONE_POLICY[zone].minShare));
      assert.ok(a.budgets[zone] <= Math.floor(window * DEFAULT_ZONE_POLICY[zone].maxShare));
    }
    assert.equal(checkZones(a.budgets, { tools: a.budgets.tools + 1 }).kind, 'zone_exceeded');
  }
  const impossible = { ...DEFAULT_ZONE_POLICY, tools: { minShare: 0.9, maxShare: 0.9 }, system: { minShare: 0.9, maxShare: 0.9 } };
  assert.equal(allocateContext(100, impossible).kind, 'infeasible');
});

it('retry classes and turns are independent, cost ceiling is shared across a turn', () => {
  const policy = { maxAttempts: 2, maxCostMicros: 10 };
  const r = new RetryBudget(Object.fromEntries(['rate_limit', 'overloaded', 'network', 'timeout', 'tool_call_invalid'].map(k => [k, policy])) as never, 15);
  r.consume('t1', 'network', 5); r.consume('t1', 'network', 5);
  assert.throws(() => r.consume('t1', 'network', 0), RetryBudgetExceededError);
  r.consume('t1', 'timeout', 5);
  assert.throws(() => r.consume('t1', 'rate_limit', 1), /cost/);
  r.consume('t2', 'network', 5);
  assert.throws(() => r.consume('t3', 'overloaded', 11), /cost/);
});

it('subagent cap includes marker/pointer, preserves full structured result through port, never silently clips', () => {
  const full = { items: Array.from({ length: 1000 }, (_, i) => ({ i, text: 'one paragraph.\n\n' })) };
  let saved: unknown;
  const port = { store(value: unknown) { saved = value; return 'result:123'; } };
  const c = capSubagentResult(full, { limit: 100, port });
  assert.equal(c.kind, 'capped');
  if (c.kind === 'capped') {
    assert.equal(saved, full);
    assert.match(c.text, /truncated.*result:123/s);
    assert.ok(estimateResultTokens(c.text) <= 100);
  }
  assert.equal(capSubagentResult('small', { port }).kind, 'complete');
  assert.throws(() => capSubagentResult('x'.repeat(100), { limit: 1, port }), RangeError);
});

it('media prices are resolution-specific, missing units fail closed and bad quantities are rejected', () => {
  const table = { version: 'media', effectiveFrom: 0, models: { m: { input: 1, output: 2, media: { image: { low: 100, high: 500 }, videoSecond: { '720p': 20 } } } } };
  assert.equal(mediaCostMicros(table, 'm', undefined, [{ kind: 'image', resolution: 'high', quantity: 2 }, { kind: 'videoSecond', resolution: '720p', quantity: 1.5 }]), 1030);
  assert.equal(mediaCostMicros(table, 'm', undefined, [{ kind: 'image', resolution: 'missing', quantity: 1 }]), null);
  assert.throws(() => mediaCostMicros(table, 'm', undefined, [{ kind: 'image', resolution: 'low', quantity: -1 }]), RangeError);
});

it('nonzero zone minima hold over many windows and policies, including integer infeasibility', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const policy = Object.fromEntries(Object.keys(DEFAULT_ZONE_POLICY).map((z, i) => [z, { minShare: ((seed * (i + 3)) % 10) / 100, maxShare: 0.4 }])) as typeof DEFAULT_ZONE_POLICY;
    for (const window of [1, 3, 7, 19, 100, 8192, 131072]) {
      const a = allocateContext(window, policy);
      if (a.kind === 'infeasible') {
        assert.ok(Object.values(policy).reduce((s, p) => s + Math.ceil(window * p.minShare), 0) > window || Object.values(policy).some(p => Math.ceil(window * p.minShare) > Math.floor(window * p.maxShare)));
      } else {
        assert.ok(Object.values(a.budgets).reduce((x, y) => x + y, 0) <= window);
        for (const z of Object.keys(policy) as (keyof typeof policy)[]) assert.ok(a.budgets[z] >= Math.ceil(window * policy[z].minShare) && a.budgets[z] <= Math.floor(window * policy[z].maxShare));
      }
    }
  }
});

it('per-turn/session ceilings survive calendar rollover; every matching ceiling applies', () => {
  const f = fixture();
  try {
    f.gate.setLimit({ scope: 'turn', id: 't1', period: 'day', metric: 'tokens', hard: 45 });
    f.gate.setLimit({ scope: 'session', id: 's1', period: 'day', metric: 'tokens', hard: 70 });
    const d = f.gate.checkBeforeCall({ ...request, turn: 't1', session: 's1' });
    if (d.kind !== 'allow') assert.fail('expected allowance');
    f.gate.settle(d.reservationId, { inputTokens: 30, outputTokens: 10 });
    f.clock.advance(86400000);
    const turn = f.gate.checkBeforeCall({ ...request, turn: 't1', session: 's1' });
    assert.equal(turn.kind, 'refuse');
    if (turn.kind === 'refuse') assert.equal(turn.scope, 'turn');
    const session = f.gate.checkBeforeCall({ ...request, turn: 't2', session: 's1' });
    assert.equal(session.kind, 'refuse');
    if (session.kind === 'refuse') assert.equal(session.scope, 'session');
  } finally { f.close(); }
});

it('failed provider call keeps its reservation and exposes a reconciliation id', async () => {
  const f = fixture();
  try {
    f.gate.setLimit({ scope: 'agent', id: 'a1', period: 'day', metric: 'tokens', hard: 40 });
    let reservationId = '';
    await assert.rejects(f.gate.run(request, async () => { throw new Error('timeout'); }), (e: unknown) => {
      assert.ok(e instanceof Error && 'reservationId' in e);
      reservationId = String(e.reservationId); return true;
    });
    assert.equal(f.gate.checkBeforeCall(request).kind, 'refuse');
    f.gate.settle(reservationId, { inputTokens: 0, outputTokens: 0 });
    assert.equal(f.gate.checkBeforeCall(request).kind, 'allow');
  } finally { f.close(); }
});

it('calendar hierarchy resets correctly in configured timezone and warnings are once per period across reopen', () => {
  const f = fixture();
  try {
    f.svc.setTimeZone('Europe/Berlin');
    f.clock.set(Date.UTC(2026, 9, 31, 22, 59));
    f.gate.setLimit({ scope: 'user', id: 'u1', period: 'month', metric: 'tokens', hard: 40 });
    const d = f.gate.checkBeforeCall(request);
    if (d.kind !== 'allow') assert.fail();
    f.gate.settle(d.reservationId, { inputTokens: 30, outputTokens: 10 });
    assert.equal(f.gate.checkBeforeCall(request).kind, 'refuse');
    assert.equal(f.events.filter(e => e.type === 'warn').length, 1);
    f.clock.advance(60000);
    assert.equal(f.gate.checkBeforeCall(request).kind, 'allow');
    assert.equal(f.events.filter(e => e.type === 'warn').length, 2);
  } finally { f.close(); }
});

it('validates closed input, safe counts, injected sinks and media cost at reservation/settlement', () => {
  const f = fixture();
  try {
    for (const bad of [{ ...request, prompt: 'private' }, { ...request, principal: 'free text' }, { ...request, estimatedInputTokens: -1 }, { ...request, maxOutputTokens: NaN }]) assert.throws(() => f.gate.checkBeforeCall(bad), RangeError);
    assert.throws(() => f.gate.settle('missing', { inputTokens: 0, outputTokens: 0 }), /unknown reservation/);
    const gate = createCallBudget({ path: f.path, clock: f.clock, prices: new PriceBook([{ version: 'media', effectiveFrom: 0, models: { 'm-small': { input: 1, output: 5, media: { image: { high: 10 } } } } }]), emitter: { emit() { throw new Error('offline sink'); } } });
    try {
      gate.setLimit({ scope: 'user', id: 'u1', period: 'day', metric: 'cost', hard: 100 });
      const d = gate.checkBeforeCall({ ...request, media: [{ kind: 'image', resolution: 'high', quantity: 2 }] });
      if (d.kind !== 'allow') assert.fail();
      assert.equal(d.estimatedCostMicros, 100);
      assert.equal(gate.settle(d.reservationId, { inputTokens: 10, outputTokens: 1, media: [{ kind: 'image', resolution: 'high', quantity: 1 }] }).costMicros, 25);
    } finally { gate.close(); }
  } finally { f.close(); }
});

it('price book rejects invalid rates and isolates versioned prices from caller mutation', () => {
  assert.throws(() => new PriceBook([{ version: 'bad', effectiveFrom: 0, models: { m: { input: -1, output: 2 } } }]), RangeError);
  const table = { version: 'stable', effectiveFrom: 0, models: { m: { input: 1, output: 2 } } };
  const book = new PriceBook([table]); table.models.m.input = 100;
  assert.equal(book.at(0)!.models.m!.input, 1);
});

it('legacy soft-only RPC limits warn in the call hook and actual usage can trigger warning', () => {
  const f = fixture();
  try {
    f.svc.setLimit({ scope: 'agent', agentId: 'a1', period: 'day', metric: 'tokens', soft: 20 });
    assert.equal(f.gate.checkBeforeCall(request).kind, 'allow');
    assert.ok(f.events.some(e => e.type === 'warn'));
  } finally { f.close(); }
  const g = fixture();
  try {
    g.gate.setLimit({ scope: 'user', id: 'u1', period: 'day', metric: 'tokens', hard: 100 });
    const d = g.gate.checkBeforeCall(request);
    if (d.kind !== 'allow') assert.fail();
    assert.equal(g.events.some(e => e.type === 'warn'), false);
    g.gate.settle(d.reservationId, { inputTokens: 80, outputTokens: 0 });
    assert.ok(g.events.some(e => e.type === 'warn'));
  } finally { g.close(); }
});

it('retry rules enforce each distinct class attempt cap and rejected reservations do not consume cost', () => {
  const classes = ['rate_limit', 'overloaded', 'network', 'timeout', 'tool_call_invalid'] as const;
  const policy = Object.fromEntries(classes.map((k, i) => [k, { maxAttempts: i + 1, maxCostMicros: 100 }])) as import('../../src/budget/retry.ts').RetryPolicy;
  const r = new RetryBudget(policy, 1000);
  for (const [i, cls] of classes.entries()) {
    for (let attempt = 0; attempt <= i; attempt++) r.consume('turn', cls, 1);
    assert.throws(() => r.consume('turn', cls, 1), RetryBudgetExceededError);
  }
  const cost = new RetryBudget(policy, 2);
  assert.throws(() => cost.consume('x', 'network', 3), RetryBudgetExceededError);
  cost.consume('x', 'network', 2); // the rejected reservation changed nothing
});

it('subagent previews preserve Unicode and paragraph boundaries and include the full reference', () => {
  const port = { store: () => 'peer:full' };
  const full = 'First paragraph.\n\n' + '👩‍💻 next paragraph '.repeat(200);
  const capped = capSubagentResult(full, { limit: 80, port });
  if (capped.kind !== 'capped') assert.fail();
  assert.ok(estimateResultTokens(capped.text) <= 80);
  assert.equal(capped.text.includes('\uFFFD'), false);
  assert.ok(capped.text.startsWith('First paragraph.'));
  assert.match(capped.text, /\[truncated; full result: peer:full\]$/);
});

it('settlement uses admission-time version and warnings remain deduplicated across connections', () => {
  const f = fixture();
  const tables = [PRICES_V1, { version: 'new', effectiveFrom: f.clock.now() + 1000, models: { 'm-small': { input: 100, output: 100 } } }];
  const gate = createCallBudget({ path: f.path, clock: f.clock, prices: new PriceBook(tables), emitter: { emit: e => f.events.push(e) } });
  try {
    gate.setLimit({ scope: 'user', id: 'u1', period: 'day', metric: 'cost', hard: 100 });
    const d = gate.checkBeforeCall(request);
    if (d.kind !== 'allow') assert.fail();
    const warns = f.events.filter(e => e.type === 'warn').length;
    f.clock.advance(2000);
    assert.equal(gate.settle(d.reservationId, { inputTokens: 30, outputTokens: 10 }).costMicros, 80);
    assert.equal(f.events.filter(e => e.type === 'warn').length, warns);
    assert.equal(f.svc.status().periods[0]!.total.costMicros, 80);
  } finally { gate.close(); f.close(); }
});

it('actual retry costs reconcile once and block subsequent retries when estimates were too low', () => {
  const r = new RetryBudget(undefined, 10);
  const ticket = r.consume('t', 'network', 5);
  assert.throws(() => r.settle(ticket, 11), RetryBudgetExceededError);
  assert.equal(r.settle(ticket, 11), false);
  assert.throws(() => r.consume('t', 'timeout', 0), RetryBudgetExceededError);
});

it('an orphaned reservation past its TTL no longer counts and is reconciled on start; release frees capacity at once', () => {
  const f = fixture();
  try {
    f.gate.setLimit({ scope: 'agent', id: 'a1', period: 'month', metric: 'tokens', hard: 40 });
    const d = f.gate.checkBeforeCall(request);
    assert.equal(d.kind, 'allow');
    assert.equal(f.gate.checkBeforeCall(request).kind, 'refuse', 'live reservation holds capacity');
    f.clock.advance(30 * 60_000 + 1);
    if (d.kind === 'allow') assert.equal(f.gate.reservation(d.reservationId)?.expired, true);
    assert.deepEqual(f.gate.pendingReservations(), { live: 0, expired: 1 });
    const second = f.gate.checkBeforeCall(request);
    assert.equal(second.kind, 'allow', 'expired reservation ignored on read');
    const reopened = createCallBudget({ path: f.path, clock: f.clock, prices: new PriceBook([PRICES_V1]), emitter: { emit: e => f.events.push(e) } });
    try {
      assert.ok(f.events.some(e => e.type === 'expire'), 'reconciled on start with an event');
      if (d.kind === 'allow') assert.equal(reopened.reservation(d.reservationId), null);
      if (second.kind === 'allow') { reopened.releaseUnused(second.reservationId); assert.equal(reopened.reservation(second.reservationId), null); }
      assert.ok(f.events.some(e => e.type === 'release'));
      assert.equal(reopened.checkBeforeCall(request).kind, 'allow');
    } finally { reopened.close(); }
  } finally { f.close(); }
});
