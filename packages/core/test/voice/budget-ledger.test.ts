import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { voiceBudget } from '../../src/voice/budget.ts';
import type { CallBudget } from '../../src/budget/index.ts';
import type { VoiceUsage } from '../../src/voice/ports.ts';

const usage = (over: Partial<VoiceUsage>): VoiceUsage => ({ seconds: 0, costMicros: 0, inputTokens: 0, outputTokens: 0, ...over });
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
    for (const bad of [{ seconds: NaN }, { seconds: Infinity }, { costMicros: -1 }, { costMicros: NaN }, { inputTokens: -5 }, { outputTokens: Infinity }])
      assert.equal(await l.port.record({ ...who, reservation: 'r1', eventId: 'bad-' + JSON.stringify(bad), usage: usage(bad) }), false, JSON.stringify(bad));
    assert.equal(l.calls.settled, 0);
    assert.equal(await l.port.record({ ...who, reservation: 'r1', eventId: 'ok', usage: usage({ seconds: 10 }) }), true);
  } finally { await l.done(); }
});
