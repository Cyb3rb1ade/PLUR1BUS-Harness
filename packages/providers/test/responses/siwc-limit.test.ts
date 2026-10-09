import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponsesHttp } from '../../src/responses/errors.ts';
import { classifyFailure } from '../../src/router/classify.ts';
test('D110 plan limit preserves Retry-After, forbids retries and all fallback', () => {
  const e = classifyResponsesHttp(429, new Headers({ 'retry-after': '12' }), JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }), 0, s => s);
  assert.equal(e.retryAfterMs, 12000); assert.equal(e.retryable, false); assert.equal(classifyFailure(e).fallback, false);
});
