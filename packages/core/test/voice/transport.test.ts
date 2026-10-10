import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceFetch, voiceSockets, pollyRequestHandler } from '../../src/voice/transport.ts';
import type { Egress } from '../../src/egress/service.ts';
test('all voice transports deny before any socket is constructed', async () => {
  const seen: string[] = [];
  const egress = { async decide(url: string) { seen.push(url); return { allowed: false, reason: 'denied' }; } } as unknown as Egress;
  await assert.rejects(voiceFetch(egress)('https://audio.invalid/asr', { method: 'POST', body: new Blob(['audio']) }), /voice egress denied/);
  await assert.rejects(voiceSockets(egress)('wss://audio.invalid/live', {}), /voice egress denied/);
  await assert.rejects(pollyRequestHandler(egress).handle({ protocol: 'https:', hostname: 'audio.invalid', path: '/tts', method: 'POST', headers: {}, body: 'hello' }), /voice egress denied/);
  assert.deepEqual(seen, ['https://audio.invalid/asr', 'https://audio.invalid/live', 'https://audio.invalid/tts']);
});
