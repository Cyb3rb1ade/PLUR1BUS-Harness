import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CoreMLAdapter, MediaError } from '../src/index.ts';
import { makePng } from './adapters-fixtures.ts';
const mac = { os: 'darwin', arch: 'arm64' };
async function helper(mode: string) {
  const root = await mkdtemp(join(tmpdir(), 'media-helper-')); const script = join(root, 'helper.mjs');
  await writeFile(script, `import { writeFile } from 'node:fs/promises'; import { join } from 'node:path';
let raw = ''; for await (const b of process.stdin) raw += b; const r = JSON.parse(raw);
if (r.operation === 'list') console.log(JSON.stringify({type:'models',models:['sd']}));
else if (${JSON.stringify(mode)} === 'hang') setInterval(() => {}, 1000);
else if (${JSON.stringify(mode)} === 'bad') console.log('secret-123');
else { await writeFile(join(r.outputDir,'0.png'),Buffer.from(${JSON.stringify(makePng().toString('base64'))},'base64')); console.log(JSON.stringify({type:'progress',fraction:0.5})); console.log(JSON.stringify({type:'result',files:['0.png'],seed:42})); }`);
  return { root, script };
}
test('fake Core ML helper lists models, reports progress and returns files', async () => {
  const h = await helper('ok'); const a = new CoreMLAdapter({ id: 'coreml-local', model: 'sd', helperPath: process.execPath, helperArgs: [h.script], modelDir: h.root, platform: mac });
  assert.deepEqual(await a.listModels(), ['sd']); const progress: number[] = [];
  const result = await a.generate({ prompt: 'tree' }, { onProgress: p => { progress.push(p.fraction); } });
  assert.deepEqual(Buffer.from(result.files[0]!.bytes), makePng()); assert.equal(result.metadata.seed, 42); assert.deepEqual(progress, [0.5]);
  await assert.rejects(a.edit({ prompt: 'tree' }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter'); // no reference image
});
test('helper malformed output, timeout and cancellation are sanitized', async () => {
  for (const mode of ['bad', 'hang']) {
    const h = await helper(mode); const a = new CoreMLAdapter({ id: 'coreml-local', model: 'sd', helperPath: process.execPath, helperArgs: [h.script], modelDir: h.root, timeoutMs: 100, platform: mac });
    await assert.rejects(a.generate({ prompt: 'tree' }), (e: unknown) => e instanceof MediaError && !String(e).includes('secret-123'));
    const c = new AbortController(); c.abort(); await assert.rejects(a.generate({ prompt: 'tree' }, { signal: c.signal }), (e: unknown) => e instanceof MediaError && e.code === 'cancelled');
  }
});
test('helper startup error, in-flight cancellation and unsupported parameters', async () => {
  const a = new CoreMLAdapter({ id: 'coreml-local', model: 'sd', helperPath: join(tmpdir(), 'missing-media-helper-executable'), platform: mac });
  await assert.rejects(a.generate({ prompt: 'tree' }), (e: unknown) => e instanceof MediaError && e.code === 'backend_unavailable');
  assert.throws(() => new CoreMLAdapter({ id: 'coreml-local', model: 'sd', helperPath: '', timeoutMs: -1 }));
  const h = await helper('hang'); const hanging = new CoreMLAdapter({ id: 'coreml-local', model: 'sd', helperPath: process.execPath, helperArgs: [h.script], modelDir: h.root, platform: mac });
  const c = new AbortController(); const timer = setTimeout(() => c.abort(), 80);
  try { await assert.rejects(hanging.generate({ prompt: 'tree' }, { signal: c.signal }), (e: unknown) => e instanceof MediaError && e.code === 'cancelled'); } finally { clearTimeout(timer); }
  for (const request of [{ prompt: 'tree', seed: -1 }, { prompt: 'tree', seed: 2 ** 32 }, { prompt: 'tree', size: { width: 512, height: 512 } }, { prompt: 'tree', format: 'jpeg' as const }]) await assert.rejects(hanging.generate(request));
  assert.deepEqual(hanging.capabilities(), { generate: true, edit: true, inpaint: false }); // auto: edit is advertised, the probe decides at call time
});
