// Dry run of scripts/live/media-budget-openai.mjs against a loopback stub of the OpenAI Images API (no real provider, no
// real key): two images succeed, the third is refused by the budget without a request; the safety net stops a third
// request even when no limit is set; without OPENAI_API_KEY nothing is sent; the credential never reaches the output.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fakeServer, json, b64, makePng } from '../../../media/test/adapters-fixtures.ts';

const script = fileURLToPath(new URL('../../../../scripts/live/media-budget-openai.mjs', import.meta.url));
// Built at run time: a placeholder, not a credential.
const fakeKey = ['dry', 'run', 'placeholder', String(process.pid)].join('-');

function run(env: Record<string, string | undefined>): Promise<{ code: number | null; out: string }> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('PLUR1BUS_LIVE_') && k !== 'OPENAI_API_KEY') clean[k] = v;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: clean, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('scripts/live/media-budget-openai.mjs (dry run)', () => {
  it('two images, then the budget refuses the third before any request', async () => {
    const s = await fakeServer((_c, res) => json(res, 200, { data: [{ b64_json: b64(makePng()) }] }));
    try {
      const { code, out } = await run({ OPENAI_API_KEY: fakeKey, PLUR1BUS_LIVE_OPENAI_BASE_URL: s.url });
      assert.equal(code, 0, out);
      assert.equal(s.calls.length, 2, 'exactly two provider requests');
      for (const c of s.calls) {
        assert.equal(c.path, '/images/generations');
        assert.equal(c.headers.authorization, undefined, 'a loopback stub never receives the key');
        const body = JSON.parse(c.body);
        assert.deepEqual([body.model, body.n, body.size], ['gpt-image-1-mini', 1, '1024x1024']);
      }
      assert.match(out, /attempt 1: succeeded; requested 1 image, delivered 1; provider calls 1; images used 1 of hard 2 \(ok\)/);
      assert.match(out, /attempt 2: succeeded; requested 1 image, delivered 1; provider calls 1; images used 2 of hard 2 \(hard\)/);
      assert.match(out, /attempt 3: refused \(budget_exceeded\); requested 1 image, delivered 0; provider calls 0; images used 2 of hard 2 \(hard\)/);
      assert.match(out, /PASS/);
      const dir = /^images: (.+)$/m.exec(out)?.[1];
      assert.ok(dir && existsSync(dir) && readdirSync(dir).length >= 2, `images are kept in a temporary directory: ${dir}`);
      assert.equal(out.includes(fakeKey), false, 'the credential is never printed');
    } finally { await s.close(); }
  });

  it('the safety net refuses a third provider request even without a limit', async () => {
    const s = await fakeServer((_c, res) => json(res, 200, { data: [{ b64_json: b64(makePng()) }] }));
    try {
      const { code, out } = await run({ OPENAI_API_KEY: fakeKey, PLUR1BUS_LIVE_OPENAI_BASE_URL: s.url, PLUR1BUS_LIVE_DRY_NO_LIMIT: '1' });
      assert.equal(code, 1, out);
      assert.equal(s.calls.length, 2, 'never more than two provider requests');
      assert.match(out, /safety net refused a further call/);
      assert.match(out, /FAIL/);
      assert.equal(out.includes(fakeKey), false);
    } finally { await s.close(); }
  });

  it('without OPENAI_API_KEY it stops with a hint and sends nothing', async () => {
    const s = await fakeServer((_c, res) => json(res, 500, {}));
    try {
      const { code, out } = await run({ PLUR1BUS_LIVE_OPENAI_BASE_URL: s.url });
      assert.equal(code, 0, out);
      assert.match(out, /OPENAI_API_KEY is not set; nothing was sent/);
      assert.equal(s.calls.length, 0);
    } finally { await s.close(); }
  });

  it('the stub overrides are refused for any non-loopback host', async () => {
    const { code, out } = await run({ OPENAI_API_KEY: fakeKey, PLUR1BUS_LIVE_OPENAI_BASE_URL: 'https://example.invalid/v1' });
    assert.equal(code, 2, out);
    assert.match(out, /loopback stub only/);
    const noLimit = await run({ OPENAI_API_KEY: fakeKey, PLUR1BUS_LIVE_DRY_NO_LIMIT: '1' });
    assert.equal(noLimit.code, 2, noLimit.out);
  });
});
