import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '@plur1bus/config-schema';
import { engineTurnMemory } from '../../src/session/memory-port.ts';
import { channelOrigin } from '../../src/channels/behaviour-context.ts';
import { createRecallScopeProvider } from '../../src/identity/recall.ts';
import { deriveUserPrincipal } from '../../src/identity/principals.ts';
import { useIdentity } from '../identity/helpers.ts';
const fixture=useIdentity();
test('genuine two-channel pairing produces one canonical principal and the same legacy recall union',async()=>{
 const f=fixture(),human=f.human(),seen:any[]=[];
 const tg={channel:'telegram',accountId:'bot-a',userId:'sender-a'},matrix={channel:'matrix',accountId:'bot-b',userId:'sender-b'};
 f.pairAndLink(human.id,tg);f.pairAndLink(human.id,matrix);
 const port=engineTurnMemory({identity:f.svc,scope:createRecallScopeProvider(f.svc),engine:{recall:async({principal}:any)=>{seen.push(principal);return {blocks:[{name:'private',text:principal.user,chars:principal.user.length}],degraded:null};}} as any,config:defaults,agents:{workspaceOf:()=>f.dir,has:()=>true} as any,logger:{info(){},warn(){}} as any,captureSignal:new AbortController().signal,isStopping:()=>false});
 const recall=(i:typeof tg)=>channelOrigin.run({channel:i.channel,chatId:'dm',chatKind:'direct',accountId:i.accountId,senderId:i.userId,humanId:human.id},()=>port.recall({agentId:'main',caller:{channel:'cli',accountId:'host',userId:human.id},query:'private',signal:new AbortController().signal}));
 const a=await recall(tg), first=seen.splice(0);const b=await recall(matrix);assert.equal(a.text,b.text);assert.equal(first[0].user,deriveUserPrincipal(human.id));assert.deepEqual(first.map(p=>p.user),seen.map(p=>p.user));assert.equal(first[0].channel,'telegram');assert.equal(seen[0].channel,'matrix');
 await assert.rejects(recall({...matrix,userId:'unlinked'}),/no longer linked/);
});

test('pinned engine accepts registered Matrix/Buzz providers and returns linked private recall through both routes',async()=>{
 const {mkdirSync}=await import('node:fs');const {layout}=await import('../../src/paths.ts');const {createAgentRegistry}=await import('../../src/agents.ts');
 const {createLogger}=await import('../../src/logger.ts');const {buildEngineConfig}=await import('../../src/engine-config.ts');const {createHarnessHost}=await import('../../src/host.ts');const {bindEngine}=await import('../../src/engine.ts');const {flatTestInternals}=await import('../helpers/flat-embedder.ts');const {callerToPrincipal}=await import('../../src/principal.ts');
 const f=fixture(),h=f.human();const l=layout(f.dir);for(const dir of [l.state,l.logs,l.agents,l.lancedb])mkdirSync(dir,{recursive:true});const cfg=defaults();cfg.agents.main={};cfg.engine.duplicateThreshold=1.01;
 const reg=createAgentRegistry(cfg,l);reg.scaffold('main');const logger=createLogger({file:l.logFile('core'),level:'warn',role:'core'});const engineConfig=buildEngineConfig(cfg,l);const engine=bindEngine(createHarnessHost({layout:l,logger,config:cfg,engineConfig,agents:reg,events(){}}),engineConfig,flatTestInternals());
 try{
  assert.ok(engine.channels.has('matrix'));assert.ok(engine.channels.has('buzz'));await engine.models.warm();
  const a={channel:'matrix',accountId:'bot',userId:'alice'},b={channel:'buzz',accountId:'bot2',userId:'pubkey'};f.pairAndLink(h.id,a);f.pairAndLink(h.id,b);
  const principal=callerToPrincipal({channel:'cli',accountId:'host',userId:h.id},'main',reg.workspaceOf('main')!).principal;principal.user=deriveUserPrincipal(h.id);
  const imported=await engine.memory.import({agentId:'main',principal,cards:[{idempotencyKey:'m4-private-1',text:'Pat prefers an early morning appointment with Bernd.',provenance:'imported',scope:'user'}]},principal,{origin:'system',background:false});assert.ok(imported.cards.some(c=>c.outcome==='created'));
  const port=engineTurnMemory({engine,identity:f.svc,scope:createRecallScopeProvider(f.svc),config:()=>cfg,agents:reg,logger,captureSignal:new AbortController().signal,isStopping:()=>false});
  const recall=(i:typeof a)=>channelOrigin.run({channel:i.channel,chatId:'dm',accountId:i.accountId,senderId:i.userId,humanId:h.id,chatKind:'direct'},()=>port.recall({agentId:'main',caller:{channel:'cli',accountId:'host',userId:h.id},query:'Pat morning appointment Bernd',signal:new AbortController().signal}));
  const x=await recall(a),y=await recall(b);assert.match(x.text,/early morning/);assert.match(y.text,/early morning/);assert.equal(x.degraded,null);assert.equal(y.degraded,null);
 }finally{await engine.close({budgetMs:2000});await logger.close();}
});
