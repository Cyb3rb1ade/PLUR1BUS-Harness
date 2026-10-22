import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaults } from '@plur1bus/config-schema';
import { DecisionClient } from '../../src/decision/client.ts';
import { DecisionTreeChooser } from '../../src/decision/tree-adapter.ts';
import type { DecisionRequest } from '../../src/decision/types.ts';
const candidates = [{ id: 'a', name: 'Alpha', summary: 'x'.repeat(200) }, { id: 'b', name: 'Beta', summary: 'other' }];
function fixture(raw: unknown, local = true) {
  const cfg = defaults(); let received: DecisionRequest | undefined; let calls = 0;
  const decisions = new DecisionClient({ config: () => cfg, backends: { role: { local: () => local, async run(r) { calls++; received = r; return raw; } } } });
  const chooser = new DecisionTreeChooser(decisions, () => ({ agentId: 'trusted', forceLocal: cfg.privacy.localOnly }));
  return { chooser, cfg, request: () => received, calls: () => calls };
}
test('tree adapter uses bounded visible candidates, none and trusted context, returning top two probabilities', async () => {
  const f = fixture({ id: 'a', probabilities: { a: .6, b: .35, none: .05 }, confidence: .9 });
  assert.deepEqual(await f.chooser.choose('where?', candidates, AbortSignal.timeout(1000)), [{ id: 'a', confidence: .6 }, { id: 'b', confidence: .35 }]);
  const r = f.request()!; assert.equal(r.useCase, 'zoom'); assert.equal(r.context.agentId, 'trusted');
  assert.equal(r.options![0]!.description, 'Alpha\n' + 'x'.repeat(160)); assert.equal(r.options!.length, 3);
  assert(r.deadline <= performance.now() + 150); assert.equal(r.state, 'where?');
});
test('none, malformed answers, duplicate ids, cancellation and live privacy stop zooming', async () => {
  for (const raw of [{ id: 'none', probabilities: { a: .1, b: .1, none: .8 }, confidence: .9 }, { id: 'foreign', probabilities: { a: .9, b: .1, none: 0 }, confidence: .9 }]) {
    assert.deepEqual(await fixture(raw).chooser.choose('q', candidates, AbortSignal.timeout(1000)), []);
  }
  const f = fixture({}, false); f.cfg.privacy.localOnly = true;
  assert.deepEqual(await f.chooser.choose('q', candidates, AbortSignal.timeout(1000)), []); assert.equal(f.calls(), 0);
  assert.deepEqual(await f.chooser.choose('q', [candidates[0]!, candidates[0]!], AbortSignal.timeout(1000)), []);
  assert.deepEqual(await f.chooser.choose('q', candidates, AbortSignal.abort()), []); assert.equal(f.calls(), 0);
});
test('candidate cap is 24 plus none and failures never escape', async () => {
  const f = fixture({}); await f.chooser.choose('q', Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: 'n', summary: 's' })), AbortSignal.timeout(1000));
  assert.equal(f.request()!.options!.length, 25);
  const chooser = new DecisionTreeChooser({ choice: async () => { throw Error('unavailable'); } }, () => ({ agentId: 'a' }));
  assert.deepEqual(await chooser.choose('q', candidates, AbortSignal.timeout(1000)), []);
});
for (const [name, context] of [
  ['expired shared deadline', { agentId: 'trusted', deadline: performance.now() - 1 }],
  ['recursive decision-role context', { agentId: 'trusted', chat: { role: 'decision' } as import('../../src/session/provider.ts').ChatRequest }],
] as const) {
  test(`${name} cannot start a choice`, async () => {
    let calls = 0;
    const chooser = new DecisionTreeChooser({ choice: async () => {
      calls++;
      return { ok: false, requestId: 'fake', reason: 'unavailable', elapsedMs: 0, attempted: [] };
    } }, () => context);
    assert.deepEqual(await chooser.choose('q', candidates, new AbortController().signal), []);
    assert.equal(calls, 0);
  });
}

test('each level keeps the same trusted absolute deadline and contains only bounded candidate metadata', async () => {
  const deadline = performance.now() + 100;
  const requests: DecisionRequest[] = [];
  const decisions = new DecisionClient({ config: defaults, backends: { role: { local: () => true, async run(request) {
    requests.push(request);
    return { id: 'a', probabilities: { a: .65, b: .3, none: .05 }, confidence: .9 };
  } } } });
  const chooser = new DecisionTreeChooser(decisions, () => ({ agentId: 'trusted', principal: 'owner', forceLocal: true, deadline }));
  const visible = [{ ...candidates[0]!, name: 'N'.repeat(100), rawContent: 'MUST-NOT-BE-SENT', foreignRelationship: 'HIDDEN' }, candidates[1]!];
  for (const query of ['level one', 'level two']) assert.deepEqual(await chooser.choose(query, visible, new AbortController().signal), [{ id: 'a', confidence: .65 }, { id: 'b', confidence: .3 }]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.deadline, deadline);
    assert.equal(request.context.principal, 'owner');
    assert.equal(request.context.forceLocal, true);
    assert.equal(request.options![0]!.description, 'N'.repeat(80) + '\n' + 'x'.repeat(160));
    assert.ok(!JSON.stringify({ state: request.state, question: request.question, options: request.options }).includes('MUST-NOT-BE-SENT'));
    assert.ok(!JSON.stringify(request.options).includes('HIDDEN'));
  }
});
test('cancellation during an actual shared DecisionClient call stops zoom without waiting for its backend', async () => {
  const started = Promise.withResolvers<void>();
  let backendSignal: AbortSignal | undefined;
  const decisions = new DecisionClient({ config: defaults, backends: { role: { local: () => true, run(_request, signal) {
    backendSignal = signal;
    started.resolve();
    return new Promise<never>(() => {});
  } } } });
  const controller = new AbortController();
  const chooser = new DecisionTreeChooser(decisions, () => ({ agentId: 'trusted' }));
  const result = chooser.choose('q', candidates, controller.signal);
  await started.promise;
  controller.abort();
  assert.deepEqual(await result, []);
  assert.equal(backendSignal!.aborted, true);
});
test('invalid inputs never reach the injected decision service', async () => {
  let calls = 0;
  const chooser = new DecisionTreeChooser({ choice: async () => {
    calls++;
    return { ok: false, requestId: 'fake', reason: 'unavailable', elapsedMs: 0, attempted: [] };
  } }, () => ({ agentId: 'trusted' }));
  for (const list of [[], [{ id: 'none', name: 'n', summary: 's' }], [{ id: 'x'.repeat(129), name: 'n', summary: 's' }], [candidates[0]!, candidates[0]!]]) {
    assert.deepEqual(await chooser.choose('q', list, new AbortController().signal), []);
  }
  assert.deepEqual(await chooser.choose('q'.repeat(4097), candidates, new AbortController().signal), []);
  assert.equal(calls, 0);
});
test('a pair-range winner retains the second best branch even below the pair threshold', async () => {
  const f = fixture({ id: 'a', probabilities: { a: .5, b: .3, none: .2 }, confidence: .9 });
  assert.deepEqual(await f.chooser.choose('q', candidates, new AbortController().signal), [
    { id: 'a', confidence: .5 }, { id: 'b', confidence: .3 },
  ]);
});
test('winner probability below the pair floor stops zoom even with high aggregate answer confidence', async () => {
  const f = fixture({ id: 'a', probabilities: { a: .34, b: .33, none: .33 }, confidence: .9 });
  assert.deepEqual(await f.chooser.choose('q', candidates, new AbortController().signal), []);
});
