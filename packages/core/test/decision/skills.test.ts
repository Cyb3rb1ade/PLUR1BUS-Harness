import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '@plur1bus/config-schema';
import { DecisionClient } from '../../src/decision/client.ts';
import { ruleSkills, selectDecisionSkills } from '../../src/decision/skills.ts';
const candidates=['rust','media','docs','tests'].map(id=>({id:`skill:${id}`,name:id,description:`help with ${id}`,confidence:.9}));
const context=()=>({agentId:'a',sessionId:'s',principal:'p',signal:new AbortController().signal});
type Mode='good'|'none'|'uncertain'|'absent'|'spread'|'second';
/** One scripted role. `spread` splits the probability 0.5/0.3/0.2 over the first three options, `second` picks the second candidate. */
function client(mode:Mode='good'){
  let calls=0;const seen:string[][]=[];
  return {get calls(){return calls;},seen,value:new DecisionClient({config:()=>defaults(),backends:mode==='absent'?{}:{role:{local:()=>true,async run(req){
    calls++;seen.push(req.options!.map(o=>o.id));
    const ids=req.options!.map(o=>o.id),real=ids.filter(i=>i!=='none');
    if(mode==='spread'){const p:[number,number,number]=[.5,.3,.2];return{id:real[0],probabilities:Object.fromEntries(ids.map(i=>[i,real.indexOf(i)>=0&&real.indexOf(i)<3?p[real.indexOf(i)]:0])),confidence:.9};}
    const id=mode==='none'?'none':mode==='second'?real[1]!:real[0]!;
    return{id,probabilities:Object.fromEntries(ids.map(i=>[i,i===id?1:0])),confidence:mode==='uncertain'?.1:.9};
  }}}})};
}
const names=(r:{name:string}[])=>r.map(x=>x.name);
test('without a decision model the rule shortlist top-3 stands, pins first, blocks winning over pins',async()=>{
  const c=client('absent');
  assert.deepEqual(names(await selectDecisionSkills(c.value,{query:'x',candidates},context())),['rust','media','docs']);
  const pinned=await selectDecisionSkills(c.value,{query:'x',candidates,pinned:['tests'],blocked:['rust']},context());
  assert.deepEqual(names(pinned),['tests','media','docs']);assert.deepEqual(pinned.map(p=>p.source),['pinned','rule','rule']);
  assert.deepEqual(names(ruleSkills({query:'x',candidates,pinned:['rust','docs'],blocked:['rust']})),['docs','media','tests']);
});
test('an uncertain answer only keeps pins and a certain "none" adds nothing',async()=>{
  const u=client('uncertain');
  const result=await selectDecisionSkills(u.value,{query:'hi',candidates,pinned:['docs']},context());
  assert.equal(u.calls,1);assert.deepEqual(names(result),['docs']);assert.deepEqual(result.map(r=>r.source),['pinned']);
  assert.deepEqual(await selectDecisionSkills(u.value,{query:'hi',candidates},context()),[]);
  const n=client('none');
  assert.deepEqual(names(await selectDecisionSkills(n.value,{query:'hi',candidates,pinned:['docs']},context())),['docs']);assert.equal(n.calls,1);
});
test('rules inject only ranked candidates above the relevance floor while pins remain authoritative',()=>{
  const scored = candidates.map((candidate,index)=>({...candidate,confidence:[.19,.2,.9,0][index]!}));
  assert.deepEqual(names(ruleSkills({query:'x',candidates:scored})),['media','docs']);
  assert.deepEqual(names(ruleSkills({query:'x',candidates:scored,pinned:['rust','tests'],blocked:['tests']})),['rust','media','docs']);
  const unscored = candidates.map(({confidence: _confidence,...candidate})=>candidate);
  assert.deepEqual(ruleSkills({query:'x',candidates:unscored}),[]);
  assert.deepEqual(names(ruleSkills({query:'x',candidates:unscored,pinned:['docs']})),['docs']);
  assert.deepEqual(ruleSkills({query:'x',candidates:candidates.map((candidate,index)=>({...candidate,confidence:[NaN,Infinity,-1,0][index]!}))}),[]);
});
test('a decision refines the shortlist with ONE call: the winner and every skill with enough probability, only those plus pins',async()=>{
  const single=client('second');
  const one=await selectDecisionSkills(single.value,{query:'media task',candidates,pinned:['docs']},context());
  assert.equal(single.calls,1);assert.deepEqual(names(one),['docs','media']);assert.deepEqual(one.map(r=>r.source),['pinned','decision']);assert.equal(one[1]!.confidence,.9);
  assert.ok(!single.seen[0]!.includes('skill:docs'),'a pinned skill is not offered again');
  const spread=client('spread');
  const many=await selectDecisionSkills(spread.value,{query:'x',candidates},context());
  assert.equal(spread.calls,1);assert.deepEqual(names(many),['rust','media','docs']);assert.ok(many.every(r=>r.source==='decision'));
  const room=client('spread');
  assert.deepEqual(names(await selectDecisionSkills(room.value,{query:'x',candidates,pinned:['tests']},context())),['tests','rust','media']);
});
test('no free slot or nothing left to choose from makes no model request',async()=>{
  const c=client();
  assert.deepEqual(names(await selectDecisionSkills(c.value,{query:'x',candidates,pinned:['rust','media','docs']},context())),['rust','media','docs']);
  assert.deepEqual(await selectDecisionSkills(c.value,{query:'x',candidates:[]},context()),[]);assert.equal(c.calls,0);
});
test('an aborted task cannot trigger skill model requests',async()=>{
  const c=client();await assert.rejects(selectDecisionSkills(c.value,{query:'rust',candidates},{...context(),signal:AbortSignal.abort()}));assert.equal(c.calls,0);
});
test('a timed-out decision falls back to the rule shortlist top-3 inside the skills budget, in one call',async()=>{
  const cfg=defaults();cfg.decision.budgets={skills:20};let calls=0;
  const c=new DecisionClient({config:()=>cfg,backends:{role:{local:()=>true,async run(req,signal){calls++;await new Promise((resolve,reject)=>{const t=setTimeout(resolve,200);signal.addEventListener('abort',()=>{clearTimeout(t);reject(Error('abort'));},{once:true});});const id=req.options![0]!.id;return{id,probabilities:Object.fromEntries(req.options!.map(o=>[o.id,o.id===id?1:0])),confidence:1};}}}});
  const started=performance.now();
  const result=await selectDecisionSkills(c,{query:'task',candidates,maxMs:20},context());
  assert.ok(performance.now()-started<150);assert.equal(calls,1);assert.deepEqual(names(result),['rust','media','docs']);assert.ok(result.every(r=>r.source==='rule'));
});
test('default skill budgets admit a routed model response beyond the old local-only deadline',async()=>{
  const c=new DecisionClient({config:()=>defaults(),backends:{role:{local:()=>true,async run(req){
    await new Promise(resolve=>setTimeout(resolve,250));
    const ids=req.options!.map(option=>option.id),id=ids[0]!;
    return{id,probabilities:Object.fromEntries(ids.map(option=>[option,option===id?1:0])),confidence:.9};
  }}}});
  const result=await selectDecisionSkills(c,{query:'rust task',candidates},context());
  assert.deepEqual(names(result),['rust']);assert.equal(result[0]!.source,'decision');
});
