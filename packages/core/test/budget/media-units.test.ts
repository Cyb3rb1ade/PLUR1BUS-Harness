// Budget limits in media units (owner decision 2026-10-19): images (a count) and video seconds, beside tokens, with the same
// scopes, hierarchy and soft/hard semantics. A media call reserves the units it asks for before the provider call and settles
// with what was delivered; a hard limit refuses before the provider is called.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCallBudget, CallBudgetExceededError, type CallBudgetEvent } from '../../src/budget/calls.ts';
import { BUDGET_SCHEMA_VERSION } from '../../src/budget/store.ts';
import { mediaCallUnits } from '../../src/budget/media.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import { open, Clock } from './helpers.ts';

const base = { principal: 'u1', project: 'p1', agent: 'a1', model: 'img-small', estimatedInputTokens: 0, maxOutputTokens: 0 };
function fixture() {
  const f = open();
  const events: CallBudgetEvent[] = [];
  const gate = createCallBudget({ path: f.path, clock: f.clock, emitter: { emit: e => events.push(e) } });
  return { ...f, gate, events, close() { gate.close(); f.svc.close(); } };
}
/** One media call through the port's `run`: the provider counter shows whether the provider was reached. */
function provider() {
  let calls = 0;
  return { get calls() { return calls; }, invoke: (delivered: { images?: number; videoSeconds?: number }) => async () => { calls++; return { value: calls, usage: { inputTokens: 0, outputTokens: 0, ...delivered } }; } };
}

describe('image limits', () => {
  it('limit 2 images: the third request is refused before the provider is called', async () => {
    const f = fixture(); const p = provider();
    try {
      f.gate.setLimit({ scope: 'agent', id: 'a1', period: 'day', metric: 'images', hard: 2 });
      await f.gate.run({ ...base, images: 1 }, p.invoke({ images: 1 }));
      await f.gate.run({ ...base, images: 1 }, p.invoke({ images: 1 }));
      await assert.rejects(f.gate.run({ ...base, images: 1 }, p.invoke({ images: 1 })), (e: unknown) => {
        assert.ok(e instanceof CallBudgetExceededError);
        assert.deepEqual([e.refusal.metric, e.refusal.scope, e.refusal.limit, e.refusal.used, e.refusal.estimate], ['images', 'agent', 2, 2, 1]);
        assert.equal(e.refusal.code, 'budget_exceeded');
        return true;
      });
      assert.equal(p.calls, 2);
      assert.ok(f.events.some(e => e.type === 'refuse' && e.refusal.metric === 'images'));
    } finally { f.close(); }
  });

  it('a request for n=3 with 2 left is refused whole (no partial admission)', () => {
    const f = fixture();
    try {
      f.gate.setLimit({ scope: 'agent', id: 'a1', period: 'day', metric: 'images', hard: 3 });
      const first = f.gate.checkBeforeCall({ ...base, images: 1 });
      assert.equal(first.kind, 'allow');
      if (first.kind === 'allow') f.gate.settle(first.reservationId, { inputTokens: 0, outputTokens: 0, images: 1 });
      const d = f.gate.checkBeforeCall({ ...base, images: 3 });
      assert.equal(d.kind, 'refuse');
      if (d.kind === 'refuse') assert.deepEqual([d.metric, d.limit, d.used, d.estimate], ['images', 3, 1, 3]);
      assert.equal(f.gate.checkBeforeCall({ ...base, images: 2 }).kind, 'allow');
    } finally { f.close(); }
  });

  it('a pending reservation holds its images: a concurrent request cannot use them', () => {
    const f = fixture();
    try {
      f.gate.setLimit({ scope: 'agent', id: 'a1', period: 'day', metric: 'images', hard: 2 });
      const held = f.gate.checkBeforeCall({ ...base, images: 2 });
      assert.equal(held.kind, 'allow');
      if (held.kind === 'allow') assert.equal(held.images, 2);
      assert.equal(f.gate.checkBeforeCall({ ...base, images: 1 }).kind, 'refuse');
    } finally { f.close(); }
  });

  it('fewer delivered than requested images settle at the delivered count and free the rest', () => {
    const f = fixture();
    try {
      f.gate.setLimit({ scope: 'agent', id: 'a1', period: 'day', metric: 'images', hard: 3 });
      const d = f.gate.checkBeforeCall({ ...base, images: 3 });
      assert.equal(d.kind, 'allow');
      if (d.kind !== 'allow') return;
      assert.equal(f.gate.checkBeforeCall({ ...base, images: 1 }).kind, 'refuse', 'all three are held while the call runs');
      const s = f.gate.settle(d.reservationId, { inputTokens: 0, outputTokens: 0, images: 1 });
      assert.deepEqual(s, { recorded: true, overages: [] });
      assert.ok(f.events.some(e => e.type === 'settle' && e.reservationId === d.reservationId && e.images === 1));
      assert.equal(f.gate.checkBeforeCall({ ...base, images: 2 }).kind, 'allow');
      const status = f.svc.status();
      assert.equal(status.periods[0]!.total.images, 1);
      assert.equal(status.periods[0]!.agents[0]!.models[0]!.images, 1);
    } finally { f.close(); }
  });

  it('image limits do not gate a chat call, and a media call is not gated by its zero tokens', () => {
    const f = fixture();
    try {
      f.gate.setLimit({ scope: 'agent', id: 'a1', period: 'day', metric: 'images', hard: 0 });
      assert.equal(f.gate.checkBeforeCall({ ...base, estimatedInputTokens: 10, maxOutputTokens: 10 }).kind, 'allow');
      assert.equal(f.gate.checkBeforeCall({ ...base, images: 1 }).kind, 'refuse');
    } finally { f.close(); }
  });
});

describe('video-second limits', () => {
  it('limit 10 s: 8 s then 8 s is refused without a provider call; delivered 4 s settle as 4 and admit 6 more', async () => {
    const f = fixture(); const p = provider();
    try {
      f.gate.setLimit({ scope: 'agent', id: 'a1', period: 'day', metric: 'videoSeconds', hard: 10 });
      await f.gate.run({ ...base, videoSeconds: 8 }, p.invoke({ videoSeconds: 4 }));
      await assert.rejects(f.gate.run({ ...base, videoSeconds: 8 }, p.invoke({ videoSeconds: 8 })), (e: unknown) => {
        assert.ok(e instanceof CallBudgetExceededError);
        assert.deepEqual([e.refusal.metric, e.refusal.limit, e.refusal.used, e.refusal.estimate], ['videoSeconds', 10, 4, 8]);
        return true;
      });
      assert.equal(p.calls, 1);
      await f.gate.run({ ...base, videoSeconds: 6 }, p.invoke({ videoSeconds: 6 }));
      assert.equal(p.calls, 2);
      assert.equal(f.svc.status().periods[0]!.total.videoSeconds, 10);
      assert.equal(f.gate.checkBeforeCall({ ...base, videoSeconds: 1 }).kind, 'refuse');
    } finally { f.close(); }
  });

  it('media units map to whole budget units: n images, video seconds rounded up', () => {
    assert.deepEqual(mediaCallUnits({ unit: 'image', quantity: 3 }), { images: 3 });
    assert.deepEqual(mediaCallUnits({ unit: 'videoSecond', quantity: 8 }), { videoSeconds: 8 });
    assert.deepEqual(mediaCallUnits({ unit: 'videoSecond', quantity: 4.2 }), { videoSeconds: 5 });
    assert.deepEqual(mediaCallUnits(null), {});
  });
});

describe('soft limits and hierarchy', () => {
  it('a soft image limit only warns (once per period); the call goes ahead', () => {
    const f = fixture();
    try {
      f.svc.setLimit({ scope: 'agent', agentId: 'a1', period: 'day', metric: 'images', soft: 1 });
      for (let i = 0; i < 3; i++) {
        const d = f.gate.checkBeforeCall({ ...base, images: 1 });
        assert.equal(d.kind, 'allow');
        if (d.kind === 'allow') f.gate.settle(d.reservationId, { inputTokens: 0, outputTokens: 0, images: 1 });
      }
      const warns = f.events.filter(e => e.type === 'warn');
      assert.equal(warns.length, 1);
      assert.equal(warns[0]!.type === 'warn' && warns[0]!.metric, 'images');
      const lim = f.svc.status().limits.find(l => l.metric === 'images')!;
      assert.deepEqual([lim.used, lim.state], [3, 'soft']);
    } finally { f.close(); }
  });

  it('a project limit refuses although the agent still has images left', () => {
    const f = fixture();
    try {
      f.gate.setLimit({ scope: 'agent', id: 'a1', period: 'day', metric: 'images', hard: 10 });
      f.gate.setLimit({ scope: 'project', id: 'p1', period: 'day', metric: 'images', hard: 2 });
      for (const agent of ['a1', 'a2']) {
        const d = f.gate.checkBeforeCall({ ...base, agent, images: 1 });
        assert.equal(d.kind, 'allow');
        if (d.kind === 'allow') f.gate.settle(d.reservationId, { inputTokens: 0, outputTokens: 0, images: 1 });
      }
      const d = f.gate.checkBeforeCall({ ...base, images: 1 });
      assert.equal(d.kind, 'refuse');
      if (d.kind === 'refuse') assert.deepEqual([d.scope, d.id, d.metric, d.used], ['project', 'p1', 'images', 2]);
      assert.equal(f.gate.checkBeforeCall({ ...base, project: 'p2', images: 1 }).kind, 'allow', 'another project is not affected');
    } finally { f.close(); }
  });

  it('a global image limit set through budget.set (the service) is enforced by the call port', () => {
    const f = fixture();
    try {
      f.svc.setLimit({ scope: 'global', period: 'month', metric: 'images', hard: 1 });
      const d = f.gate.checkBeforeCall({ ...base, images: 1 });
      assert.equal(d.kind, 'allow');
      if (d.kind === 'allow') f.gate.settle(d.reservationId, { inputTokens: 0, outputTokens: 0, images: 1 });
      const r = f.gate.checkBeforeCall({ ...base, agent: 'a2', images: 1 });
      assert.equal(r.kind, 'refuse');
      if (r.kind === 'refuse') assert.deepEqual([r.scope, r.metric, r.used], ['global', 'images', 1]);
      assert.deepEqual(f.svc.status().limits.map(l => [l.metric, l.used, l.state]), [['images', 1, 'hard']]);
    } finally { f.close(); }
  });

  it('the service accepts images and videoSeconds limits and still refuses an unknown metric', () => {
    const { svc } = open();
    try {
      assert.deepEqual(svc.setLimit({ scope: 'global', period: 'day', metric: 'videoSeconds', hard: 60 }), { scope: 'global', period: 'day', metric: 'videoSeconds', soft: null, hard: 60 });
      assert.throws(() => svc.setLimit({ scope: 'global', period: 'day', metric: 'frames' as never, hard: 1 }), /metric must be/);
      // The advisory token check ignores unit limits.
      svc.setLimit({ scope: 'global', period: 'day', metric: 'images', hard: 0 });
      assert.equal(svc.check('a1', 'm', { inputTokens: 5 }).allowed, true);
    } finally { svc.close(); }
  });
});

describe('store migration', () => {
  it('a schema-1 store is migrated additively: limits, usage and pending reservations survive, unit columns start at 0', () => {
    const dir = tempDir('p1b-budget-mig-');
    const path = join(dir, 'state', 'budget.sqlite');
    mkdirSync(join(dir, 'state'), { recursive: true });
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE usage_event (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0), output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0), cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
        cost_micros INTEGER CHECK (cost_micros IS NULL OR cost_micros >= 0), price_version TEXT NOT NULL, request_id TEXT UNIQUE);
      CREATE INDEX usage_event_agent_ts ON usage_event (agent, ts);
      CREATE INDEX usage_event_ts ON usage_event (ts);
      CREATE TABLE budget_limit (scope TEXT NOT NULL CHECK (scope IN ('global', 'agent')), agent TEXT NOT NULL, period TEXT NOT NULL CHECK (period IN ('day', 'month')),
        metric TEXT NOT NULL CHECK (metric IN ('cost', 'tokens')), soft INTEGER CHECK (soft IS NULL OR soft >= 0), hard INTEGER CHECK (hard IS NULL OR hard >= 0),
        CHECK (soft IS NOT NULL OR hard IS NOT NULL), CHECK (soft IS NULL OR hard IS NULL OR soft <= hard),
        CHECK ((scope = 'global' AND agent = '') OR (scope = 'agent' AND agent <> '')), PRIMARY KEY (scope, agent, period, metric));
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE notice (kind TEXT NOT NULL CHECK (kind IN ('soft', 'hard')), scope TEXT NOT NULL, agent TEXT NOT NULL, period TEXT NOT NULL, metric TEXT NOT NULL,
        period_key TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (kind, scope, agent, period, metric, period_key));
      CREATE TABLE budget_call (id TEXT PRIMARY KEY, principal TEXT NOT NULL, project TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL,
        turn TEXT NOT NULL, session TEXT NOT NULL, ts INTEGER NOT NULL, tokens INTEGER NOT NULL CHECK(tokens >= 0), cost INTEGER CHECK(cost >= 0),
        state TEXT NOT NULL CHECK(state IN ('reserved','settled')));
      CREATE TABLE budget_call_limit (scope TEXT NOT NULL, id TEXT NOT NULL, period TEXT NOT NULL, metric TEXT NOT NULL, hard INTEGER NOT NULL CHECK(hard >= 0),
        soft INTEGER NOT NULL CHECK(soft >= 0 AND soft <= hard), PRIMARY KEY(scope,id,period,metric));
      CREATE TABLE budget_call_notice (scope TEXT NOT NULL, id TEXT NOT NULL, period TEXT NOT NULL, metric TEXT NOT NULL, period_key TEXT NOT NULL, PRIMARY KEY(scope,id,period,metric,period_key));
      INSERT INTO settings VALUES ('budget_call_schema','1');
      INSERT INTO budget_limit VALUES ('agent','a1','day','tokens',NULL,500);
      PRAGMA user_version = 1;
    `);
    const now = Date.UTC(2026, 9, 6, 12);
    raw.prepare("INSERT INTO usage_event (ts, agent, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, price_version) VALUES (?, 'a1', 'm', 7, 3, 0, 0, '')").run(now - 1000);
    raw.prepare("INSERT INTO budget_call VALUES ('old-res','u1','p1','a1','m','','','',?,40,NULL,'reserved')").run(now - 1000);
    raw.close();

    const f = open({ dir, clock: new Clock(now) });
    const gate = createCallBudget({ path, clock: f.clock });
    try {
      const db = new DatabaseSync(path, { readOnly: true });
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, BUDGET_SCHEMA_VERSION);
      assert.equal(BUDGET_SCHEMA_VERSION, 2);
      const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
      assert.ok(cols('usage_event').includes('images') && cols('usage_event').includes('video_seconds'));
      assert.ok(cols('budget_call').includes('images') && cols('budget_call').includes('video_seconds'));
      assert.deepEqual({ ...db.prepare('SELECT images, video_seconds FROM usage_event').get() }, { images: 0, video_seconds: 0 });
      assert.equal((db.prepare("SELECT value FROM settings WHERE key='budget_call_schema'").get() as { value: string }).value, '2');
      db.close();
      assert.deepEqual(f.svc.limits(), [{ scope: 'agent', agentId: 'a1', period: 'day', metric: 'tokens', soft: null, hard: 500 }]);
      assert.equal(f.svc.status().periods[0]!.total.inputTokens, 7);
      assert.deepEqual(gate.reservation('old-res'), { state: 'reserved', tokens: 40, expired: false });
      // The widened metric check accepts the new metrics in the old table.
      f.svc.setLimit({ scope: 'agent', agentId: 'a1', period: 'day', metric: 'images', hard: 2 });
      assert.equal(f.svc.limits().length, 2);
      const d = gate.checkBeforeCall({ ...base, images: 2 });
      assert.equal(d.kind, 'allow');
      if (d.kind === 'allow') gate.settle(d.reservationId, { inputTokens: 0, outputTokens: 0, images: 2 });
      assert.equal(gate.checkBeforeCall({ ...base, images: 1 }).kind, 'refuse');
    } finally { gate.close(); f.svc.close(); }
  });
});
