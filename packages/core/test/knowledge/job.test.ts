import { test } from "node:test";
import assert from "node:assert/strict";
const load=()=>import("../../src/knowledge/job.ts" as string);

test("knowledge.update dispatches the A1 job per registered agent through a closed argument surface",async()=>{
  const {createKnowledgeUpdateJob}=await load();
  const calls:any[]=[];
  const engine={jobs:{list:()=>[{name:"knowledge-update"}],run:async(...args:any[])=>{calls.push(args);return{runId:"r",job:"knowledge-update",outcome:"completed"};}}};
  const handler=createKnowledgeUpdateJob({engine,agents:()=>["alpha","beta"],now:()=>100});
  assert.equal(handler.spec.needsLlm,false);
  assert.equal(handler.spec.singleton,true);
  assert.deepEqual(handler.validateArgs(undefined),{});
  assert.throws(()=>handler.validateArgs({unknown:true}),/unknown/);
  assert.throws(()=>handler.validateArgs({agentId:"ghost"}),/unknown/);
  const controller=new AbortController();
  const result=await handler.run(handler.validateArgs({agentId:"alpha"}),{signal:controller.signal,runId:"sys",trigger:"manual"});
  assert.equal(result.outcome,"completed");
  assert.deepEqual(calls.map(c=>c.slice(0,2)),[["knowledge-update","alpha"]]);
  assert.equal(calls[0][2].signal,controller.signal);
  assert.equal(calls[0][2].trigger,"manual");
});
test("missing contract stays explicitly unavailable and a cancelled run dispatches nothing",async()=>{
  const {createKnowledgeUpdateJob}=await load();
  let calls=0;
  const handler=createKnowledgeUpdateJob({engine:{jobs:{list:()=>[],run:async()=>{calls++;throw new Error("must not dispatch");}}},agents:()=>["alpha"],now:()=>0});
  const signal=new AbortController();
  const context={signal:signal.signal,runId:"s",trigger:"harness"};
  assert.equal((await handler.run({},context)).reason,"engine-contract-unavailable");
  signal.abort();
  assert.equal((await handler.run({},context)).outcome,"abandoned");
  assert.equal(calls,0);
});
test("all-agent sweep stops between agents when shutting down, and overlapping runs are refused",async()=>{
  const {createKnowledgeUpdateJob}=await load();
  let release!:()=>void;
  const latch=new Promise<void>(resolve=>{release=resolve;});
  const calls:string[]=[];
  const shutdown=new AbortController();
  const handler=createKnowledgeUpdateJob({engine:{jobs:{list:()=>[{name:"knowledge-update"}],run:async(_job:string,agent:string)=>{calls.push(agent);await latch;return{outcome:"completed"};}}},agents:()=>["alpha","beta"],now:()=>0});
  const context={signal:shutdown.signal,runId:"s",trigger:"cron"};
  const first=handler.run({},context);
  assert.equal((await handler.run({},context)).reason,"already-running");
  shutdown.abort();release();
  assert.equal((await first).outcome,"abandoned");
  assert.deepEqual(calls,["alpha"]);
});
test.todo("Controller pin 1.17.0: real high-importance capture → pending → system knowledge.update → KNOWLEDGE.md → recall");

test("periodic knowledge job re-arms after errors and abort cancels its pending timer",async()=>{
  const {armKnowledgeUpdate}=await load();
  const {FakeClock}=await import("../../src/discovery/testing.ts");
  const clock=new FakeClock(0);
  let next=100,calls=0,warnings=0;
  const shutdown=new AbortController();
  const job={list:()=>[{name:"knowledge.update",nextRunAt:next}],run:async()=>{calls++;next=clock.now()+100;throw new Error("fixture failure");}};
  armKnowledgeUpdate(job,clock,shutdown.signal,{warn:()=>{warnings++;}});
  assert.equal(clock.pending(),1);
  await clock.advance(100);
  assert.equal(calls,1);assert.equal(warnings,1);assert.equal(clock.pending(),1);
  shutdown.abort();
  assert.equal(clock.pending(),0);
  await clock.advance(500);
  assert.equal(calls,1);
});

test("registry failure before handler startup uses a bounded retry delay instead of a zero-delay spin",async()=>{
  const {armKnowledgeUpdate}=await load();
  const delays:number[]=[];const callbacks:(()=>void|Promise<void>)[]=[];
  const signal=new AbortController();
  armKnowledgeUpdate({list:()=>[{name:"knowledge.update",nextRunAt:0}],run:async()=>{throw new Error("ledger unavailable");}},
    {now:()=>100,setTimer:(fn:any,ms:number)=>{delays.push(ms);callbacks.push(fn);return{cancel(){}};}},signal.signal,{warn(){}});
  await callbacks[0]!();
  assert.equal(delays.length,2);
  assert.ok(delays[1]!>=1000,`retry delay must be bounded, got ${delays[1]}`);
  signal.abort();
});

test("unknown Engine outcomes cannot be recorded as completed maintenance",async()=>{
  const {createKnowledgeUpdateJob}=await load();
  const handler=createKnowledgeUpdateJob({engine:{jobs:{list:()=>[{name:"knowledge-update"}],run:async()=>({outcome:"unexpected"})}},agents:()=>["alpha"],now:()=>0});
  const result=await handler.run({}, {signal:new AbortController().signal,runId:"sys",trigger:"manual"});
  assert.equal(result.outcome,"failed");
  assert.equal(result.reason,"engine-job-invalid-result");
});
