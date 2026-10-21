import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaults } from '@plur1bus/config-schema';
import { createSecretStore, createMemoryBackend, createMemoryAuditSink } from '../../src/secrets/index.ts';
import { createCallBudget } from '../../src/budget/index.ts';
import { createVoiceRuntime } from '../../src/voice/runtime.ts';
import { socketConnect } from '../../src/voice/socket.ts';
import type { CompositionDeps } from '../../src/composition/index.ts';
import type { OpenAIRuntime } from '../../src/openai-auth/runtime.ts';
import { Sensitive } from '../../src/openai-auth/ports.ts';
import { localVoiceSocket } from './local-socket.ts';
import type { LiveClient } from '../../src/voice/live.ts';
async function fixture() {
  const server = await localVoiceSocket(), home = await mkdtemp(join(tmpdir(),'d110-voice-')), config = defaults(), events: unknown[] = [];
  let now = 1000000, closed = 0, received!: (v: Uint8Array) => void;
  const audio = new Promise<Uint8Array>(resolve => { received = resolve; });
  await mkdir(join(home,'state'));
  config.providers.openaiVoice = { secretRef: 'voice.key', kind: 'api_key', billing_path: 'api_key', region: 'global' };
  const secrets = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink() }); await secrets.set({kind:'owner'},'voice.key','synthetic-provider-secret');
  const budget = createCallBudget({path:join(home,'budget.sqlite'),clock:{now:()=>now}});
  const native = socketConnect({decide:async () => ({allowed:true, address:'127.0.0.1',family:4,host:'127.0.0.1',port:Number(new URL(server.url).port)})});
  const runtime = createVoiceRuntime({home,config:()=>config,secrets,clock:()=>now,egress:{},permissions:{open:async()=>({service:{request:async()=>({approved:false})}})},logger:{warn:(...e:unknown[])=>events.push(e)},signal:new AbortController().signal} as unknown as CompositionDeps, { audit:(e: unknown)=>events.push(e),http:{request:async()=>({status:200,body:{data:[{id:'gpt-live-1'}]}})} } as unknown as OpenAIRuntime, budget, {connect:r=>native({...r,url:server.url+new URL(r.url).pathname})});
  const client: LiveClient = {authenticated:true,person:'owner',session:'chat-a',model:'gpt-live-1',surface:'desktop:paired-a',trust:2,receive:async frame=>received(frame),closed:async()=>{closed++;}};
  const request = {agent:'a1',user:'owner',provider:'openai:gpt-live' as const,parent:{kind:'api_key' as const,region:'global' as const},surface:{authenticated:true,trust:2 as const,kind:'desktop' as const},transport:'websocket' as const,model:'gpt-live-1'};
  return {server,runtime,budget,client,request,events,audio,config,closed:()=>closed,advance:()=>{now+=60000;},async close(){await runtime.close();budget.close();await server.close();await rm(home,{recursive:true,force:true});}};
}
test('local WS: Live handle opens relay only after redemption and closes both sides on revoke', async () => {
  const f=await fixture();try{
    const issued=f.runtime.live.issue(f.request,f.client);assert.equal(f.server.opens(),0);
    for(const client of [{...f.client,person:'other'},{...f.client,session:'other'},{...f.client,model:'other'},{...f.client,surface:'web:other'}]) await assert.rejects(f.runtime.live.redeem(issued.handle,client),{code:'handle-binding'});
    const channel=await f.runtime.live.redeem(issued.handle,f.client);assert.equal(f.server.opens(),2);
    await channel.send(new Uint8Array([1,2]));assert.deepEqual([...await f.audio],[3,4]);assert.deepEqual([...f.server.audio[0]!],[1,2]);
    await assert.rejects(f.runtime.live.redeem(issued.handle,f.client),{code:'handle-replay'});
    await f.runtime.live.endSession('chat-a',f.client);await assert.rejects(channel.send(new Uint8Array([1,2])),{code:'handle-revoked'});assert.ok(f.closed()>0);
    assert.equal(JSON.stringify([issued,f.events,f.server.requests]).includes('synthetic-provider-secret'),false);
    assert.equal(JSON.stringify(issued).includes('vendor-session-test'),false);
  }finally{await f.close();}
});
test('Live expiration and zero budget deny before provider I/O; provider errors never reveal credential',async()=>{
  const f=await fixture();try{
    const expired=f.runtime.live.issue(f.request,f.client);f.advance();await assert.rejects(f.runtime.live.redeem(expired.handle,f.client),{code:'handle-expired'});assert.equal(f.server.opens(),0);
    const spent=f.budget.checkBeforeCall({principal:'u-other',agent:'other',project:'direct',model:'m',estimatedInputTokens:1,maxOutputTokens:0});if(spent.kind==='allow')f.budget.settle(spent.reservationId,{inputTokens:1,outputTokens:0});f.budget.setLimit({scope:'global',id:'',period:'day',metric:'tokens',hard:0});const noBudget=f.runtime.live.issue(f.request,f.client);await assert.rejects(f.runtime.live.redeem(noBudget.handle,f.client),{code:'budget-exceeded'});assert.equal(f.server.opens(),0);
  }finally{await f.close();}
  const e=await fixture();try{e.server.fail();const handle=e.runtime.live.issue(e.request,e.client);await assert.rejects(e.runtime.live.redeem(handle.handle,e.client),err=>{assert.equal(String(err).includes('synthetic-provider-secret'),false);return true;});}finally{await e.close();}
});

test('voice parent billing changes cannot reuse an API-key session request', async () => {
  const f = await fixture(); try {
    (f.config.providers.openaiVoice as any).billing_path = 'chatgpt_plan';
    await assert.rejects(f.runtime.broker.create(f.request), { code: 'credential-denied' });
    assert.equal(f.server.opens(), 0);
  } finally { await f.close(); }
});

// Realtime over WebRTC: broker POSTs the SDP, then attaches a sideband WebSocket by call id. Fake provider + sideband, no network.
async function realtimeFixture(hangupStatus = 200) {
  const home = await mkdtemp(join(tmpdir(), 'voice-rt-')), config = defaults(); await mkdir(join(home, 'state'));
  config.providers.openaiVoice = { secretRef: 'voice.key', kind: 'api_key', billing_path: 'api_key', region: 'global' };
  const secrets = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink() }); await secrets.set({ kind: 'owner' }, 'voice.key', 'synthetic-provider-secret');
  let now = 5_000_000, hangups = 0, calls = 0; let onMessage!: (raw: unknown) => Promise<void>;
  const real = createCallBudget({ path: join(home, 'budget.sqlite'), clock: { now: () => now } }); const settled: { inputTokens: number; outputTokens: number }[] = [];
  const budget = Object.assign(Object.create(real), { settle: (id: string, u: { inputTokens: number; outputTokens: number }) => { settled.push({ inputTokens: u.inputTokens, outputTokens: u.outputTokens }); return real.settle(id, u); } }) as typeof real;
  const http = { request: async (r: { url: string }) => {
    if (r.url.endsWith('/models')) return { status: 200, body: { data: [{ id: 'gpt-realtime' }] } };
    if (r.url.endsWith('/realtime/calls')) return { status: 200, body: { id: 'call-' + (++calls), sdp: 'v=0\r\nanswer' } };
    if (r.url.endsWith('/hangup')) { hangups++; return { status: hangupStatus, body: {} }; }
    return { status: 404, body: {} };
  } };
  const runtime = createVoiceRuntime({ home, config: () => config, secrets, clock: () => now, egress: {}, permissions: { open: async () => ({ service: { request: async () => ({ approved: false }) } }) }, logger: { warn: () => {} }, signal: new AbortController().signal } as unknown as CompositionDeps, { audit: () => {}, http } as unknown as OpenAIRuntime, budget, { connect: async r => { onMessage = r.onMessage as typeof onMessage; return { send: async () => {}, close: async () => {} } as never; } });
  const request = { agent: 'a1', user: 'owner', provider: 'openai:realtime' as const, parent: { kind: 'api_key' as const, region: 'global' as const }, surface: { authenticated: true, trust: 2 as const, kind: 'desktop' as const }, transport: 'webrtc' as const, model: 'gpt-realtime', sdp: 'v=0\r\noffer' };
  const ledgerSeconds = () => { const db = new DatabaseSync(join(home, 'state', 'voice-usage.sqlite')); try { return (db.prepare('SELECT COALESCE(SUM(seconds),0) AS s FROM voice_usage').get() as { s: number }).s; } finally { db.close(); } };
  return { runtime, request, settled, ledgerSeconds, hangups: () => hangups, emit: (raw: unknown) => onMessage(raw), advance: (ms: number) => { now += ms; },
    async close() { try { await runtime.close(); } finally { real.close(); await rm(home, { recursive: true, force: true }); } } };
}
test('Realtime WebRTC session is billed: response.done tokens and the call duration reach the ledgers', async () => {
  const f = await realtimeFixture(); try {
    const { sessionId } = await f.runtime.broker.create(f.request);
    await f.emit({ type: 'response.done', event_id: 'evt_1', response: { id: 'resp_1', usage: { total_tokens: 150, input_tokens: 120, output_tokens: 30 } } });
    await f.emit({ type: 'response.done', event_id: 'evt_1', response: { id: 'resp_1', usage: { input_tokens: 120, output_tokens: 30 } } }); // duplicate delivery
    await f.emit({ type: 'response.done', event_id: 'evt_2', response: { id: 'resp_2', usage: { input_tokens: 10, output_tokens: 5 } } });
    await f.emit({ type: 'response.done', event_id: 'evt_3', response: { id: 'resp_3' } }); // no usage: ignored
    assert.deepEqual(f.settled, [{ inputTokens: 120, outputTokens: 30 }, { inputTokens: 10, outputTokens: 5 }]);
    f.advance(42_000); await f.runtime.broker.close(sessionId);
    assert.equal(f.hangups(), 1); assert.equal(f.ledgerSeconds(), 42);
  } finally { await f.close(); }
});
test('a hangup answered 404/410 ends the Realtime session; any other failure keeps it for retry', async () => {
  for (const status of [404, 410]) {
    const f = await realtimeFixture(status); try {
      const { sessionId } = await f.runtime.broker.create(f.request);
      await assert.rejects(f.runtime.broker.create(f.request), { code: 'capacity-exceeded' });
      await f.runtime.broker.close(sessionId); assert.equal(f.hangups(), 1);
      assert.ok((await f.runtime.broker.create(f.request)).sessionId, 'capacity 1 is free again');
    } finally { await f.close(); }
  }
  const f = await realtimeFixture(500); try {
    const { sessionId } = await f.runtime.broker.create(f.request);
    await assert.rejects(f.runtime.broker.close(sessionId)); await assert.rejects(f.runtime.broker.create(f.request), { code: 'capacity-exceeded' });
  } finally { await assert.rejects(f.close()); } // shutdown reports the session whose hangup keeps failing
});
