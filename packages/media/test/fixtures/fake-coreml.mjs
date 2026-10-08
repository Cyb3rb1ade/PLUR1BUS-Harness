// Fake `media-coreml` for tests: speaks the one-shot protocol (legacy) and the JSON-Lines protocol (--jsonl).
// argv: <mode> <logfile> [flags]. No model, no Core ML. Output PNG is a synthetic 1x1 image.
import { appendFileSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const [mode = 'ok', log = '', ...flags] = process.argv.slice(2);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII=', 'base64');
const note = line => { if (log) appendFileSync(log, line + '\n'); };
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
if (flags.includes('--capabilities')) {
  if (mode === 'legacy') process.exit(1);
  send({ protocol: 'jsonl/1', ops: ['generate', 'img2img', 'list-models', 'cancel'] }); process.exit(0);
}
if (!flags.includes('--jsonl')) {
  // legacy one-shot: one JSON object on stdin
  let raw = ''; for await (const chunk of process.stdin) raw += chunk; const r = JSON.parse(raw);
  note('oneshot ' + r.operation);
  if (r.operation === 'list') send({ type: 'models', models: ['legacy-sd'] });
  else { writeFileSync(join(r.outputDir, '0.png'), PNG); send({ type: 'progress', fraction: 0.5 }); send({ type: 'result', files: ['0.png'], seed: 7 }); }
  process.exit(0);
}
note('start');
const starts = () => readFileSync(log, 'utf8').split('\n').filter(l => l === 'start').length; // crash only the first process
const held = new Map(); // id -> cancel resolver
const rl = createInterface({ input: process.stdin });
async function handle(req) {
  const { id, op } = req; note('request ' + JSON.stringify(req));
  if (op === 'cancel') { held.get(req.target)?.(); return; }
  if (op === 'list-models') { send({ id, type: 'models', models: ['sd-split', 'sd-original'] }); return; }
  if (mode === 'garbage') { process.stdout.write('secret-123\n'); return; }
  if (mode === 'crash' && starts() === 1) process.exit(1);
  if (mode === 'policy') { send({ id, type: 'error', code: 'content_policy' }); return; }
  if (mode === 'bad-code') { send({ id, type: 'error', code: 'model_not_found' }); return; }
  if (mode === 'hold' || mode === 'deaf') {
    send({ id, type: 'progress', fraction: 0.25 });
    if (mode === 'deaf') return; // never answers, ignores cancel
    await new Promise(resolve => held.set(id, resolve)); send({ id, type: 'error', code: 'cancelled' }); return;
  }
  const names = mode === 'traversal' ? ['../escape.png'] : mode === 'symlink' ? ['0.png'] : ['0.png'];
  if (mode === 'symlink') symlinkSync('/etc/hosts', join(req.outputDir, '0.png')); else if (mode !== 'traversal') writeFileSync(join(req.outputDir, '0.png'), PNG);
  send({ id, type: 'progress', fraction: 0.5 }); send({ id, type: 'result', files: names, seed: 42 });
}
rl.on('line', line => { void handle(JSON.parse(line)); });
rl.on('close', () => process.exit(0));
