import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '../src/client.ts';
import { createRpcServer } from '../src/rpc-server.ts';
import { createLogger } from '../src/logger.ts';
import { parityRecorder } from '../src/parity-recorder.ts';

// P4-02, mode T: the transcript recorder of the RPC server. Active only with PLUR1BUS_ALLOW_TEST_INTERNALS=1 plus an
// explicit PLUR1BUS_PARITY_RECORD=<file>; it writes request, response and notification lines as NDJSON.

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

async function drive(dir: string, token: string): Promise<void> {
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\p1b-${randomUUID()}` : join(dir, 'rpc.sock');
  const server = createRpcServer({ address, token, hello: () => ({ contract: '1.4.1', rpc: '1.6.0', instanceId: 'recorder-test', pid: process.pid }),
    logger: createLogger({ file: join(dir, 'server.log'), level: 'error', role: 'test' }),
    methods: { 'agent.list': async () => ({ agents: [] }) } });
  await server.listen();
  const client = await connect({ address, token, expectedServerPid: process.pid });
  try {
    await client.call('agent.list', {});
    await assert.rejects(client.call('agent.open', { agentId: 'main' }));
    await client.call('events.subscribe', { names: ['agent.activity'] });
    server.notify('agent.activity', { agentId: 'main', activity: { state: 'idle', since: 0 } });
    await delay(50);
  } finally { await client.close(); await server.close(); }
}

describe('parity recorder (P4-02, mode T)', () => {
  it('is off without PLUR1BUS_ALLOW_TEST_INTERNALS=1, even when a record file is named', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p1b-rec-'));
    const file = join(dir, 'out.ndjson');
    try {
      assert.equal(parityRecorder({ PLUR1BUS_PARITY_RECORD: file }), null);
      assert.equal(parityRecorder({ PLUR1BUS_ALLOW_TEST_INTERNALS: '0', PLUR1BUS_PARITY_RECORD: file }), null);
      await withEnv({ PLUR1BUS_ALLOW_TEST_INTERNALS: undefined, PLUR1BUS_PARITY_RECORD: file }, () => drive(dir, randomBytes(32).toString('hex')));
      assert.equal(existsSync(file), false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('is off without an explicit PLUR1BUS_PARITY_RECORD', async () => {
    assert.equal(parityRecorder({ PLUR1BUS_ALLOW_TEST_INTERNALS: '1' }), null);
    assert.equal(parityRecorder({ PLUR1BUS_ALLOW_TEST_INTERNALS: '1', PLUR1BUS_PARITY_RECORD: '' }), null);
  });

  it('records requests, responses, errors and notifications with a direction field, and never the token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p1b-rec-'));
    const file = join(dir, 'nested', 'out.ndjson');
    const token = randomBytes(32).toString('hex');
    try {
      await withEnv({ PLUR1BUS_ALLOW_TEST_INTERNALS: '1', PLUR1BUS_PARITY_RECORD: file }, () => drive(dir, token));
      const text = readFileSync(file, 'utf8');
      assert.ok(text.endsWith('\n'));
      assert.equal(text.includes(token), false, 'the handshake token must be redacted');
      const lines = text.trim().split('\n').map(l => JSON.parse(l));
      assert.deepEqual(lines.map(l => l.seq), lines.map((_, i) => i + 1));
      assert.ok(lines.every(l => (l.dir === 'in' || l.dir === 'out') && Number.isInteger(l.conn) && typeof l.msg === 'object'));
      assert.deepEqual(new Set(lines.map(l => l.conn)), new Set([0]), 'one connection, numbered from 0');
      const auth = lines[0];
      assert.equal(auth.dir, 'in'); assert.equal(auth.msg.method, 'core.auth'); assert.equal(auth.msg.params.token, '<token>');
      assert.deepEqual(lines.filter(l => l.dir === 'in').map(l => l.msg.method), ['core.auth', 'agent.list', 'agent.open', 'events.subscribe']);
      const outs = lines.filter(l => l.dir === 'out').map(l => l.msg);
      assert.ok(outs.some(m => m.id !== undefined && m.result?.agents !== undefined), 'the agent.list response');
      assert.ok(outs.some(m => m.id !== undefined && m.error !== undefined), 'the error response');
      assert.ok(outs.some(m => m.method === 'agent.activity' && m.id === undefined), 'the notification');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
