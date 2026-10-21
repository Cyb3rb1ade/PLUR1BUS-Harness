// media.generate over RPC with limits in media units (owner decision 2026-10-19): a hard image or video-second limit refuses
// the request with the existing budget refusal (E_DENIED, reason budget_exceeded) before the adapter is called; a finished job
// is settled at what it delivered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaSurface } from '../../src/rpc/media-surface.ts';
import { guardMethods } from '../../src/rbac/guard.ts';
import { createBudgetService, createCallBudget } from '../../src/budget/index.ts';
import { OutputStore, type ImageAdapter } from '../../../media/src/index.ts';
import { makePng } from '../../../media/test/adapters-fixtures.ts';

const ctx = { requestId: 'r', connectionId: 'c', signal: new AbortController().signal };
const now = Date.UTC(2026, 9, 19, 12);

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'rpc-media-budget-'));
  const path = join(home, 'state', 'budget.sqlite');
  const budget = createCallBudget({ path, clock: { now: () => now } });
  const service = createBudgetService({ path, clock: { now: () => now } });
  const calls: string[] = [];
  const adapter: ImageAdapter = {
    id: 'fake', model: 'fake-image',
    capabilities: () => ({ generate: true, edit: false, inpaint: false, video: { textToVideo: true, imageToVideo: false, videoToVideo: false } }),
    async generate(r) {
      calls.push(r.kind ?? 'image');
      if (r.kind === 'video') return { files: [{ bytes: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(40)]), format: 'mp4' }], metadata: { adapter: 'fake', model: 'fake-video', durationMs: 1 } };
      // Delivers one image whatever n asks for, like a provider that returns fewer than requested.
      return { files: [{ bytes: makePng(), format: 'png' }], metadata: { adapter: 'fake', model: 'fake-image', durationMs: 1 } };
    },
    async edit(r, c) { return this.generate(r, c); },
  };
  // The processor reports 4 s for every clip, so an 8 s request delivers less than it reserved.
  const store = new OutputStore(join(home, 'outputs'), { videoProcessor: async (i, o, p) => { await writeFile(o, await readFile(i)); await writeFile(p, Buffer.from('poster')); return { durationSeconds: 4, width: 1280, height: 720, fps: 24, audio: false }; } });
  const surface = createMediaSurface({ home, adapters: [adapter], store, budget, signal: ctx.signal, policy: async () => {}, notify: () => {} });
  const methods = guardMethods(surface.methods, { resolve: () => ({ userId: 'owner', role: 'owner', kind: 'person' }), now: () => 0 });
  const generate = async (request: Record<string, unknown>, kind?: 'video') => {
    const q = await methods['media.generate']!({ agentId: 'main', ...(kind ? { kind } : {}), request }, ctx) as { jobId: string };
    await surface.close(); // waits for the job
    return q;
  };
  return {
    service, calls, generate,
    async close() { await surface.close(); budget.close(); service.close(); await rm(home, { recursive: true, force: true }); },
  };
}

const refused = { error: 'E_DENIED', reason: 'budget_exceeded' };

test('limit 2 images: the third media.generate is refused as budget_exceeded and the adapter is not called', async () => {
  const f = await fixture();
  try {
    f.service.setLimit({ scope: 'agent', agentId: 'main', period: 'day', metric: 'images', hard: 2 });
    await f.generate({ prompt: 'a lighthouse' });
    await f.generate({ prompt: 'a lighthouse' });
    await assert.rejects(f.generate({ prompt: 'a lighthouse' }), refused);
    assert.deepEqual(f.calls, ['image', 'image']);
    const lim = f.service.status().limits[0]!;
    assert.deepEqual([lim.metric, lim.used, lim.state], ['images', 2, 'hard']);
  } finally { await f.close(); }
});

test('n=3 with 2 images left is refused whole; a provider that delivers 1 of 2 is settled at 1', async () => {
  const f = await fixture();
  try {
    f.service.setLimit({ scope: 'global', period: 'day', metric: 'images', hard: 3 });
    await f.generate({ prompt: 'boats', n: 2 }); // reserves 2, the fake delivers 1
    assert.equal(f.service.status().periods[0]!.total.images, 1);
    await assert.rejects(f.generate({ prompt: 'boats', n: 3 }), refused);
    assert.equal(f.calls.length, 1);
    await f.generate({ prompt: 'boats', n: 2 }); // 1 used + 2 = 3: lands exactly on the limit
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test('video seconds: the requested seconds are reserved and the delivered seconds settled', async () => {
  const f = await fixture();
  try {
    f.service.setLimit({ scope: 'agent', agentId: 'main', period: 'day', metric: 'videoSeconds', hard: 10 });
    await f.generate({ prompt: 'waves', durationSeconds: 8, resolution: '720p' }, 'video'); // 8 reserved, 4 delivered
    assert.equal(f.service.status().periods[0]!.total.videoSeconds, 4);
    await assert.rejects(f.generate({ prompt: 'waves', durationSeconds: 8, resolution: '720p' }, 'video'), refused);
    assert.deepEqual(f.calls, ['video']);
    await f.generate({ prompt: 'waves', durationSeconds: 6, resolution: '720p' }, 'video');
    assert.equal(f.service.status().periods[0]!.total.videoSeconds, 8);
    // An image limit does not stop video, and a video limit does not stop images.
    await f.generate({ prompt: 'a still' });
    assert.deepEqual(f.calls, ['video', 'video', 'image']);
  } finally { await f.close(); }
});
