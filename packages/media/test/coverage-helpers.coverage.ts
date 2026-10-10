// Shared fake Core ML helper for the coverage tests. Not a test file: the package glob is test/*.test.ts.
// The helper speaks three protocols: `--capabilities` (probe), `--jsonl` (session) and the one-shot stdin JSON.
// Behaviour is chosen per request: `behave` on a JSON-Lines op, `request.prompt` as `behave:<name>`, or `model` as `behave:<name>`.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const HELPER_SOURCE = `
import { writeFileSync, symlinkSync, truncateSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const CAPS = { protocol: 'jsonl/1', ops: ['generate', 'img2img', 'list-models', 'cancel'] };
const behaviour = m => {
  if (typeof m.behave === 'string') return m.behave;
  const prompt = m.request?.prompt;
  if (typeof prompt === 'string' && prompt.startsWith('behave:')) return prompt.slice(7);
  if (typeof m.model === 'string' && m.model.startsWith('behave:')) return m.model.slice(7);
  return 'result';
};
// Writes the files a behaviour announces and returns the names it reports.
function produce(b, outputDir) {
  if (b === 'files-empty') return [];
  if (b === 'files-eleven') return Array.from({ length: 11 }, () => '0.png');
  if (b === 'files-not-array') return 'x';
  if (b === 'files-bad-name') return ['../0.png'];
  if (b === 'files-missing') return ['5.png'];
  if (b === 'files-jpeg') { writeFileSync(join(outputDir, '0.png'), JPEG); return ['0.png']; }
  if (b === 'files-huge') { writeFileSync(join(outputDir, '0.png'), PNG); truncateSync(join(outputDir, '0.png'), 64 * 1024 * 1024 + 1); return ['0.png']; }
  if (b === 'files-symlink') { symlinkSync('/etc/hosts', join(outputDir, '0.png')); return ['0.png']; }
  writeFileSync(join(outputDir, '0.png'), PNG); return ['0.png'];
}
if (argv.includes('--capabilities')) {
  const mode = argv[0];
  if (mode === 'caps-ok') { send(CAPS); process.exit(0); }
  if (mode === 'caps-extra-ops') { send({ ...CAPS, ops: [...CAPS.ops, 'future-op'] }); process.exit(0); }
  if (mode === 'caps-missing-cancel') { send({ ...CAPS, ops: CAPS.ops.filter(o => o !== 'cancel') }); process.exit(0); }
  if (mode === 'caps-wrong-protocol') { send({ ...CAPS, protocol: 'jsonl/2' }); process.exit(0); }
  if (mode === 'caps-ops-not-array') { send({ ...CAPS, ops: 'generate' }); process.exit(0); }
  if (mode === 'caps-exit-1') process.exit(1);
  if (mode === 'caps-garbage') { process.stdout.write('not json\\n'); process.exit(0); }
  if (mode === 'caps-huge') { process.stdout.write('x'.repeat(70000)); process.exit(0); }
  if (mode === 'caps-hang') setInterval(() => {}, 1000);
} else if (argv.includes('--jsonl')) {
  const held = new Map();
  const rl = createInterface({ input: process.stdin });
  rl.on('close', () => process.exit(0));
  rl.on('line', line => {
    const m = JSON.parse(line);
    if (m.op === 'cancel') {
      if (held.get(m.target) === 'deaf') return;
      if (held.has(m.target)) { held.delete(m.target); send({ id: m.target, type: 'error', code: 'cancelled' }); }
      return;
    }
    const id = m.id; const b = behaviour(m);
    if (m.op === 'list-models') { send({ id, type: 'models', models: (b === 'models-bad' || m.modelsDir === 'bad-models') ? [1] : ['sd-a', 'sd-b'] }); return; }
    if (b === 'garbage') { process.stdout.write('secret-123\\n'); return; }
    if (b === 'no-id') { send({ type: 'result' }); return; }
    if (b === 'unknown-id') { send({ id: 'nope', type: 'result' }); return; }
    if (b === 'unknown-type') { send({ id, type: 'bogus' }); return; }
    if (b === 'progress-string') { send({ id, type: 'progress', fraction: 'x' }); return; }
    if (b === 'progress-negative') { send({ id, type: 'progress', fraction: -0.1 }); return; }
    if (b === 'progress-high') { send({ id, type: 'progress', fraction: 1.5 }); return; }
    if (b === 'progress-ok') { send({ id, type: 'progress', fraction: 0.5 }); send({ id, type: 'result', op: m.op }); return; }
    if (b === 'progress-edges') { send({ id, type: 'progress', fraction: 0 }); send({ id, type: 'progress', fraction: 1 }); send({ id, type: 'result', op: m.op }); return; }
    if (b === 'huge-line') { process.stdout.write('x'.repeat(1024 * 1024 + 2)); return; }
    if (b === 'error-policy') { send({ id, type: 'error', code: 'content_policy' }); return; }
    if (b === 'error-cancelled') { send({ id, type: 'error', code: 'cancelled' }); return; }
    if (b === 'error-invalid') { send({ id, type: 'error', code: 'invalid_request' }); return; }
    if (b === 'error-model') { send({ id, type: 'error', code: 'model_not_found' }); return; }
    if (b === 'error-weird') { send({ id, type: 'error', code: 'weird-code' }); return; }
    if (b === 'crash') process.exit(3);
    if (b === 'hang' || b === 'deaf') { held.set(id, b); send({ id, type: 'progress', fraction: 0.25 }); return; }
    if (b === 'png-seed-string' || b === 'png' || b === 'png-no-seed' || b.startsWith('files-')) {
      const files = produce(b, m.outputDir);
      send({ id, type: 'progress', fraction: 0.5 });
      send({ id, type: 'result', files, ...(b === 'png-no-seed' ? {} : { seed: b === 'png-seed-string' ? 'x' : 42 }) });
      return;
    }
    send({ id, type: 'progress', fraction: 0.5 }); send({ id, type: 'result', op: m.op, files: [] });
  });
} else {
  let raw = ''; process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    const r = JSON.parse(raw); const b = behaviour(r);
    if (r.operation === 'list') {
      if (b === 'models-none' || r.modelDir === 'models-none') process.exit(0);
      send({ type: 'models', models: (b === 'models-bad' || r.modelDir === 'bad-models') ? [1] : ['sd-a', 'sd-b'] }); process.exit(0);
    }
    if (b === 'exit-2') process.exit(2);
    if (b === 'hang') { send({ type: 'progress', fraction: 0.25 }); setInterval(() => {}, 1000); return; }
    if (b === 'garbage') { process.stdout.write('nope\\n'); process.exit(0); }
    if (b === 'bogus') { send({ type: 'bogus' }); process.exit(0); }
    if (b === 'two-results') { send({ type: 'result', files: [] }); send({ type: 'result', files: [] }); process.exit(0); }
    if (b === 'progress-bad') { send({ type: 'progress', fraction: 2 }); process.exit(0); }
    if (b === 'progress-ok') { send({ type: 'progress', fraction: 0.5 }); send({ type: 'result', files: ['0.png'] }); process.exit(0); }
    if (b === 'error-policy') { send({ type: 'error', code: 'content_policy' }); process.exit(0); }
    if (b === 'error-model') { send({ type: 'error', code: 'model_not_found' }); process.exit(0); }
    if (b === 'huge') { process.stdout.write('x'.repeat(1024 * 1024 + 1)); process.exit(0); }
    if (b === 'png' || b === 'png-no-seed' || b === 'png-seed-string' || b.startsWith('files-')) {
      const files = produce(b, r.outputDir);
      send({ type: 'progress', fraction: 0.5 });
      send({ type: 'result', files, ...(b === 'png-no-seed' ? {} : { seed: b === 'png-seed-string' ? 'x' : 42 }) }); process.exit(0);
    }
    send({ type: 'result', files: [] }); process.exit(0);
  });
}
`;

export interface FakeHelper { script: string; cleanup(): Promise<void> }
/** Writes HELPER_SOURCE into a fresh temp directory. Call cleanup() in finally. */
export async function writeFakeHelper(): Promise<FakeHelper> {
  const root = await mkdtemp(join(tmpdir(), 'media-helper-cov-'));
  const script = join(root, 'helper.mjs');
  await writeFile(script, HELPER_SOURCE);
  return { script, cleanup: () => rm(root, { recursive: true, force: true }) };
}
