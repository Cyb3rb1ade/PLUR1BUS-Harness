import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {AnthropicAccumulator,messageToEvents} from "../../src/anthropic/response.ts";
import {buildAnthropicBody} from "../../src/anthropic/request.ts";
import {carryThinking} from "../../src/anthropic/thinking.ts";
import type {ChatMessage} from "../../src/types.ts";
const signal=new AbortController().signal;
const model="claude-synthetic";
const options={stream:false,defaultMaxTokens:4096};
function request(assistant: Extract<ChatMessage,{role:"assistant"}>,target=model){return {model:target,reasoning:{vendorParam:"thinking.budget_tokens" as const,value:2048},messages:[{role:"user" as const,content:"read"},assistant,{role:"tool" as const,toolCallId:"toolu_fixture",content:"bytes"}]};}
test("fixture stream and non-stream keep complete signed and redacted blocks outside JSON; a different fallback model is refused",async()=>{
 const frames=readFileSync(new URL("../contract/fixtures/anthropic.signed-tool-round.sse",import.meta.url),"utf8").split("\n").filter(l=>l.startsWith("data: ")).map(l=>JSON.parse(l.slice(6)));
 for(const f of frames)if(f.type==="content_block_start"&&f.content_block.type==="thinking")f.content_block.vendor_hint="opaque";
 const body={type:"message",model,id:"msg_fixture",stop_reason:"tool_use",content:[{type:"thinking",thinking:"Check the fixture.",signature:"signed-fixture",vendor_hint:"opaque"},{type:"redacted_thinking",data:"redacted-fixture"},{type:"text",text:"Reading."},{type:"tool_use",id:"toolu_fixture",name:"file_read",input:{path:"fixture.txt"}}]};
 for(const events of [frames,[...messageToEvents(body)]]){
  const acc=new AnthropicAccumulator(s=>s,10000);for(const frame of events)acc.push(frame);
  const result=await acc.finish(undefined,undefined,signal);
  const assistant=carryThinking(result,{role:"assistant" as const,content:result.text,toolCalls:result.toolCalls.map(c=>({id:c.id,name:c.name,arguments:JSON.stringify(c.arguments)}))});
  const wire=buildAnthropicBody(request(assistant),options) as any;
  assert.deepEqual(wire.messages[1].content.slice(0,2),body.content.slice(0,2));
  assert.deepEqual(wire.thinking,{type:"enabled",budget_tokens:2048});
  assert.ok(!JSON.stringify({result,assistant,partial:acc.snapshot()}).includes("signed-fixture"));
  assert.throws(()=>buildAnthropicBody(request(assistant,"other-model"),options),/original signed thinking blocks/);
 }
});


test("a redacted block never hides a missing signature on another thinking block",async()=>{
 const acc=new AnthropicAccumulator(s=>s,10000);
 const body={type:"message",model,stop_reason:"tool_use",content:[{type:"thinking",thinking:"unsigned"},{type:"redacted_thinking",data:"opaque"},{type:"tool_use",id:"toolu_fixture",name:"file_read",input:{}}]};
 for(const event of messageToEvents(body))acc.push(event);
 const result=await acc.finish(undefined,undefined,signal);
 const assistant=carryThinking(result,{role:"assistant" as const,content:null,toolCalls:[{id:"toolu_fixture",name:"file_read",arguments:"{}"}]});
 assert.throws(()=>buildAnthropicBody(request(assistant),options),/original signed thinking blocks/);
});
