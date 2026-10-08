import { test } from 'node:test';
import assert from 'node:assert/strict';
/** Optional owner-run smoke only. Never enabled by ordinary test or PR configuration. */
test('gated live OpenAI model listing', { skip: process.env.PLUR1BUS_LIVE_OPENAI !== '1' || !process.env.PLUR1BUS_LIVE_OPENAI_KEY }, async () => {
  let status = 0;
  try {
    const response = await fetch('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer ' + process.env.PLUR1BUS_LIVE_OPENAI_KEY }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    status = response.status; await response.body?.cancel();
  } catch { throw Error('Live OpenAI smoke transport failed.'); }
  assert.equal(status, 200, 'Live OpenAI model listing must succeed.');
});
