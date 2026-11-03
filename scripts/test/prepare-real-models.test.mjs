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
