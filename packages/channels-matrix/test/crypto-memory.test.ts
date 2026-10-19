import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatrixMemoryCrypto, type CryptoRequest, type CryptoTransport } from '../src/crypto-memory.ts';
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import { ALICE, BOT, ROOM } from './helpers/fake-matrix.ts';

class CryptoServer {
  readonly devices = new Map<string, Record<string, unknown>>();
  readonly oneTime = new Map<string, Record<string, unknown>>();
  readonly inbox = new Map<string, { sender: string; type: string; content: Record<string, unknown> }[]>();
  transport(user: string, device: string): CryptoTransport {
    return { members: async () => [ALICE, BOT], request: async req => this.request(user, device, req) };
  }
  async request(user: string, device: string, request: CryptoRequest): Promise<string> {
    const body = JSON.parse(request.body);
    if (request.type === 0) {
      if (body.device_keys) this.devices.set(`${user}|${device}`, body.device_keys);
      this.oneTime.set(`${user}|${device}`, { ...this.oneTime.get(`${user}|${device}`), ...body.one_time_keys });
      return JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } });
    }
    if (request.type === 1) {
      const device_keys: Record<string, unknown> = {};
      for (const wanted of Object.keys(body.device_keys)) {
        device_keys[wanted] = Object.fromEntries([...this.devices].filter(([key]) => key.startsWith(`${wanted}|`)).map(([key, value]) => [key.split('|')[1]!, value]));
      }
      return JSON.stringify({ device_keys, failures: {}, master_keys: {}, self_signing_keys: {}, user_signing_keys: {} });
    }
    if (request.type === 2) {
      const one_time_keys: Record<string, Record<string, unknown>> = {};
      for (const [wanted, devices] of Object.entries(body.one_time_keys)) for (const d of Object.keys(devices as object)) {
        const keys = this.oneTime.get(`${wanted}|${d}`) ?? {};
        const key = Object.keys(keys)[0];
        if (key) { (one_time_keys[wanted] ??= {})[d] = { [key]: keys[key] }; delete keys[key]; }
      }
      return JSON.stringify({ one_time_keys, failures: {} });
    }
    if (request.type === 3) {
      for (const [wanted, devices] of Object.entries(body.messages)) for (const [d, content] of Object.entries(devices as Record<string, Record<string, unknown>>)) {
        const key = `${wanted}|${d}`; const list = this.inbox.get(key) ?? [];
        list.push({ sender: user, type: request.event_type!, content }); this.inbox.set(key, list);
      }
      return '{}';
    }
    if (request.type === 4) return '{}';
    throw new Error('unexpected crypto test request');
  }
  take(user: string, device: string) { const key = `${user}|${device}`; const events = this.inbox.get(key) ?? []; this.inbox.delete(key); return { next_batch: 's1', to_device: { events } }; }
}

test('real WASM: memory E2EE encrypts/decrypts; default rejects an unverified sender', async () => {
  const server = new CryptoServer();
  const alice = await MatrixMemoryCrypto.open(ALICE, 'A', server.transport(ALICE, 'A'), 'allow');
  const bot = await MatrixMemoryCrypto.open(BOT, 'B', server.transport(BOT, 'B'), 'allow');
  const rejecting = await MatrixMemoryCrypto.open(BOT, 'C', server.transport(BOT, 'C'));
  try {
    const content = await alice.encrypt(ROOM, 'm.room.message', { msgtype: 'm.text', body: 'encrypted fixture' });
    assert.equal(content.algorithm, 'm.megolm.v1.aes-sha2');
    assert.ok(!JSON.stringify(content).includes('encrypted fixture'));
    await bot.receive(server.take(BOT, 'B')); await rejecting.receive(server.take(BOT, 'C'));
    const event = { type: 'm.room.encrypted', event_id: '$one', sender: ALICE, origin_server_ts: Date.now(), content };
    assert.equal((await bot.decrypt(ROOM, event)).content.body, 'encrypted fixture');
    await assert.rejects(rejecting.decrypt(ROOM, event));
  } finally { await alice.close(); await bot.close(); await rejecting.close(); }
});

test('real WASM: memory restart generates a different public device identity; persistent store is unavailable in Node', async () => {
  const server = new CryptoServer();
  const first = await MatrixMemoryCrypto.open(ALICE, 'A', server.transport(ALICE, 'A'));
  const key1 = JSON.stringify(server.devices.get(`${ALICE}|A`)); await first.close();
  const second = await MatrixMemoryCrypto.open(ALICE, 'A', server.transport(ALICE, 'A'));
  try { assert.notEqual(JSON.stringify(server.devices.get(`${ALICE}|A`)), key1); }
  finally { await second.close(); }
  assert.equal(typeof globalThis.indexedDB, 'undefined');
  await assert.rejects(wasm.StoreHandle.open('m4-persistent-probe', 'fixture-passphrase'));
});

test('real WASM: SAS flows are actor-bound and verify only after matching owner confirmations', async () => {
  const server = new CryptoServer();
  const alice = await MatrixMemoryCrypto.open(ALICE, 'A', server.transport(ALICE, 'A'), 'allow');
  const bot = await MatrixMemoryCrypto.open(BOT, 'B', server.transport(BOT, 'B'), 'allow');
  let phase = 'start';
  const pump = async () => { await alice.receive(server.take(ALICE, 'A')); await bot.receive(server.take(BOT, 'B')); };
  try {
    const started = await alice.verification({ actor: 'owner-a', action: 'start', userId: BOT, deviceId: 'B' });
    const flowId = String(started.flowId); await pump();
    await assert.rejects(alice.verification({ actor: 'intruder', action: 'inspect', flowId }));
    phase = 'bot accept'; await bot.verification({ actor: 'owner-b', action: 'accept', userId: ALICE, flowId }); await pump();
    phase = 'alice accept'; await alice.verification({ actor: 'owner-a', action: 'accept', flowId });
    for (let i = 0; i < 6; i++) await pump();
    phase = 'inspect'; const a = await alice.verification({ actor: 'owner-a', action: 'inspect', flowId });
    const b = await bot.verification({ actor: 'owner-b', action: 'inspect', flowId });
    assert.ok(a.decimals); assert.deepEqual(a.decimals, b.decimals); assert.deepEqual(a.emoji, b.emoji);
    assert.equal(a.done, false); assert.equal(b.done, false);
    phase = 'confirm'; await alice.verification({ actor: 'owner-a', action: 'confirm', flowId });
    await bot.verification({ actor: 'owner-b', action: 'confirm', flowId });
    for (let i = 0; i < 4; i++) await pump();
    phase = 'done'; assert.equal((await alice.verification({ actor: 'owner-a', action: 'inspect', flowId })).done, true);
    assert.equal((await bot.verification({ actor: 'owner-b', action: 'inspect', flowId })).done, true);
  } catch (cause) { throw new Error(`SAS test phase: ${phase}`, { cause }); } finally { await alice.close(); await bot.close(); }
});
