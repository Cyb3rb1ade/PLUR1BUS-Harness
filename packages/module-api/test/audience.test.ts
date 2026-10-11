import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '../src/client.ts';
import { createRpcServer } from '../src/rpc-server.ts';
import { createLogger } from '../src/logger.ts';

it('audiences isolate connections and persons, fail closed, and preserve events without audiences', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p1b-audience-'));
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\p1b-${randomUUID()}` : join(dir, 'rpc.sock');
  const token = randomBytes(32).toString('hex');
  const people = new Map<string, string>(); const ids: string[] = [];
  let pendingIdentity: Promise<string> | undefined;
  const server = createRpcServer({ address, token, hello: () => ({ contract: '1.4.1', rpc: '1.6.0', instanceId: 'audience-test', pid: process.pid }), logger: createLogger({ file: join(dir, 'server.log'), level: 'error', role: 'core' }),
    methods: { 'agent.list': async (_p, ctx) => { if (!ids.includes(ctx.connectionId)) ids.push(ctx.connectionId); return { agents: [] }; } },
    personOfConnection: id => id === ids[0] && pendingIdentity ? pendingIdentity : people.get(id), onConnectionClosed: id => people.delete(id) });
  await server.listen();
  const clients = [];
  try {
    for (let i = 0; i < 3; i++) {
      const client = await connect({ address, token, expectedServerPid: process.pid }); clients.push(client); await client.call('agent.list', {});
    }
    people.set(ids[0]!, 'alice'); people.set(ids[1]!, 'bob');
    const received: string[][] = [[], [], []]; clients.forEach((c,i) => c.onNotification(name => received[i]!.push(name)));
    await clients[0]!.call('events.subscribe', {}); await clients[1]!.call('events.subscribe', {});
    await clients[2]!.call('events.subscribe', { agentId: 'main' });
    const transcript = { sessionId: 'voice-main', agentId: 'main', text: 'Private words', final: true };
    server.notify('voice.realtime.transcript', transcript, { audience: [{ connectionId: ids[0]! }] });
    await delay(25); assert.deepEqual(received, [['voice.realtime.transcript'], [], []]);
    server.notify('voice.realtime.transcript', transcript, { audience: [{ personId: 'bob' }] });
    await delay(25); assert.deepEqual(received, [['voice.realtime.transcript'], ['voice.realtime.transcript'], []]);
    server.notify('voice.realtime.transcript', transcript, { audience: [] });
    server.notify('voice.realtime.transcript', transcript, { audience: [{ personId: 'unknown' }] });
    server.notify('voice.realtime.transcript', transcript, { audience: ['unassigned-agent'] });
    await delay(25); assert.deepEqual(received, [['voice.realtime.transcript'], ['voice.realtime.transcript'], []]);
    server.notify('agent.activity', { agentId: 'main', activity: { state: 'idle', since: 0 } });
    await delay(25); assert.deepEqual(received.map(r => r.at(-1)), ['agent.activity','agent.activity','agent.activity']);
    let release!: (id: string) => void; pendingIdentity = new Promise(resolve => { release = resolve; });
    server.notify('voice.realtime.transcript', transcript, { audience: [{ personId: 'alice' }] });
    await clients[0]!.close(); await delay(25); release('alice');
    await delay(25); assert.equal(received[0]!.length, 2); // no late delivery to the disconnected connection
    pendingIdentity = undefined;
    server.notify('voice.realtime.transcript', transcript, { audience: [{ connectionId: ids[0]! }] });
    await delay(25); assert.equal(received[1]!.length, 2);
  } finally { await Promise.all(clients.map(c => c.close())); await server.close(); await rm(dir, { recursive: true, force: true }); }
});
