import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '@plur1bus/config-schema';
import { DecisionClient } from '../../src/decision/client.ts';
import { selectDecisionSkills } from '../../src/decision/skills.ts';
const candidates=['rust','media','docs','tests'].map(id=>({id:`skill:${id}`,name:id,description:`help with ${id}`}));
const context=()=>({agentId:'a',sessionId:'s',principal:'p',signal:new AbortController().signal});
function client(mode:'good'|'none'|'uncertain'|'absent'='good'){
  let calls=0;
  return {get calls(){return calls;},value:new DecisionClient({config:()=>defaults(),backends:mode==='absent'?{}:{role:{local:()=>true,async run(req){calls++;const id=mode==='none'?'none':req.options!.find(o=>o.id!=='none')!.id;return{id,probabilities:Object.fromEntries(req.options!.map(o=>[o.id,o.id===id?1:0])),confidence:mode==='uncertain'?.1:.9};}}}})};
}
test('final skill selection respects blocks over pins and includes at most three unique skills',async()=>{
  const c=client();const result=await selectDecisionSkills(c.value,{query:'rust and media',candidates,pinned:['rust','docs'],blocked:['rust']},context());
  assert.deepEqual(result.map(r=>r.name),['docs','media','tests']);assert.equal(c.calls,2);assert.ok(result.every(r=>r.source==='pinned'||r.confidence===.9));
});
test('none, low confidence and unavailable backend add no dynamic skill, preserving valid pins',async()=>{
  for(const mode of ['none','uncertain','absent'] as const){const c=client(mode);const result=await selectDecisionSkills(c.value,{query:'hi',candidates,pinned:['docs']},context());assert.deepEqual(result.map(r=>r.name),['docs']);}
});
test('an aborted task cannot trigger skill model requests',async()=>{
  const c=client();await assert.rejects(selectDecisionSkills(c.value,{query:'rust',candidates},{...context(),signal:AbortSignal.abort()}));assert.equal(c.calls,0);
});
test('a single shared skill budget stops sequential choices without resetting time',async()=>{
  const cfg=defaults();cfg.decision.budgets={skills:20};let calls=0;
  const c=new DecisionClient({config:()=>cfg,backends:{role:{local:()=>true,async run(req,signal){calls++;await new Promise((resolve,reject)=>{const t=setTimeout(resolve,15);signal.addEventListener('abort',()=>{clearTimeout(t);reject(Error('abort'));},{once:true});});const id=req.options![0]!.id;return{id,probabilities:Object.fromEntries(req.options!.map(o=>[o.id,o.id===id?1:0])),confidence:1};}}}});
  const result=await selectDecisionSkills(c,{query:'task',candidates,maxMs:20},context());assert.ok(result.length<=1);assert.ok(calls<=2);
});
