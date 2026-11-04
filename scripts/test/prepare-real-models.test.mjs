import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRealModels } from '../ci/prepare-real-models.mjs';

// Tiny invented bytes exercise the pinned Engine's real downloader, never ONNX or model output.
function fixture() {
  const responses = new Map();
  const profiles = ['embedding', 'reranker'].map(role => {
    const model = `fixture/${role}`, revision = 'a'.repeat(40);
    const artifacts = ['config.json', 'onnx/model.onnx'].map(path => {
      const bytes = Buffer.from(`synthetic ${role} ${path}`);
      responses.set(`https://huggingface.co/${model}/resolve/${revision}/${path}`, bytes);
      return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    return { role, model, revision, artifacts };
  });
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    assert(responses.has(url), `unexpected network target: ${url}`);
    return new Response(responses.get(url));
  };
  return { profiles, responses, calls, fetchImpl };
}

async function cache(t) {
  const directory = await mkdtemp(join(tmpdir(), 'p1b-real-model-prep-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function target(directory, profile, artifact) {
  return join(directory, profile.model, profile.revision, artifact.path);
}

test('cold preparation publishes every verified artifact before reporting success; a second run is offline', async t => {
  const directory = await cache(t), f = fixture();
  const summaries = await prepareRealModels({ directory, profiles: f.profiles, fetchImpl: f.fetchImpl });
  assert.equal(f.calls.length, 4);
  assert.deepEqual(summaries.map(s => [s.model, s.downloaded, s.reused]), [
    ['fixture/embedding', 2, 0], ['fixture/reranker', 2, 0],
  ]);
  for (const profile of f.profiles) for (const artifact of profile.artifacts) {
    const bytes = await readFile(target(directory, profile, artifact));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  }
  const reused = await prepareRealModels({ directory, profiles: f.profiles,
    fetchImpl: () => { throw new Error('a complete verified cache must not fetch'); } });
  assert.deepEqual(reused.map(s => [s.downloaded, s.reused]), [[0, 2], [0, 2]]);
});

test('a corrupt existing artifact is replaced rather than accepted as warm', async t => {
  const directory = await cache(t), f = fixture();
  await prepareRealModels({ directory, profiles: f.profiles, fetchImpl: f.fetchImpl });
  await writeFile(target(directory, f.profiles[0], f.profiles[0].artifacts[1]), 'corrupt');
  f.calls.length = 0;
  const repaired = await prepareRealModels({ directory, profiles: f.profiles, fetchImpl: f.fetchImpl });
  assert.equal(f.calls.length, 1);
  assert.equal(repaired[0].downloaded, 1);
});

for (const kind of ['sha256', 'truncated']) {
  test(`${kind} download failure rejects preparation and leaves no final artifact`, async t => {
    const directory = await cache(t), f = fixture();
    const artifact = f.profiles[0].artifacts[0];
    await assert.rejects(prepareRealModels({ directory, profiles: f.profiles,
      fetchImpl: async () => new Response(Buffer.alloc(kind === 'sha256' ? artifact.size : 1)) }),
    kind === 'sha256' ? /SHA-256 mismatch/ : /size mismatch/);
    await assert.rejects(readFile(target(directory, f.profiles[0], artifact)), { code: 'ENOENT' });
  });
}

test('an already cancelled preparation never starts a download', async t => {
  const directory = await cache(t), f = fixture();
  const reason = new Error('cancelled fixture');
  await assert.rejects(prepareRealModels({ directory, profiles: f.profiles, fetchImpl: f.fetchImpl,
    signal: AbortSignal.abort(reason) }), error => error === reason);
  assert.equal(f.calls.length, 0);
});

test('preparation never grants a noncommercial licence while preparing the existing acceptance models', async t => {
  const directory = await cache(t), f = fixture();
  f.profiles[0].commercialUse = false;
  f.profiles[0].license = 'fixture-noncommercial';
  await assert.rejects(prepareRealModels({ directory, profiles: f.profiles, fetchImpl: f.fetchImpl }),
    /requires explicit acknowledgement/);
  assert.equal(f.calls.length, 0);
});

test('progress identifies each download phase using numeric metadata without URLs or artifact contents', async t => {
  const directory = await cache(t), f = fixture(), events = [];
  await prepareRealModels({ directory, profiles: f.profiles, fetchImpl: f.fetchImpl,
    onProgress: event => events.push(event) });
  assert.deepEqual(events.filter(e => e.stage === 'verify-started').map(e => e.profile), [1, 2]);
  assert.deepEqual(events.filter(e => e.stage === 'verified').map(e => [e.profile, e.downloaded]), [[1, 2], [2, 2]]);
  assert.equal(events.filter(e => e.stage === 'request-started').length, 4);
  assert.equal(events.filter(e => e.stage === 'headers-received' && e.status === 200).length, 4);
  for (const event of events) {
    assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0);
    assert.ok(Object.values(event).every(value => typeof value === 'number' ||
      ['verify-started', 'request-started', 'headers-received', 'verified',
        'artifact-downloading', 'artifact-verified', 'artifact-reused'].includes(value)));
  }
  assert.equal(JSON.stringify(events).includes('https:'), false);
  assert.equal(JSON.stringify(events).includes('synthetic'), false);
});

test('a failed download cannot emit verified progress or start the next profile', async t => {
  const directory = await cache(t), f = fixture(), events = [];
  await assert.rejects(prepareRealModels({ directory, profiles: f.profiles,
    fetchImpl: async () => new Response(Buffer.from('corrupt')),
    onProgress: event => events.push(event) }), /size mismatch/);
  assert.deepEqual(events.filter(e => e.stage === 'verify-started').map(e => e.profile), [1]);
  assert.equal(events.some(e => e.stage === 'verified'), false);
  assert.equal(events.at(-1).stage, 'headers-received');
});

test('fragmented artifact streams keep progress bounded while every original byte is verified', async t => {
  const directory = await cache(t), f = fixture(), events = [];
  let chunks = 0;
  await prepareRealModels({ directory, profiles: f.profiles,
    fetchImpl: async url => {
      const bytes = f.responses.get(url);
      return new Response(new ReadableStream({ start(controller) {
        for (const byte of bytes) { controller.enqueue(Uint8Array.of(byte)); chunks++; }
        controller.close();
      } }));
    }, onProgress: event => events.push(event) });
  assert.ok(chunks > events.length);
  assert.equal(events.filter(e => e.stage === 'artifact-downloading').length, 4);
  assert.equal(events.filter(e => e.stage === 'artifact-verified').length, 4);
  assert.equal(events.filter(e => e.stage === 'verified').length, 2);
  for (const profile of f.profiles) for (const artifact of profile.artifacts) {
    assert.deepEqual(await readFile(target(directory, profile, artifact)),
      f.responses.get(`https://huggingface.co/${profile.model}/resolve/${profile.revision}/${artifact.path}`));
  }
});
