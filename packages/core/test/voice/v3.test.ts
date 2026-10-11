import { it } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validate, type HarnessConfig } from '@plur1bus/config-schema';
import { validateParams, validateResult, type VoiceRealtimeProfileInput } from '@plur1bus/rpc-schema';
import { createVoiceV3, type VoiceV3Deps, VOICE_FEATURES } from '../../src/voice/v3.ts';
import { EN_FAST_TTS_MODEL, voiceV3Catalog } from '../../src/voice/v3-catalog.ts';
import { voiceRuntimeConfig } from '../../src/composition/voice.ts';
import type { Principal } from '../../src/rbac/types.ts';
import type { CallContext, NotifyOptions } from '../../src/rpc/server.ts';
import type { VoiceClient, VoiceChannel } from '../../src/voice/v2.ts';

function fixture(options: Partial<VoiceV3Deps> = {}) {
  let config: HarnessConfig = defaults(); config.agents.main = {}; config.agents.other = {};
  let principal: Principal | null = {userId:'alice',kind:'person',role:'owner'};
  const controller = new AbortController(); let downloads = 0, writes = 0, closes = 0;
  const installed = new Set<string>(); const events: {name:string;params:any;options:NotifyOptions}[] = [];
  let client: VoiceClient | undefined;
  const channel: VoiceChannel = { send() {}, speech() {}, async idle() {}, async close() { closes++; }, async setLanguage() {}, route:{kind:'local'}, engineFeatures:{reranker:'engine-fixed',postTurnRefine:'engine-fixed'} };
  const service = createVoiceV3({ config:()=>config, resolve:()=>principal, hasAgent:id=>Object.hasOwn(config.agents,id), signal:controller.signal, clock:()=>0, modelsDir:'/unused-models',
    notify:(name,params,options)=>events.push({name,params,options}),
    set:async changes=> { const next=structuredClone(config); for (const change of changes) { const keys=change.key.split('.'); let node=next as any; for (const key of keys.slice(0,-1)) node=node[key]??=( {} ); node[keys.at(-1)!]=change.value; } const result=validate(next); if (!result.ok) throw new Error(result.errors.join(';')); config=result.config; writes++; },
    installed:async (_dir,m)=>installed.has(m.id), install:async m=>{downloads++;installed.add(m.id);return '/unused-models/'+m.id;},
    metrics:()=>({speechEndToFirstAudio:{medianMs:0,p95Ms:0,samples:0},featureCost:{},windowSec:300}),
    session:id=>id==='chat-main'?{agentId:'main',owner:'alice',archivedAt:null}:undefined,
    audio:{async receive(){},stop(){}}, openTalk:async (_request,c)=>{client=c;return channel;}, ...options });
  const ctx: CallContext = {requestId:'voice-test',connectionId:'connection-alice',signal:controller.signal};
  const call = async (name:string,p:object = {},context=ctx) => {
    const params=validateParams(name,p); assert.equal(params.ok,true,JSON.stringify(params));
    const result=await service.methods[name]!(p,context); const valid=validateResult(name,result);assert.equal(valid.ok,true,JSON.stringify(valid));return result as any;
  };
  return {service,call,ctx,events,installed,config:()=>config,principal:(p:Principal|null)=>{principal=p;},get downloads(){return downloads;},get writes(){return writes;},get closes(){return closes;},get client(){return client;}};
}
it('matches UI language/profile shapes and all defaults are free of research TTS selection', async () => {
  const f=fixture();try {
    const catalog=voiceV3Catalog(); assert.equal(EN_FAST_TTS_MODEL,'kokoro-multi'); assert.equal(f.config().voice.v3.profiles.en.fast,EN_FAST_TTS_MODEL);
    assert.equal(catalog.languages.de!.tts.fast,'piper-de-thorsten-low');assert.equal(catalog.languages.de!.tts.quality,'kokoro-multi');assert.equal(catalog.languages.en!.tts.quality,'kokoro-multi');assert.equal(catalog.languages.en!.tts.fast,EN_FAST_TTS_MODEL);
    const list=await f.call('voice.language.list');assert.equal(list.languages.length,2);
    for(const language of list.languages)for(const profile of Object.values(language.profiles) as {models:{role:string;needsConfirmation:boolean}[]}[]) assert.equal(profile.models.find(m=>m.role==='tts')!.needsConfirmation,false);
    await f.call('voice.language.set',{language:'en',profile:'quality',acceptLicences:[]}); assert.deepEqual(await f.call('voice.language.get'),{language:'en',profile:'quality'});
    assert.equal(voiceRuntimeConfig(f.config()).local.profile,'quality');
  } finally {await f.service.close();}
});
it('rejects overflow atomically, identifies the first switch, and validates inherited agent budgets', async () => {
  const f=fixture();try {
    const rt: VoiceRealtimeProfileInput=structuredClone(f.config().voice.v3.realtime);
    rt.features.autoRecall={mode:'on',maxMs:600};rt.features.promptEnrichment={mode:'on',maxMs:500};
    await assert.rejects(f.call('voice.realtime.profile.set',rt),(e:any)=>e.error==='E_VOICE_BUDGET'&&e.detail==='promptEnrichment');assert.equal(f.writes,0);
    rt.features.promptEnrichment.maxMs=400;await f.call('voice.realtime.profile.set',rt);
    await assert.rejects(f.call('voice.agent.override.set',{agentId:'main',override:{features:{reranker:{mode:'on',maxMs:1}}}}),(e:any)=>e.error==='E_VOICE_BUDGET'&&e.detail==='reranker');
    await f.call('voice.agent.override.set',{agentId:'main',override:{features:{autoRecall:{mode:'off',maxMs:0},reranker:{mode:'on',maxMs:500}}}});
    const next={...rt,features:structuredClone(rt.features)};next.features.promptEnrichment.maxMs=600;
    next.features.autoRecall={mode:'off',maxMs:0};await assert.rejects(f.call('voice.realtime.profile.set',next),(e:any)=>e.error==='E_VOICE_BUDGET');
    assert.equal(f.writes,2);
  }finally{await f.service.close();}
});
it('sparse overrides inherit and clear without freezing installation defaults',async()=>{
  const f=fixture();try{
    await f.call('voice.agent.override.set',{agentId:'main',override:{endpointingMs:750}});
    let result=await f.call('voice.agent.override.get',{agentId:'main'});assert.deepEqual(result.override,{endpointingMs:750});assert.equal(result.effective.endpointingMs,750);
    await f.call('voice.agent.override.clear',{agentId:'main'});result=await f.call('voice.agent.override.get',{agentId:'main'});assert.equal(result.override,null);assert.equal(result.effective.endpointingMs,500);
    assert.equal(result.effective.features.reranker.effective,'engine-fixed');assert.equal(result.effective.features.postTurnRefine.effective,'engine-fixed');
  }finally{await f.service.close();}
});
it('all five human roles read, only Owner/Admin write, and agents read only their own override',async()=>{
  const f=fixture();try{
    for(const role of ['owner','admin','operator','member','viewer'] as const){f.principal({userId:'alice',kind:'person',role});await f.call('voice.status');if(role==='owner'||role==='admin')await f.call('voice.agent.override.clear',{agentId:'main'});else await assert.rejects(f.call('voice.agent.override.clear',{agentId:'main'}),(e:any)=>e.error==='E_DENIED');}
    f.principal({userId:'main',kind:'agent',role:'owner'});await f.call('voice.agent.override.get',{agentId:'main'});
    for(const [method,p] of [['voice.status',{}],['voice.agent.override.get',{agentId:'other'}],['voice.agent.override.clear',{agentId:'main'}]] as const)await assert.rejects(f.call(method,p),(e:any)=>e.error==='E_DENIED');
    f.principal({userId:'alice',kind:'person',role:'owner',tokenScopes:['voice.read']});await assert.rejects(f.call('voice.agent.override.clear',{agentId:'main'}),(e:any)=>e.error==='E_DENIED');f.principal(null);await assert.rejects(f.call('voice.status'),(e:any)=>e.error==='E_UNAUTHORIZED');
  }finally{await f.service.close();}
});
it('research model installation requires an explicit boolean before any disk/network access',async()=>{
  const f=fixture();try{
    const research=voiceV3Catalog().models['piper-en-lessac-low']!;
    for(const p of [{modelId:research.id},{modelId:research.id,licenseAccepted:false}]) await assert.rejects(f.call('voice.models.install',p),(e:any)=>e.error==='E_VOICE_LICENSE');assert.equal(f.downloads,0);
    await f.call('voice.models.install',{modelId:research.id,licenseAccepted:true});assert.equal(f.downloads,1);
    await assert.rejects(f.call('voice.models.install',{modelId:research.id}),(e:any)=>e.error==='E_VOICE_LICENSE');assert.equal(f.downloads,1);
    assert.deepEqual(await f.call('voice.language.get'),{language:'de',profile:'fast'});
  }finally{await f.service.close();}
});
it('binds realtime session, transcript and stop to the originating person and connection',async()=>{
  const f=fixture();try{
    const result=await f.call('voice.realtime.start',{agentId:'main',chatSessionId:'chat-main'});assert.equal(result.state,'running');assert.ok(f.service.channel(result.sessionId,f.ctx.connectionId));assert.equal(f.service.channel(result.sessionId,'connection-bob'),undefined);
    f.client!.transcript!('private transcript',true);
    for(const event of f.events){assert.deepEqual(event.options.audience,[{connectionId:'connection-alice'}]);assert.equal(event.options.optIn,true);}
    f.principal({userId:'bob',kind:'person',role:'admin'});await assert.rejects(f.call('voice.realtime.stop',{sessionId:result.sessionId},{...f.ctx,connectionId:'connection-bob'}),(e:any)=>e.error==='E_NOT_FOUND');
    await f.service.connectionClosed(f.ctx.connectionId);assert.equal(f.closes,1);const count=f.events.length;f.client!.transcript!('late text',true);assert.equal(f.events.length,count);
  }finally{await f.service.close();}
});
it('does not announce a running session without a trusted audio transport',async()=>{
  const f=fixture();
  const service=createVoiceV3({config:f.config,resolve:()=>({userId:'alice',kind:'person',role:'owner'}),hasAgent:()=>true,set:()=>null,modelsDir:'/unused',notify:()=>{},signal:f.ctx.signal,clock:()=>0,metrics:()=>({speechEndToFirstAudio:{medianMs:0,p95Ms:0,samples:0},featureCost:{},windowSec:1}),session:()=>undefined,openTalk:async()=>{throw new Error('must not open');}});
  try{await assert.rejects(service.methods['voice.realtime.start']!({agentId:'main',chatSessionId:'chat-main'},f.ctx),(e:any)=>e.error==='E_VOICE_UNAVAILABLE'&&e.reason==='no-audio-transport');}finally{await service.close();await f.service.close();}
});
it('counts missing per-feature and deferred budgets and rejects invalid configuration',async()=>{
  const f=fixture();try{
    const rt=structuredClone(f.config().voice.v3.realtime);for(const name of VOICE_FEATURES)rt.features[name]={mode:'deferred'};
    const config=structuredClone(f.config());config.voice.v3.budgetMs=399;config.voice.v3.realtime=rt;
    const invalid=validate(config);assert.equal(invalid.ok,false);
    await f.call('voice.realtime.profile.set',rt);const effective=await f.call('voice.realtime.profile.get');assert.equal(effective.features.autoRecall.mode,'deferred');
    const budget=structuredClone(f.config());budget.voice.v3.budgetMs=0;assert.equal(validate(budget).ok,false);
  }finally{await f.service.close();}
});
