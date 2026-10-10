import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CoreMLAdapter, MediaError } from '../src/index.ts';
import type { CoreMLConfig } from '../src/coreml.ts';
import { reasonOf } from '../src/adapters/_shared/errors.ts';
import { writeFakeHelper } from './coverage-helpers.coverage.ts';
import type { FakeHelper } from './coverage-helpers.coverage.ts';
import { makePng, makeJpeg } from './adapters-fixtures.ts';

const code = (c: string) => (e: unknown) => e instanceof MediaError && e.code === c;
const mac = { os: 'darwin', arch: 'arm64' };
const PNG = makePng();
// The bytes the fake helper writes for a successful file (see coverage-helpers.coverage.ts).
const HELPER_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII=', 'base64');

// Every adapter built by a test is closed in withHelper's finally, so a failed assertion cannot leave a helper running.
const live: CoreMLAdapter[] = [];
function build(config: CoreMLConfig): CoreMLAdapter { const a = new CoreMLAdapter(config); live.push(a); return a; }
async function withHelper<T>(fn: (helper: FakeHelper) => Promise<T>): Promise<T> {
  const helper = await writeFakeHelper();
  try { return await fn(helper); } finally {
    await Promise.all(live.splice(0).map(a => a.close()));
    await helper.cleanup();
  }
}
/** Adapter that runs the fake helper. `args` are the helper's own arguments (a probe mode for auto detection). */
function adapterFor(helper: FakeHelper, extra: Partial<CoreMLConfig> = {}, args: string[] = []): CoreMLAdapter {
  return build({ id: 'coreml-local', model: 'sd', helperPath: process.execPath, helperArgs: [helper.script, ...args], modelDir: '/models', platform: mac, timeoutMs: 5000, cancelGraceMs: 0, ...extra } as CoreMLConfig);
}
const prompt = (behave: string) => ({ prompt: `behave:${behave}` });
const never = () => new AbortController().signal;

test('construction refuses empty paths, a non-positive or non-finite timeout, and every out-of-range option', () => {
  const base = { id: 'coreml-local' as const, model: 'sd', helperPath: '/bin/helper' };
  const bad: Partial<CoreMLConfig>[] = [
    { helperPath: '' }, { model: '' }, { timeoutMs: 0 }, { timeoutMs: -5 }, { timeoutMs: Number.NaN },
    { computeUnits: 'gpu' as never }, { scheduler: 'has space' }, { scheduler: 'a'.repeat(65) }, { scheduler: 'bad/slash' },
    { strength: 0 }, { strength: 1.5 }, { strength: Number.NaN }, { protocol: 'legacy' as never }, { cancelGraceMs: -1 }, { cancelGraceMs: 60001 },
  ];
  for (const extra of bad) assert.throws(() => new CoreMLAdapter({ ...base, ...extra } as CoreMLConfig), code('unsupported_parameter'), JSON.stringify(extra));
});

test('construction accepts every boundary value and keeps the config it was given', () => {
  const base = { id: 'coreml-local' as const, model: 'sd', helperPath: '/bin/helper' };
  const edges: Partial<CoreMLConfig>[] = [
    { timeoutMs: 1 }, { scheduler: 'a'.repeat(64) }, { scheduler: 'DPM_solver-2.0' }, { strength: 1 }, { strength: 0.01 },
    { cancelGraceMs: 0 }, { cancelGraceMs: 60000 }, { computeUnits: 'cpuAndGPU' }, { computeUnits: 'all' }, { protocol: 'oneshot' }, { protocol: 'jsonl' },
  ];
  for (const extra of edges) assert.doesNotThrow(() => new CoreMLAdapter({ ...base, ...extra } as CoreMLConfig), JSON.stringify(extra));
  const adapter = new CoreMLAdapter({ ...base, timeoutMs: 1 });
  assert.equal(adapter.id, 'coreml-local'); assert.equal(adapter.model, 'sd'); assert.equal(adapter.config.timeoutMs, 1);
});

test('capabilities advertise edit unless the protocol is pinned to the one-shot helper', () => {
  const helper = { script: '/unused', cleanup: async () => undefined };
  assert.deepEqual(adapterFor(helper as FakeHelper).capabilities(), { generate: true, edit: true, inpaint: false });
  assert.deepEqual(adapterFor(helper as FakeHelper, { protocol: 'jsonl' }).capabilities(), { generate: true, edit: true, inpaint: false });
  assert.deepEqual(adapterFor(helper as FakeHelper, { protocol: 'oneshot' }).capabilities(), { generate: true, edit: false, inpaint: false });
});

test('availability is true only on darwin/arm64 and carries a stable reason everywhere else', () => {
  const helper = { script: '/unused', cleanup: async () => undefined } as FakeHelper;
  assert.deepEqual(adapterFor(helper, { platform: { os: 'darwin', arch: 'arm64' } }).availability(), { available: true });
  for (const platform of [{ os: 'darwin', arch: 'x64' }, { os: 'linux', arch: 'arm64' }, { os: 'win32', arch: 'x64' }]) {
    const availability = adapterFor(helper, { platform }).availability();
    assert.equal(availability.available, false, JSON.stringify(platform));
    assert.equal((availability as { reason: string }).reason, 'coreml_unavailable_platform');
  }
  const detected = new CoreMLAdapter({ id: 'coreml-local', model: 'sd', helperPath: '/bin/helper' }).availability();
  assert.equal(detected.available, process.platform === 'darwin' && process.arch === 'arm64');
});

test('generate, edit and listModels refuse to start off Apple silicon, with a reason that names the platform', async () => {
  await withHelper(async helper => {
    const linux = adapterFor(helper, { platform: { os: 'linux', arch: 'x64' } });
    const error = await linux.generate({ prompt: 'x' }).then(() => undefined, (e: unknown) => e);
    assert.equal((error as MediaError).code, 'backend_unavailable');
    assert.equal(reasonOf(error), 'coreml_unavailable_platform');
    await assert.rejects(linux.edit({ prompt: 'x', referenceImages: [{ bytes: PNG, format: 'png' }] }), code('backend_unavailable'));
    await assert.rejects(linux.listModels(), code('backend_unavailable'));
  });
});

test('requests with unsupported options are refused before any helper starts', async () => {
  await withHelper(async helper => {
    const a = adapterFor(helper, { protocol: 'jsonl' });
    const refused: [string, unknown][] = [
      ['seed -1', { ...prompt('png'), seed: -1 }], ['seed 1.5', { ...prompt('png'), seed: 1.5 }], ['seed 2^32', { ...prompt('png'), seed: 2 ** 32 }],
      ['seed NaN', { ...prompt('png'), seed: Number.NaN }], ['aspect', { ...prompt('png'), aspect: '1:1' }], ['size', { ...prompt('png'), size: { width: 64, height: 64 } }],
      ['jpeg output', { ...prompt('png'), format: 'jpeg' }], ['empty prompt', { prompt: '' }],
      ['reference', { ...prompt('png'), referenceImages: [{ bytes: PNG, format: 'png' }] }], ['mask', { ...prompt('png'), mask: { bytes: PNG, format: 'png' } }],
    ];
    for (const [name, req] of refused) await assert.rejects(a.generate(req as never), code('unsupported_parameter'), name);
  });
});

test('seed boundaries 0 and 0xffffffff and an explicit png format are accepted', async () => {
  await withHelper(async helper => {
    const a = adapterFor(helper, { protocol: 'jsonl' });
    for (const seed of [0, 0xffffffff]) assert.equal((await a.generate({ ...prompt('png'), seed })).files.length, 1, String(seed));
    assert.equal((await a.generate({ ...prompt('png'), format: 'png' })).files[0]!.format, 'png');
    await a.close();
  });
});

test('generate returns the helper file as PNG with metadata, marks partial results, and reports progress as running', async () => {
  await withHelper(async helper => {
    for (const protocol of ['jsonl', 'oneshot'] as const) {
      const a = adapterFor(helper, { protocol });
      const progress: unknown[] = [];
      const result = await a.generate({ ...prompt('png') }, { onProgress: p => { progress.push(p); } });
      assert.deepEqual(Buffer.from(result.files[0]!.bytes), HELPER_PNG, protocol);
      assert.equal(result.files[0]!.format, 'png');
      assert.equal(result.metadata.seed, 42);
      assert.equal(result.metadata.origin, 'local'); assert.equal(result.metadata.costUsd, 0); assert.equal(result.metadata.adapter, 'coreml-local');
      assert.ok(result.metadata.durationMs >= 0);
      assert.equal(result.partial, false, protocol);
      assert.deepEqual(progress, [{ fraction: 0.5, stage: 'running' }], protocol);
      const partial = await a.generate({ ...prompt('png'), n: 3 });
      assert.equal(partial.partial, true, protocol);
      const ten = await a.generate({ ...prompt('png'), n: 10 });
      assert.equal(ten.partial, true, protocol);
      await a.close();
    }
  });
});

test('a helper that reports a seed that is not a number, or none, returns no seed in the metadata', async () => {
  await withHelper(async helper => {
    for (const protocol of ['jsonl', 'oneshot'] as const) {
      const a = adapterFor(helper, { protocol });
      assert.equal('seed' in (await a.generate(prompt('png-seed-string'))).metadata, false, `${protocol} string seed`);
      assert.equal('seed' in (await a.generate(prompt('png-no-seed'))).metadata, false, `${protocol} no seed`);
      await a.close();
    }
  });
});

test('file lists the helper reports are validated: empty, too many, not an array, bad names, missing, not PNG', async () => {
  await withHelper(async helper => {
    const cases: [string, string][] = [
      ['files-empty', 'invalid_response'], ['files-eleven', 'invalid_response'], ['files-not-array', 'invalid_response'],
      ['files-bad-name', 'invalid_response'], ['files-jpeg', 'invalid_response'], ['files-missing', 'backend_unavailable'],
    ];
    for (const protocol of ['jsonl', 'oneshot'] as const) {
      const a = adapterFor(helper, { protocol });
      for (const [behave, expected] of cases) await assert.rejects(a.generate(prompt(behave)), code(expected), `${protocol} ${behave}`);
      await a.close();
    }
  });
});

test('a sparse output file over 64 MiB and a symbolic link in the output are both refused as too_large', async () => {
  await withHelper(async helper => {
    for (const protocol of ['jsonl', 'oneshot'] as const) {
      const a = adapterFor(helper, { protocol });
      await assert.rejects(a.generate(prompt('files-huge')), code('too_large'), `${protocol} huge`);
      await assert.rejects(a.generate(prompt('files-symlink')), code('too_large'), `${protocol} symlink`);
      await a.close();
    }
  });
});

test('one-shot helper failures map to stable codes: policy refusals stay policy, other errors are unavailable, junk is invalid', async () => {
  await withHelper(async helper => {
    const a = adapterFor(helper, { protocol: 'oneshot' });
    const cases: [string, string][] = [
      ['error-policy', 'content_policy'], ['error-model', 'backend_unavailable'], ['bogus', 'invalid_response'], ['two-results', 'invalid_response'],
      ['garbage', 'invalid_response'], ['huge', 'invalid_response'], ['progress-bad', 'invalid_response'], ['exit-2', 'backend_unavailable'],
    ];
    for (const [behave, expected] of cases) {
      const error = await a.generate(prompt(behave)).then(() => undefined, (e: unknown) => e);
      assert.equal((error as MediaError).code, expected, behave);
      assert.equal(String(error).includes('nope'), false, behave);
    }
    await a.close();
  });
});

test('one-shot progress that is valid is forwarded, and a progress callback that throws fails the request', async () => {
  await withHelper(async helper => {
    const a = adapterFor(helper, { protocol: 'oneshot' });
    const seen: number[] = [];
    const ok = await a.generate(prompt('png'), { onProgress: p => { seen.push(p.fraction); } });
    assert.deepEqual(seen, [0.5]); assert.equal(ok.files.length, 1);
    await assert.rejects(a.generate(prompt('png'), { onProgress: () => { throw new Error('ui-broke'); } }), code('invalid_response'));
  });
});

test('a session helper that fails with a policy code, a model error, a crash, or junk maps the same way as the one-shot one', async () => {
  await withHelper(async helper => {
    const a = adapterFor(helper, { protocol: 'jsonl' });
    await assert.rejects(a.generate(prompt('error-policy')), code('content_policy'));
    await assert.rejects(a.generate(prompt('error-model')), code('unsupported_parameter'));
    await assert.rejects(a.generate(prompt('crash')), code('backend_unavailable'));
    await assert.rejects(a.generate(prompt('garbage')), code('invalid_response'));
    assert.equal((await a.generate(prompt('png'))).files.length, 1); // restarted helper still serves
    await a.close();
  });
});

test('a caller abort while the helper works cancels the job in both protocols', async () => {
  await withHelper(async helper => {
    for (const protocol of ['jsonl', 'oneshot'] as const) {
      const a = adapterFor(helper, { protocol });
      const caller = new AbortController();
      await assert.rejects(a.generate(prompt('hang'), { signal: caller.signal, onProgress: () => { caller.abort(); } }), code('cancelled'), protocol);
      await a.close();
    }
  });
});

test('a caller that aborted before the call is cancelled without a helper answer, in both protocols', async () => {
  await withHelper(async helper => {
    const caller = new AbortController(); caller.abort();
    for (const protocol of ['jsonl', 'oneshot'] as const) {
      const a = adapterFor(helper, { protocol });
      await assert.rejects(a.generate(prompt('png'), { signal: caller.signal }), code('cancelled'), protocol);
      await assert.rejects(a.listModels({ signal: caller.signal }), code('cancelled'), `${protocol} list`);
      await a.close();
    }
  });
});

test('edit needs exactly one reference and no mask, and runs only where the helper supports img2img', async () => {
  await withHelper(async helper => {
    const jpeg = makeJpeg({ exif: 6 });
    const pinnedOneShot = adapterFor(helper, { protocol: 'oneshot' });
    await assert.rejects(pinnedOneShot.edit({ ...prompt('png'), referenceImages: [{ bytes: PNG, format: 'png' }] }), code('unsupported_parameter'));
    const session = adapterFor(helper, { protocol: 'jsonl' });
    await assert.rejects(session.edit({ ...prompt('png') }), code('unsupported_parameter'), 'no reference');
    await assert.rejects(session.edit({ ...prompt('png'), referenceImages: [{ bytes: PNG, format: 'png' }, { bytes: PNG, format: 'png' }] }), code('unsupported_parameter'), 'two references');
    await assert.rejects(session.edit({ ...prompt('png'), referenceImages: [{ bytes: PNG, format: 'png' }], mask: { bytes: PNG, format: 'png' } }), code('unsupported_parameter'), 'mask');
    const edited = await session.edit({ ...prompt('png'), referenceImages: [{ bytes: jpeg, format: 'jpeg' }] });
    assert.deepEqual(Buffer.from(edited.files[0]!.bytes), HELPER_PNG);
    assert.equal(edited.metadata.seed, 42);
    await session.close(); await pinnedOneShot.close();
  });
});

test('listModels returns the helper list in both protocols, uses the default models directory when none is set, and rejects non-string entries', async () => {
  await withHelper(async helper => {
    // No modelDir: the adapter falls back to the default models directory under the home folder.
    const session = build({ id: 'coreml-local', model: 'sd', helperPath: process.execPath, helperArgs: [helper.script], platform: mac, protocol: 'jsonl' });
    assert.deepEqual(await session.listModels(), ['sd-a', 'sd-b']);
    const oneShot = build({ id: 'coreml-local', model: 'sd', helperPath: process.execPath, helperArgs: [helper.script], platform: mac, protocol: 'oneshot' });
    assert.deepEqual(await oneShot.listModels(), ['sd-a', 'sd-b']);
    const badSession = adapterFor(helper, { protocol: 'jsonl', modelDir: 'bad-models' });
    await assert.rejects(badSession.listModels(), code('invalid_response'));
    const badOneShot = adapterFor(helper, { protocol: 'oneshot', modelDir: 'bad-models' });
    await assert.rejects(badOneShot.listModels(), code('invalid_response'));
    await session.close(); await badSession.close();
  });
});

test('listModels reports a one-shot helper that answers with no list as backend_unavailable', async () => {
  await withHelper(async helper => {
    const a = adapterFor(helper, { protocol: 'oneshot', modelDir: 'models-none' });
    await assert.rejects(a.listModels(), code('backend_unavailable'));
  });
});

test('auto detection uses the session when the helper announces jsonl/1 and the one-shot protocol when it does not', async () => {
  await withHelper(async helper => {
    const session = adapterFor(helper, {}, ['caps-ok']);
    assert.equal((await session.generate(prompt('png'))).files.length, 1);
    assert.equal(session.capabilities().edit, true);
    await session.close();
    const legacy = adapterFor(helper, {}, ['caps-missing-cancel']);
    assert.equal((await legacy.generate(prompt('png'))).files.length, 1);
    assert.equal(legacy.capabilities().edit, true); // auto still advertises edit; the probe decides at call time
    await assert.rejects(legacy.edit({ ...prompt('png'), referenceImages: [{ bytes: PNG, format: 'png' }] }), code('unsupported_parameter'));
    await legacy.close();
  });
});

test('a helper given directly as an executable (no arguments, no cancel grace) runs the session with default settings', async () => {
  await withHelper(async helper => {
    const dir = await mkdtemp(join(tmpdir(), 'media-coreml-exec-'));
    try {
      const wrapper = join(dir, 'media-coreml');
      await writeFile(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(helper.script)} "$@"\n`);
      await chmod(wrapper, 0o755);
      const a = build({ id: 'coreml-local', model: 'sd', helperPath: wrapper, platform: mac, protocol: 'jsonl' });
      assert.equal((await a.generate(prompt('png'))).files.length, 1);
      await a.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

test('close is safe before any request, after one, and repeatedly', async () => {
  await withHelper(async helper => {
    const a = adapterFor(helper, { protocol: 'jsonl' });
    await a.close();
    await a.generate(prompt('png'));
    await a.close(); await a.close();
    assert.equal((await a.generate(prompt('png'))).files.length, 1); // a fresh helper after close
    await a.close();
  });
});

test('the default timeout and grace are used when none are configured', async () => {
  await withHelper(async helper => {
    // No timeoutMs or cancelGraceMs: the adapter uses its 300 s budget and the session's 2 s grace.
    const a = build({ id: 'coreml-local', model: 'sd', helperPath: process.execPath, helperArgs: [helper.script], modelDir: '/models', platform: mac, protocol: 'oneshot' });
    assert.equal((await a.generate(prompt('png'), { signal: never() })).files.length, 1);
    assert.equal(a.config.cancelGraceMs, undefined);
  });
});
