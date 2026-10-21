import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { voiceBudget } from '../../src/voice/budget.ts';
import type { CallBudget } from '../../src/budget/index.ts';
import type { VoiceUsage } from '../../src/voice/ports.ts';

const usage = (over: Partial<VoiceUsage>): VoiceUsage => ({ seconds: 0, inputTokens: 0, outputTokens: 0, ...over });
async function ledger(dailySeconds = 100) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-ledger-'));
  const calls = { settled: 0 };
  const budget = { checkBeforeCall: () => ({ kind: 'allow', reservationId: 'ticket' }), releaseUnused() {}, settle() { calls.settled++; return { overages: [] }; } } as unknown as CallBudget;
  const l = voiceBudget({ path: join(dir, 'v.sqlite'), budget, clock: () => 86400000 * 3 + 1000, dailySeconds });
  return { ...l, calls, async done() { l.close(); await rm(dir, { recursive: true, force: true }); } };
}
const who = { agent: 'a', user: 'u' };

test('negative usage cannot refund the daily voice-seconds ceiling', async () => {
  const l = await ledger(100); try {
    assert.equal(await l.port.reserve({ ...who, reservation: 'r1' }), true);
    assert.equal(await l.port.record({ ...who, reservation: 'r1', eventId: 'e1', usage: usage({ seconds: 100 }) }), false);
    assert.equal(await l.port.reserve({ ...who, reservation: 'r2' }), false);
    assert.equal(await l.port.record({ ...who, reservation: 'r1', eventId: 'refund', usage: usage({ seconds: -1000 }) }), false);
    assert.equal(await l.port.reserve({ ...who, reservation: 'r3' }), false);
  } finally { await l.done(); }
});

test('non-finite or negative usage fails closed instead of throwing a raw database error', async () => {
  const l = await ledger(100); try {
    assert.equal(await l.port.reserve({ ...who, reservation: 'r1' }), true);
    for (const bad of [{ seconds: NaN }, { seconds: Infinity }, { seconds: -1 }, { inputTokens: NaN }, { inputTokens: -5 }, { outputTokens: Infinity }])
      assert.equal(await l.port.record({ ...who, reservation: 'r1', eventId: 'bad-' + JSON.stringify(bad), usage: usage(bad) }), false, JSON.stringify(bad));
    assert.equal(l.calls.settled, 0);
    assert.equal(await l.port.record({ ...who, reservation: 'r1', eventId: 'ok', usage: usage({ seconds: 10 }) }), true);
  } finally { await l.done(); }
});

test('two ledgers on the voice-usage database share one daily ceiling (runtime + provider pipeline)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-ledger-')); const path = join(dir, 'v.sqlite');
  const budget = { checkBeforeCall: () => ({ kind: 'allow', reservationId: 't' }), releaseUnused() {}, settle: () => ({ overages: [] }) } as unknown as CallBudget;
  const make = (billingProvider: string) => voiceBudget({ path, budget, clock: () => 86400000 * 3 + 1000, dailySeconds: 100, billingProvider });
  const runtime = make('openai-voice'), providers = make('voice');
  try {
    assert.equal(await runtime.port.reserve({ ...who, reservation: 'r1' }), true);
    assert.equal(await runtime.port.record({ ...who, reservation: 'r1', eventId: 'e1', usage: usage({ seconds: 60 }) }), true);
    assert.equal(await providers.port.reserve({ ...who, reservation: 'p1' }), true);
    assert.equal(await providers.port.record({ ...who, reservation: 'p1', eventId: 'e1', usage: usage({ seconds: 60 }) }), false, '60 + 60 reaches the 100 s ceiling');
    assert.equal(await runtime.port.reserve({ ...who, reservation: 'r2' }), false);
    assert.equal(await providers.port.reserve({ ...who, reservation: 'p2' }), false);
    assert.equal(await providers.port.reserve({ agent: 'other', user: 'other', reservation: 'p3' }), true, 'other agent/person keep their own ceiling');
  } finally { runtime.close(); providers.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the runtime and the composition use the same voice-usage database path', async () => {
  const { voiceUsagePath } = await import('../../src/voice/budget.ts');
  assert.equal(voiceUsagePath('/h'), join('/h', 'state', 'voice-usage.sqlite'));
  const { readFile } = await import('node:fs/promises');
  for (const f of ['../../src/voice/runtime.ts', '../../src/composition/voice.ts']) {
    const src = await readFile(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /path: voiceUsagePath\(d\.home\)/, f); assert.doesNotMatch(src, /usage\.sqlite/, f);
  }
});
