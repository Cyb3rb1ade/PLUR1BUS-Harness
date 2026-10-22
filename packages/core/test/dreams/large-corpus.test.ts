import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createCandidateSource, itemsFromEngineList, readCandidateMemory} from '../../src/dreams/producer.ts';
import {harness, useTempDirs, T0} from './helpers.ts';

const dirs=useTempDirs('p1b-large-corpus-');
const cards=Array.from({length: 601}, (_, i)=>({id:`memory-${i}`,text:`fact ${i}`,scope:'agent-private',createdAt:T0-i}));

describe('dreaming over the public Engine admission limits',()=>{
 it('reads more than 100 visible cards with inclusive time pages and retains boundary ties',async()=>{
  const corpus=cards.slice(0,250).map((c,i)=>({...c,scope:i%2?'workspace':'agent-private',createdAt:T0-Math.floor(i/3)}));
  const requests:number[]=[];
  const items=await readCandidateMemory(async q=>{
   requests.push(q.until!);
   const eligible=corpus.filter(c=>c.createdAt>=q.since!&&c.createdAt<=q.until!);
   return {items:eligible.slice(0,q.limit),truncated:eligible.length>q.limit!};
  },T0);
  assert.equal(items.length,125);
  assert.deepEqual(items.map(c=>c.memoryId),corpus.filter(c=>c.scope==='agent-private').map(c=>c.id));
  assert.ok(requests.length>=3);
 });

 it('refuses an unpageable timestamp tie instead of losing cards or looping',async()=>{
  let calls=0;
  await assert.rejects(()=>readCandidateMemory(async()=>{calls++;return {items:cards.slice(0,100).map(c=>({...c,createdAt:T0})),truncated:true};},T0),/timestamp|progress/);
  assert.ok(calls<=2);
 });

 it('batches authoritative statistics at 500 ids',async()=>{
  const sizes:number[]=[];
  const source=createCandidateSource({
   list:()=>itemsFromEngineList({items:cards,truncated:false}),
   stats:async(agentId,ids)=>{
    assert.ok(ids.length<=500,'Engine stats admission limit');sizes.push(ids.length);
    return {agentId,items:ids.map(id=>({id,recalls:4,distinctQueries:3,lastRecalledAt:T0}))};
   },
  });
  const result=await source.pull('alpha');
  assert.deepEqual(sizes,[500,101]);
  assert.equal(result.length,601);
  assert.ok(result.every(c=>c.recalls===4&&c.uniqueQueries===3));
 });

 it('runs light jobs even when candidate reads fail, then reports the failure',async()=>{
  const h=harness(dirs,{over:{candidates:{pull(){throw new Error('candidate storage unavailable');}}}});
  h.captures('alpha',3);
  const result=await h.sched.runPhase('alpha','light',{trigger:'manual'});
  assert.deepEqual(h.engine.calls.map(c=>c.job),['light-dream','embedding-drain']);
  assert.equal(result.outcome,'failed');
  assert.equal(result.reason,'engine_error');
 });

 it('batches promotions and advances the ledger only after every receipt validates',async()=>{
  const sizes:number[]=[];
  const h=harness(dirs,{over:{candidates:{
   pull:()=>cards.map(c=>({content:c.text,memoryId:c.id,partition:'agent-private',recalls:4,uniqueQueries:3})),
   promote:async(agentId,ids)=>{
    assert.ok(ids.length<=500,'Engine promote admission limit');sizes.push(ids.length);
    assert.equal(h.store.listCandidates('alpha','promoted').length,0);
    return {agentId,items:ids.map(id=>({id,outcome:'promoted' as const,reason:'integrated'}))};
   },
  }}});
  h.captures('alpha',3);
  const result=await h.sched.runPhase('alpha','deep',{trigger:'manual'});
  assert.equal(result.outcome,'completed');
  assert.deepEqual(sizes,[500,101]);
  assert.equal(result.counts.promoted,601);
  assert.equal(h.store.listCandidates('alpha','promoted').length,601);
 });

 it('leaves all ledger rows open if a later promotion batch returns a foreign id',async()=>{
  let calls=0;
  const h=harness(dirs,{over:{candidates:{
   pull:()=>cards.map(c=>({content:c.text,memoryId:c.id,partition:'agent-private',recalls:4,uniqueQueries:3})),
   promote:async(agentId,ids)=>({agentId,items:ids.map(id=>({id:++calls>500?'foreign':id,outcome:'promoted' as const,reason:'integrated'}))}),
  }}});
  h.captures('alpha',3);
  assert.equal((await h.sched.runPhase('alpha','deep',{trigger:'manual'})).outcome,'failed');
  assert.equal(h.store.listCandidates('alpha','promoted').length,0);
 });
});
