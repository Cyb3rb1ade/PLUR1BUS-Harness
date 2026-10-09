import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '@plur1bus/config-schema';
import { createSecretStore, createMemoryBackend, createMemoryAuditSink } from '../../src/secrets/index.ts';
import { createCallBudget, PriceBook, SHIPPED_PRICE_TABLES } from '../../src/budget/index.ts';
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
  config.providers.openaiVoice = { secretRef: 'voice.key' };
  const secrets = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink() }); await secrets.set({kind:'owner'},'voice.key','synthetic-provider-secret');
  const budget = createCallBudget({path:join(home,'budget.sqlite'),clock:{now:()=>now},prices:new PriceBook(SHIPPED_PRICE_TABLES)});
  const native = socketConnect({decide:async () => ({allowed:true, address:'127.0.0.1',family:4,host:'127.0.0.1',port:Number(new URL(server.url).port)})});
  const runtime = createVoiceRuntime({home,config:()=>config,secrets,clock:()=>now,egress:{},permissions:{open:async()=>({service:{request:async()=>({approved:false})}})},logger:{warn:(...e:unknown[])=>events.push(e)},signal:new AbortController().signal} as unknown as CompositionDeps, { audit:(e: unknown)=>events.push(e),http:{request:async()=>({status:200,body:{data:[{id:'gpt-live-1'}]}})} } as unknown as OpenAIRuntime, budget, {connect:r=>native({...r,url:server.url+new URL(r.url).pathname})});
  const client: LiveClient = {authenticated:true,person:'owner',session:'chat-a',model:'gpt-live-1',surface:'desktop:paired-a',trust:2,receive:async frame=>received(frame),closed:async()=>{closed++;}};
  const request = {agent:'a1',user:'owner',provider:'openai:gpt-live' as const,parent:{kind:'api_key' as const,region:'global' as const},surface:{authenticated:true,trust:2 as const,kind:'desktop' as const},transport:'websocket' as const,model:'gpt-live-1'};
  return {server,runtime,budget,client,request,events,audio,closed:()=>closed,advance:()=>{now+=60000;},async close(){await runtime.close();budget.close();await server.close();await rm(home,{recursive:true,force:true});}};
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
    f.budget.setLimit({scope:'global',id:'',period:'day',metric:'cost',hard:0});const noBudget=f.runtime.live.issue(f.request,f.client);await assert.rejects(f.runtime.live.redeem(noBudget.handle,f.client),{code:'budget-exceeded'});assert.equal(f.server.opens(),0);
  }finally{await f.close();}
  const e=await fixture();try{e.server.fail();const handle=e.runtime.live.issue(e.request,e.client);await assert.rejects(e.runtime.live.redeem(handle.handle,e.client),err=>{assert.equal(String(err).includes('synthetic-provider-secret'),false);return true;});}finally{await e.close();}
});
