// Actual pinned merge-decision host route and JSON parser; generated output is never hand edited.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const pin="9f34008c143c5da87b2194b5a28442b407ff8ba7";
const root=process.env.PLUR1BUS_ENGINE_SRC,repository=process.env.PLUR1BUS_ENGINE_GIT;
if(!root||!repository||process.version!=="v24.21.0")throw new Error("pinned source, read-only Git and Node 24.21.0 required");
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const sourcesSha256={};
function verify(relative){
 if(sourcesSha256[relative])return;
 const bytes=readFileSync(path.join(root,relative));const pinned=execFileSync("git",["-C",repository,"show",`${pin}:${relative}`],{maxBuffer:16*1024*1024});
 assert(bytes.equals(pinned),`source mismatch: ${relative}`);sourcesSha256[relative]=sha(bytes);
 for(const match of bytes.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)){
  const dep=path.posix.normalize(path.posix.join(path.posix.dirname(relative),match[1]));if(/\.[cm]?js$/.test(dep))verify(dep);
 }
}
verify("engine/runtime/llm-calls.js");
const {callMergeCheck}=await import(pathToFileURL(path.join(root,"engine/runtime/llm-calls.js")));
const {resolveFeatureLlmRoute}=await import(pathToFileURL(path.join(root,"lib/llm-router.js")));
const good='{"merge":true,"reason":"fixture","mergedText":"Combined synthetic fact"}';
const cases=[
 ...[good,'{"merge":false,"reason":"separate"}','{"merge":false,"reason":"","mergedText":42}','{"merge":true,"reason":"","mergedText":""}','{"merge":true,"reason":"fixture","mergedText":"A","extra":{"x":1}}',
 '{"merge":true,"mergedText":"A"}','{"merge":true,"reason":42,"mergedText":"A"}','{"merge":"true","reason":"fixture","mergedText":"A"}','{"merge":false,"reason":null}','{"merge":true,"reason":"fixture"}',
 'null','[]','42','true','"text"','{}','invalid','```json\n'+good+'\n```','','   ','\uFEFF'+good+'\u00A0','{"merge":true,"reason":"fixture","mergedText":"\\ud83d"}',
 '{"merge":false,"reason":"fixture","2":2,"1":1}','{"merge":false,"merge":true,"reason":"fixture","mergedText":"A"}']
 .map((response,i)=>({name:`response-${i}`,a:"Synthetic existing fact",b:"Synthetic additional fact",response,port:"present",config:{}})),
 ...[[null,false],[0,42],[true,{x:1}],[["one",null,"two"],["three"]],['x'.repeat(2001),'y'.repeat(2002)],['x'.repeat(1999)+'😀tail','y'.repeat(1999)+'🪟tail'],['\ud83dA','B\ude00']]
 .map(([a,b],i)=>({name:`input-${i}`,a,b,response:good,port:"present",config:{}})),
 {name:"model-override",a:"A",b:"B",response:good,port:"present",config:{model:"fixture-model"}},
 {name:"no-provider",a:"A",b:"B",response:good,port:"absent",config:{}},
 {name:"provider-failure",a:"A",b:"B",response:good,port:"reject",config:{}},
 {name:"aborted",a:"A",b:"B",response:good,port:"present",config:{},aborted:true},
];
const previousFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error("unrecorded network refused");};
async function record(){const out=[];
 for(const input of cases){
  const calls=[];const controller=new AbortController();if(input.aborted)controller.abort();
  const runtimeLlm=input.port==="absent"?undefined:{async complete(params){const{signal,...contract}=params;calls.push({contract,line:JSON.stringify(contract),signal:signal instanceof AbortSignal});if(input.port==="reject")throw new Error("synthetic route failure");return {text:input.response};}};
  let result=null,error=null;
  try{result=await callMergeCheck(input.a,input.b,resolveFeatureLlmRoute(input.config),"alpha",{runtimeLlm,signal:controller.signal});}catch(e){error=e.name;}
  out.push({...input,result,resultLine:JSON.stringify(result),error,calls});
 }
 assert(out[0].result.merge===true);assert(out[0].calls.length===1);assert(out.find(x=>x.name==="provider-failure").error);
 return out;
}
try{
 const recordings=await record();assert.deepEqual(await record(),recordings);
 const output=JSON.stringify({pin,node:process.version,sourcesSha256,boundaries:{provider:"offline synthetic host callback",network:"refused",normalization:"none"},recordings},null,2)+"\n";
 writeFileSync(new URL("./golden/merge-decision.json",import.meta.url),output);console.log(`Recorded ${recordings.length} actual merge decisions twice; ${Object.keys(sourcesSha256).length} verified sources; SHA-256 ${sha(output)}`);
}finally{globalThis.fetch=previousFetch;}
