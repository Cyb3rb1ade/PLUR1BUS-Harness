import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../../src/session/store.ts';
import { ToolPruner, defaultPrune } from '../../src/session/pruning.ts';
function rig(pending = false) {
  const store = new SessionStore({ path: ':memory:' }), s=store.createSession({kind:'direct',agentId:'a',owner:'p'});
  const {turn}=store.beginTurn(s.id,'old task',1);
  const call=store.appendEvent(turn.id,'tool.call',{id:'c',name:'file.read',args:{path:'large.txt'}});
  store.appendEvent(turn.id,'tool.result',{id:'c',output:'HEAD '+ 'middle '.repeat(500)+' TAIL'});
  if(pending)store.appendEvent(turn.id,'tool.call',{id:'followup',name:'file.inspect',args:{ref:`event:${call.seq}`}});
  store.completeTurn(turn.id,{text:'done',tokens:1});
  const next=store.beginTurn(s.id,'new task',1);store.completeTurn(next.turn.id,{text:'new answer',tokens:1});
  return {store,s,ref:`event:${call.seq}`};
}
test('truncate preserves both ends and an original ref, with no change to stored tool events',async()=>{
  const {store,s,ref}=rig();const originals=JSON.stringify(store.toolEvents(s.id));
  const pruner=new ToolPruner(store,{...defaultPrune(),keepLastTurns:1},{decide:async batch=>batch.map(p=>({ref:p.ref,relevant:false,reason:'decision-accepted',verdict:'truncate' as const,confidence:.9}))});
  try{
    assert.equal(await pruner.run(s.id),1);const shown=pruner.view(s.id).find(p=>p.ref===ref)!;
    assert.match(shown.text,/HEAD/);assert.match(shown.text,/TAIL/);assert.match(shown.text,/truncated by compaction:.*ref event:/);
    assert.ok(shown.text.length<1500);assert.equal(JSON.stringify(store.toolEvents(s.id)),originals);
    const metrics=pruner.metrics(s.id);assert.equal(metrics.pruned,1);assert.equal(metrics.tokensSaved,Math.max(0,Math.ceil(JSON.stringify({call:store.toolEvents(s.id)[0]!.data,result:store.toolEvents(s.id)[1]!.data}).length/4)-Math.ceil(shown.text.length/4)));
    assert.equal(pruner.restore(s.id,ref),true);assert.equal(pruner.metrics(s.id).refetches,1);assert.equal(pruner.metrics(s.id).refetchRate,1);
  }finally{store.close();}
});
test('drop stub retains call name, argument digest and status, and pending follow-ups are protected',async()=>{
  for(const pending of [false,true]){
    const {store,s,ref}=rig(pending);
    const pruner=new ToolPruner(store,{...defaultPrune(),keepLastTurns:1},{decide:async batch=>batch.map(p=>({ref:p.ref,relevant:false,reason:'decision-accepted',verdict:'drop' as const,confidence:.9}))});
    try{assert.equal(await pruner.run(s.id),pending?0:1);if(!pending){const text=pruner.view(s.id).find(p=>p.ref===ref)!.text;assert.match(text,/file.read/);assert.match(text,/args-sha256 [a-f0-9]{64}/);assert.match(text,/status ok/);assert.ok(!text.includes('middle'));}}finally{store.close();}
  }
});
test('unconfident three-way answers never hide tool outputs',async()=>{
  const {store,s}=rig();const pruner=new ToolPruner(store,{...defaultPrune(),keepLastTurns:1},{decide:async batch=>batch.map(p=>({ref:p.ref,relevant:false,reason:'uncertain',verdict:'drop' as const,confidence:.2}))});
  try{assert.equal(await pruner.run(s.id),0);assert.ok(pruner.view(s.id).every(p=>!p.hidden));}finally{store.close();}
});

test('the configured pruning confidence floor decides, not a fixed 0.7',async()=>{
  const answer=(confidence:number)=>async(batch:readonly import('../../src/session/pruning.ts').ToolPair[])=>batch.map(p=>({ref:p.ref,relevant:false,reason:'decision-accepted',verdict:'drop' as const,confidence}));
  for(const [floor,confidence,hidden] of [[.5,.6,1],[.5,.4,0],[.9,.8,0],[.9,.95,1]] as const){
    const {store,s}=rig();const pruner=new ToolPruner(store,{...defaultPrune(),keepLastTurns:1},{decide:answer(confidence),minConfidence:()=>floor});
    try{assert.equal(await pruner.run(s.id),hidden,`floor ${floor}, confidence ${confidence}`);}finally{store.close();}
  }
  const {store,s}=rig();const pruner=new ToolPruner(store,{...defaultPrune(),keepLastTurns:1},{decide:answer(.65)});
  try{assert.equal(await pruner.run(s.id),0,'without a configured floor the 0.7 default applies');}finally{store.close();}
});

import { Compactor, defaultCompaction } from '../../src/session/compaction.ts';
import { TurnRunner } from '../../src/session/turn-loop.ts';
test('/compact --explain and explicit ref restore are local transcript commands without recall, capture or model calls',async()=>{
  const {store,s,ref}=rig();
  const pruner=new ToolPruner(store,{...defaultPrune(),keepLastTurns:1},{decide:async batch=>batch.map(p=>({ref:p.ref,relevant:false,reason:'decision-accepted',verdict:'truncate' as const,confidence:.9}))});
  try{
    await pruner.run(s.id);const compactor=new Compactor(store,defaultCompaction(),{pruner});
    const runner=new TurnRunner({store,compactor,provider:()=>null,memory:{recall:async()=>{throw Error('must not recall');},capture:async()=>{throw Error('must not capture');}} as never});
    const caller={channel:'cli' as const,accountId:'cli',userId:'person'};
    const explanation=await runner.submit({session:s,caller,text:'/compact --explain'}).done;
    assert.equal(explanation.state,'completed');assert.match(explanation.reply!,/truncate/);assert.match(explanation.reply!,/tokensSaved/);assert.match(explanation.reply!,new RegExp(ref));
    assert.ok(!explanation.reply!.includes('middle'));
    const afterExplain=pruner.view(s.id).find(p=>p.ref===ref)!;assert.equal(afterExplain.hidden,true);assert.match(afterExplain.text,/truncated by compaction/);
    const restored=await runner.submit({session:s,caller,text:`/compact --restore ${ref}`}).done;
    assert.equal(restored.state,'completed');assert.equal(pruner.view(s.id).find(p=>p.ref===ref)!.hidden,false);assert.equal(pruner.metrics(s.id).refetches,1);
  }finally{store.close();}
});

test('overlay and prune trace roll back together when a change targets a foreign turn',()=>{
  const {store,s,ref}=rig();const other=store.createSession({kind:'direct',agentId:'a',owner:'p'});
  const {turn}=store.beginTurn(other.id,'foreign',1);store.completeTurn(turn.id,{text:'done',tokens:1});
  const before=store.lastEventSeq(s.id);
  try{
    assert.throws(()=>store.setToolVisibilities(s.id,[{ref,turnId:turn.id,hidden:true,reason:'decision',detail:{mode:'drop',confidence:1,tokensSaved:50}}]));
    assert.deepEqual(store.toolVisibility(s.id),[]);assert.equal(store.lastEventSeq(s.id),before);
  }finally{store.close();}
});
