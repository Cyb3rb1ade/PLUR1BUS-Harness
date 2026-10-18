import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createAnthropicAdapter} from "../../../providers/src/anthropic/client.ts";
import {collect,readTool,turnFixture,useTempDirs} from "./helpers.ts";
const tmp=useTempDirs("p1b-thinking-round-");
const fixture=readFileSync(new URL("../../../providers/test/contract/fixtures/anthropic.signed-tool-round.sse",import.meta.url),"utf8");
test("signed thinking survives tool aliases and a complete second round, stays out of logs and session-facing chunks",async()=>{
 const requests:any[]=[];
 const adapter=createAnthropicAdapter({baseUrl:"http://127.0.0.1:1234/v1",credentials:{apiKey:()=>"fixture"},fetch:async(_url,init)=>{
  requests.push(JSON.parse(String(init?.body)));
  const text=requests.length===1?fixture:'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-synthetic"}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Done."}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  return new Response(text,{headers:{"content-type":"text/event-stream"}});
 }});
 const budgetCalls:any[]=[];
 const f=turnFixture(adapter,{profiles:{default:[{provider:"fixture",model:"claude-synthetic",adapter}]},family:{fixture:"anthropic"},maxTokens:1024,reasoningFor:()=>({kind:"budget",levels:["high"],vendorParam:"thinking.budget_tokens",budget:{min:4096,max:4096,default:4096},source:"table"})},tmp.make());
 const check=f.budget.checkBeforeCall.bind(f.budget);
 f.budget.checkBeforeCall=(input)=>{budgetCalls.push(input);return check(input);};
 f.registry.register(readTool("file.read",async()=>"fixture bytes"));
 try {
  const chunks=await collect(f.provider,{...((await import("./helpers.ts")).turnRequest()),reasoning:"high"});
  assert.equal(requests.length,2);assert.equal(requests[0].max_tokens,5120);
  assert.equal(budgetCalls.length,2);assert.ok(budgetCalls.every(c=>c.maxOutputTokens===5120));
  assert.deepEqual(requests[1].thinking,requests[0].thinking);
  const assistant=requests[1].messages.find((m:any)=>m.role==="assistant");
  assert.deepEqual(assistant.content.slice(0,2),[{type:"thinking",thinking:"Check the fixture.",signature:"signed-fixture"},{type:"redacted_thinking",data:"redacted-fixture"}]);
  assert.equal(assistant.content.at(-1).name,"file_read");
  assert.ok(!JSON.stringify({chunks,logs:f.logs,stored:f.stored}).includes("signed-fixture"));
 }finally{f.close();}
});

test("thinking output uplift is refused before I/O by a hard token limit; an unpriced model is unknown under a hard cost limit",async()=>{
 const {scriptedAdapter,turnRequest}=await import("./helpers.ts");
 for(const metric of ["tokens","cost"] as const){
  const cloud=scriptedAdapter([{text:"must not be invoked"}]);
  const f=turnFixture(cloud.adapter,{maxTokens:1024,reasoningFor:()=>({kind:"budget",levels:["high"],vendorParam:"thinking.budget_tokens",budget:{min:4096,max:4096,default:4096},source:"table"})},tmp.make());
  try{
   f.budget.setLimit({scope:"agent",id:"a1",period:"day",metric,hard:metric==="tokens"?4000:1000000});
   await assert.rejects(()=>collect(f.provider,{...turnRequest(),reasoning:"high"}));
   assert.equal(cloud.requests.length,0,`${metric} refuses before provider I/O`);
   if(metric==="cost"){
    const decision=f.budget.checkBeforeCall({principal:"p",agent:"a1",project:"direct",model:"unpriced",provider:"fixture",estimatedInputTokens:1,maxOutputTokens:5120});
    assert.equal(decision.kind,"refuse");if(decision.kind==="refuse"){assert.equal(decision.reason,"unpriced-model");assert.equal(decision.estimate,null);}
   }
  }finally{f.close();}
 }
});
