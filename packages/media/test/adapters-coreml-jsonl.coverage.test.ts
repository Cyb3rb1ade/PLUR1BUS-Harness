import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoreMLSession, mapHelperError, probeJsonl } from '../src/adapters/coreml-jsonl.ts';
import { MediaError } from '../src/index.ts';
import { writeFakeHelper } from './coverage-helpers.coverage.ts';
import type { FakeHelper } from './coverage-helpers.coverage.ts';

const code = (c: string) => (e: unknown) => e instanceof MediaError && e.code === c;
const never = () => new AbortController().signal;
const aborts = (caller: AbortSignal = never(), timeout: AbortSignal = never()) => ({ caller, timeout });
type Message = Record<string, unknown>;

async function withHelper<T>(fn: (helper: FakeHelper) => Promise<T>): Promise<T> {
  const helper = await writeFakeHelper();
  try { return await fn(helper); } finally { await helper.cleanup(); }
}
/** One session per test; graceMs 0 keeps the grace timer out of the way of observable events. */
function sessionFor(helper: FakeHelper): CoreMLSession {
  return new CoreMLSession({ command: process.execPath, args: [helper.script, 'session'], graceMs: 0 });
}
const op = (behave: string, extra: Message = {}): Message => ({ op: 'generate', model: 'sd', behave, ...extra });

test('mapHelperError maps each protocol code to its stable adapter code and anything else to backend_unavailable', () => {
  const table: [unknown, string][] = [
    ['content_policy', 'content_policy'], ['cancelled', 'cancelled'],
    ['invalid_request', 'unsupported_parameter'], ['model_not_found', 'unsupported_parameter'],
    ['weird-code', 'backend_unavailable'], ['', 'backend_unavailable'], [undefined, 'backend_unavailable'], [42, 'backend_unavailable'], [null, 'backend_unavailable'], ['timeout', 'backend_unavailable'],
  ];
  for (const [input, expected] of table) {
    const error = mapHelperError(input);
    assert.ok(error instanceof MediaError, String(input));
    assert.equal(error.code, expected, String(input));
  }
});

test('probeJsonl accepts a helper that announces jsonl/1 and every required op, even with extra ops', async () => {
  await withHelper(async helper => {
    assert.equal(await probeJsonl(process.execPath, [helper.script, 'caps-ok']), true);
    assert.equal(await probeJsonl(process.execPath, [helper.script, 'caps-extra-ops']), true);
  });
});

test('probeJsonl refuses every capability answer that is not exactly the jsonl/1 contract, a failed exit, or a missing binary', async () => {
  await withHelper(async helper => {
    const modes = ['caps-missing-cancel', 'caps-wrong-protocol', 'caps-ops-not-array', 'caps-exit-1', 'caps-garbage', 'caps-huge'];
    for (const mode of modes) assert.equal(await probeJsonl(process.execPath, [helper.script, mode]), false, mode);
    assert.equal(await probeJsonl('/nonexistent/media-helper-executable', []), false);
  });
});

test('probeJsonl kills a helper that never answers and reports it as not jsonl', async () => {
  await withHelper(async helper => {
    assert.equal(await probeJsonl(process.execPath, [helper.script, 'caps-hang'], 50), false);
  });
});

test('a request returns the helper result, and the helper receives the operation with a string id', async () => {
  await withHelper(async helper => {
    const s = sessionFor(helper);
    try {
      const result = await s.request(op('result'), aborts());
      assert.equal(result.type, 'result'); assert.equal(result.op, 'generate'); assert.equal(typeof result.id, 'string');
    } finally { await s.close(); }
  });
});

test('progress fractions reach the callback in order, including the 0 and 1 boundaries, before the result', async () => {
  await withHelper(async helper => {
    const s = sessionFor(helper); const seen: number[] = [];
    try {
      await s.request(op('progress-edges'), aborts(), fraction => { seen.push(fraction); });
      assert.deepEqual(seen, [0, 1]);
      await s.request(op('progress-ok'), aborts(), async fraction => { seen.push(fraction); await Promise.resolve(); });
      assert.deepEqual(seen, [0, 1, 0.5]);
    } finally { await s.close(); }
  });
});

test('requests are serialised: the second one starts only after the first has settled', async () => {
  await withHelper(async helper => {
    const s = sessionFor(helper);
    try {
      const [first, second] = await Promise.all([s.request(op('progress-ok'), aborts()), s.request(op('result'), aborts())]);
      assert.equal(first.type, 'result'); assert.equal(second.type, 'result');
      assert.notEqual(first.id, second.id);
    } finally { await s.close(); }
  });
});

test('every malformed helper line fails only the in-flight request as invalid_response, and the next request restarts the helper', async () => {
  await withHelper(async helper => {
    const s = sessionFor(helper);
    const bad = ['garbage', 'no-id', 'unknown-id', 'unknown-type', 'progress-string', 'progress-negative', 'progress-high', 'huge-line'];
    try {
      for (const behave of bad) {
        const error = await s.request(op(behave), aborts()).then(() => undefined, (e: unknown) => e);
        assert.ok(error instanceof MediaError, behave);
        assert.equal((error as MediaError).code, 'invalid_response', behave);
        assert.equal(String(error).includes('secret-123'), false, behave);
        assert.equal((await s.request(op('result'), aborts())).type, 'result', `restart after ${behave}`);
      }
    } finally { await s.close(); }
  });
});

test('helper error messages map to stable codes and leave the helper running for the next request', async () => {
  await withHelper(async helper => {
    const s = sessionFor(helper);
    const table: [string, string][] = [
      ['error-policy', 'content_policy'], ['error-cancelled', 'cancelled'], ['error-invalid', 'unsupported_parameter'],
      ['error-model', 'unsupported_parameter'], ['error-weird', 'backend_unavailable'],
    ];
    try {
      for (const [behave, expected] of table) await assert.rejects(s.request(op(behave), aborts()), code(expected), behave);
      assert.equal((await s.request(op('result'), aborts())).type, 'result');
    } finally { await s.close(); }
  });
});

test('a progress callback that throws fails the request with its own MediaError code, or invalid_response for anything else', async () => {
  await withHelper(async helper => {
    const s = sessionFor(helper);
    try {
      await assert.rejects(s.request(op('progress-ok'), aborts(), () => { throw new MediaError('quota'); }), code('quota'));
      await assert.rejects(s.request(op('progress-ok'), aborts(), () => { throw new Error('boom'); }), code('invalid_response'));
      assert.equal((await s.request(op('result'), aborts())).type, 'result');
    } finally { await s.close(); }
  });
});

test('a caller abort while the helper is working is cancelled, and the helper receives a cancel for the request', async () => {
  await withHelper(async helper => {
    const s = sessionFor(helper); const caller = new AbortController();
    try {
      await assert.rejects(s.request(op('hang'), aborts(caller.signal), () => { caller.abort(); }), code('cancelled'));
      assert.equal((await s.request(op('result'), aborts())).type, 'result');
    } finally { await s.close(); }
  });
});

test('a timeout while the helper is working is reported as timeout, not as a cancellation', async () => {
  await withHelper(async helper => {
    const s = sessionFor(helper); const timeout = new AbortController();
    try {
      await assert.rejects(s.request(op('hang'), aborts(never(), timeout.signal), () => { timeout.abort(); }), code('timeout'));
    } finally { await s.close(); }
  });
});

test('a helper that ignores cancel is killed after the grace period; the in-flight request is cancelled and the next one restarts', async () => {
  await withHelper(async helper => {
    const s = sessionFor(helper); const caller = new AbortController();
    try {
      await assert.rejects(s.request(op('deaf'), aborts(caller.signal), () => { caller.abort(); }), code('cancelled'));
      assert.equal((await s.request(op('result'), aborts())).type, 'result');
    } finally { await s.close(); }
  });
});

test('a request whose signal is already aborted is refused without a helper answer: caller abort is cancelled, a TimeoutError reason is timeout', async () => {
  await withHelper(async helper => {
    const s = sessionFor(helper);
    try {
      const caller = new AbortController(); caller.abort();
      await assert.rejects(s.request(op('result'), aborts(caller.signal)), code('cancelled'));
      const late = AbortSignal.abort(new DOMException('deadline', 'TimeoutError'));
      await assert.rejects(s.request(op('result'), aborts(never(), late)), code('timeout'));
    } finally { await s.close(); }
  });
});

test('a helper that exits in the middle of a request fails that request as backend_unavailable, and the next one restarts it', async () => {
  await withHelper(async helper => {
    const s = sessionFor(helper);
    try {
      await assert.rejects(s.request(op('crash'), aborts()), code('backend_unavailable'));
      assert.equal((await s.request(op('result'), aborts())).type, 'result');
    } finally { await s.close(); }
  });
});

test('a helper binary that cannot be started fails requests as backend_unavailable, with no path or message in the error', async () => {
  const s = new CoreMLSession({ command: '/nonexistent/media-helper-missing', args: [], graceMs: 0 });
  const error = await s.request(op('result'), aborts()).then(() => undefined, (e: unknown) => e);
  assert.equal((error as MediaError).code, 'backend_unavailable');
  assert.equal(String(error).includes('nonexistent'), false);
  await s.close();
});

test('a failed request does not poison the queue: the next queued request still runs and resolves', async () => {
  await withHelper(async helper => {
    const s = sessionFor(helper);
    try {
      const [failed, ok] = await Promise.allSettled([s.request(op('garbage'), aborts()), s.request(op('result'), aborts())]);
      assert.equal(failed.status, 'rejected'); assert.equal(ok.status, 'fulfilled');
    } finally { await s.close(); }
  });
});

test('close is safe to call on a fresh session, repeatedly, and while a request is in flight (which then fails as cancelled)', async () => {
  await withHelper(async helper => {
    const fresh = sessionFor(helper);
    await fresh.close(); await fresh.close();

    const used = sessionFor(helper);
    assert.equal((await used.request(op('result'), aborts())).type, 'result');
    await used.close(); await used.close();

    const busy = sessionFor(helper);
    await assert.rejects(busy.request(op('hang'), aborts(), () => { void busy.close(); }), code('cancelled'));
    await busy.close();
  });
});
