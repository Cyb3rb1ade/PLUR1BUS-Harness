// Behaviour suite every image adapter must pass (AG13). Each adapters-<id>.test.ts supplies only a synthetic provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter, MediaError, OutputStore } from '../src/index.ts';
import type { HttpAdapterId } from '../src/index.ts';
import type { ImageRequest } from '../src/types.ts';
import { reasonOf } from '../src/adapters/_shared/errors.ts';
import { fakeServer, json, makePng, makeLeakyPng, makeJpeg, recordingSleep, b64, SECRET_GPS, SECRET_PROMPT_HINT } from './adapters-fixtures.ts';
import type { RecordedCall, FakeServer } from './adapters-fixtures.ts';

export interface Context { bytes: Uint8Array; url: string; asUrl: boolean; refuse: boolean }
export interface ProviderSpec {
  id: HttpAdapterId; model: string;
  /** Synthetic provider answer for any request path; the suite wraps it with 429/401/abort scenarios. */
  respond(call: RecordedCall, ctx: Context): { status: number; body: unknown };
  refusal?: true; urlOutput?: true;
  /** Edit request extras; absent when the adapter has no edit. */
  edit?: Partial<ImageRequest>; mask?: true;
}
export const png = makePng();
const flat = (call: RecordedCall) => call.body;
/** True when neither the raw body nor any base64 token inside it decodes to a marker. */
export function leaks(body: string, markers: string[]): boolean {
  const tokens = body.match(/[A-Za-z0-9+/=]{24,}/g) ?? [];
  const decoded = tokens.map(t => Buffer.from(t, 'base64').toString('latin1'));
  return markers.some(m => body.includes(m) || decoded.some(d => d.includes(m)));
}
async function serve(spec: ProviderSpec, scenario: (call: RecordedCall, i: number, res: import('node:http').ServerResponse) => boolean | void, opts: { bytes?: Uint8Array; asUrl?: boolean; refuse?: boolean } = {}): Promise<FakeServer> {
  const s: FakeServer = await fakeServer((call, res, i) => {
    if (scenario(call, i, res)) return;
    if (call.method === 'GET' && call.path === '/image') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(opts.bytes ?? png); return; }
    const out = spec.respond(call, { bytes: opts.bytes ?? png, url: `${s.url}/image`, asUrl: opts.asUrl ?? false, refuse: opts.refuse ?? false }); json(res, out.status, out.body);
  });
  return s;
}
const make = (spec: ProviderSpec, base: string, extra: Record<string, unknown> = {}) => createAdapter({ id: spec.id, model: spec.model, baseUrl: base, pollMs: 1, ...extra } as never);
const rejectsWith = (code: string) => (e: unknown) => e instanceof MediaError && e.code === code;

export function behaviourSuite(spec: ProviderSpec): void {
  const name = (text: string) => `${spec.id}: ${text}`;
  test(name('generate returns the verified image with provenance'), async () => {
    const s = await serve(spec, () => false);
    try {
      const progress: number[] = [];
      const out = await make(spec, s.url).generate({ prompt: 'a tree' }, { onProgress: p => { progress.push(p.fraction); } });
      assert.deepEqual(Buffer.from(out.files[0]!.bytes), png); assert.equal(out.files[0]!.format, 'png');
      assert.equal(out.metadata.adapter, spec.id); assert.equal(out.metadata.model, spec.model); assert.equal(progress[0], 0); assert.ok(progress.includes(0.9));
    } finally { await s.close(); }
  });
  test(name('429 with Retry-After waits the advertised time and does not resubmit more than once'), async () => {
    const s = await serve(spec, (_c, i, res) => i === 0 ? (json(res, 429, { error: 'secret-123' }, { 'retry-after': '1' }), true) : false);
    const { sleep, delays } = recordingSleep();
    try {
      const out = await make(spec, s.url, { retry: { sleep } }).generate({ prompt: 'a tree' });
      assert.equal(out.files.length, 1); assert.deepEqual(delays, [1000]);
    } finally { await s.close(); }
    const always = await serve(spec, (_c, _i, res) => (json(res, 429, { error: 'secret-123' }, { 'retry-after': '1' }), true));
    try { await assert.rejects(make(spec, always.url, { retry: { sleep: recordingSleep().sleep } }).generate({ prompt: 'a tree' }), (e: unknown) => rejectsWith('quota')(e) && !String(e).includes('secret-123')); } finally { await always.close(); }
  });
  test(name('401 is an authentication failure with a stable reason and a key hint'), async () => {
    const s = await serve(spec, (_c, _i, res) => (json(res, 401, { error: { message: 'Incorrect API key provided: secret-123' } }), true));
    try {
      await assert.rejects(make(spec, s.url).generate({ prompt: 'a tree' }), (e: unknown) => {
        assert.ok(e instanceof MediaError); assert.equal(e.code, 'backend_unavailable'); assert.equal(reasonOf(e), 'auth_invalid');
        assert.match(e.message, new RegExp(`API key or secret reference for ${spec.id}`)); assert.ok(!String(e).includes('secret-123')); return true;
      });
    } finally { await s.close(); }
  });
  if (spec.refusal) test(name('a content refusal is CONTENT_REFUSED (content_policy) and is never retried or routed around'), async () => {
    const s = await serve(spec, () => false, { refuse: true });
    try { await assert.rejects(make(spec, s.url, { retry: { sleep: recordingSleep().sleep } }).generate({ prompt: 'a tree' }), rejectsWith('content_policy')); } finally { await s.close(); }
  });
  test(name('a response that is not the image it claims to be is refused'), async () => {
    for (const bytes of [Buffer.from('<html>captive portal</html>'), Buffer.from('image')]) {
      const s = await serve(spec, () => false, { bytes });
      try { await assert.rejects(make(spec, s.url).generate({ prompt: 'a tree' }), rejectsWith('invalid_response')); } finally { await s.close(); }
    }
  });
  if (spec.urlOutput) test(name('downloads are size-bounded and mislabeled content types are corrected by magic bytes'), async () => {
    const jpeg = makeJpeg(); const s = await serve(spec, () => false, { asUrl: true, bytes: jpeg });
    try { const out = await make(spec, s.url).generate({ prompt: 'a tree' }); assert.equal(out.files[0]!.format, 'jpeg'); assert.deepEqual(Buffer.from(out.files[0]!.bytes), jpeg); } finally { await s.close(); }
    const huge = await serve(spec, (c, _i, res) => { if (c.path === '/image') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(70 * 1024 * 1024) }); res.write(png); return true; } }, { asUrl: true });
    try { await assert.rejects(make(spec, huge.url).generate({ prompt: 'a tree' }), rejectsWith('too_large')); } finally { await huge.close(); }
  });
  test(name('aborting mid-flight is a cancellation and stops the request'), async () => {
    const c = new AbortController();
    const s = await serve(spec, (_call, _i, _res) => { setImmediate(() => c.abort()); return true; /* never answers */ });
    try { await assert.rejects(make(spec, s.url).generate({ prompt: 'a tree' }, { signal: c.signal }), rejectsWith('cancelled')); } finally { await s.close(); }
  });
  test(name('default stores no prompt traces; opt-in writes them; both outputs stay valid images'), async () => {
    const s = await serve(spec, () => false);
    try {
      const out = await make(spec, s.url).generate({ prompt: 'unmistakable-prompt-marker' });
      const root = await mkdtemp(join(tmpdir(), `media-${spec.id}-`));
      const off = await new OutputStore(root).put('off', { prompt: 'unmistakable-prompt-marker' }, out);
      assert.equal((await readFile(join(root, 'off', off.files[0]!.path))).includes('unmistakable-prompt-marker'), false);
      const on = await new OutputStore(root, { embedMetadata: true }).put('on', { prompt: 'unmistakable-prompt-marker' }, out);
      assert.equal((await readFile(join(root, 'on', on.files[0]!.path))).includes('unmistakable-prompt-marker'), true);
    } finally { await s.close(); }
  });
  if (spec.edit) test(name('edit sends the reference (and mask) without EXIF/GPS or textual metadata'), async () => {
    const s = await serve(spec, () => false);
    try {
      const leaky = makeLeakyPng(); const jpeg = makeJpeg({ exif: 6, comment: SECRET_PROMPT_HINT });
      await make(spec, s.url).edit({ prompt: 'make it snow', referenceImages: [{ bytes: leaky, format: 'png' }], ...(spec.mask ? { mask: { bytes: jpeg, format: 'jpeg' as const } } : {}), ...spec.edit });
      const sent = s.calls.filter(c => c.method === 'POST').map(flat).join('\n');
      assert.ok(sent.length > 0); assert.equal(leaks(sent, [SECRET_GPS, SECRET_PROMPT_HINT]), false);
      assert.ok(leaks(sent, ['IHDR']), 'the image itself is still sent');
    } finally { await s.close(); }
  });
  if (spec.edit && spec.mask) test(name('mask without a reference image is refused before any request'), async () => {
    const s = await serve(spec, () => false);
    try { await assert.rejects(make(spec, s.url).edit({ prompt: 'x', mask: { bytes: png, format: 'png' } }), rejectsWith('unsupported_parameter')); assert.equal(s.calls.length, 0); } finally { await s.close(); }
  });
  if (!spec.mask) test(name('a mask is refused before any request because the adapter does not apply masks'), async () => {
    const s = await serve(spec, () => false);
    try { await assert.rejects(make(spec, s.url).edit({ prompt: 'x', referenceImages: [{ bytes: png, format: 'png' }], mask: { bytes: png, format: 'png' } }), rejectsWith('unsupported_parameter')); assert.equal(s.calls.length, 0); } finally { await s.close(); }
  });
  test(name('maxConcurrent bounds parallel requests to the provider'), async () => {
    let active = 0; let peak = 0;
    const s = await serve(spec, (call, _i, res) => {
      if (call.method === 'GET' && call.path === '/image') return false;
      active++; peak = Math.max(peak, active);
      setTimeout(() => { active--; const out = spec.respond(call, { bytes: png, url: `${s.url}/image`, asUrl: false, refuse: false }); json(res, out.status, out.body); }, 25);
      return true;
    });
    try { const a = make(spec, s.url, { maxConcurrent: 1 }); await Promise.all([a.generate({ prompt: 'one' }), a.generate({ prompt: 'two' })]); assert.equal(peak, 1); } finally { await s.close(); }
  });
}
export { b64 };
