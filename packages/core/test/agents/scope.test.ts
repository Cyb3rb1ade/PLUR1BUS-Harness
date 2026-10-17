import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { requireAgentScope,runWithAgentScope,scopeFor } from "../../src/agents/scope.ts";
test("unscoped and cross-agent storage fail closed; concurrent contexts stay isolated",async()=>{
 assert.throws(()=>requireAgentScope());
 await Promise.all(["alpha","beta"].map(id=>runWithAgentScope(scopeFor(id,`agents/${id}`),async()=>{await Promise.resolve();assert.equal(requireAgentScope(id).agentId,id);assert.throws(()=>requireAgentScope(id==="alpha"?"beta":"alpha"));})));
});
test("worker does not inherit a parent agent scope",async()=>{
 const scopeModule=new URL("../../src/session/memory-port.ts",import.meta.url).href;
 const result=await runWithAgentScope(scopeFor("alpha","agents/alpha"),()=>new Promise(resolve=>{
  const w=new Worker(`const {parentPort}=require('node:worker_threads');import(${JSON.stringify(scopeModule)}).then(async m=>{const memory=m.engineTurnMemory({engine:{recall(){parentPort.postMessage('allowed');}},config(){return {};},agents:{workspaceOf(){return 'agents/alpha';}},logger:{},captureSignal:new AbortController().signal,isStopping(){return false;}});try{await memory.recall({agentId:'alpha',caller:{channel:'cli',accountId:'test',userId:'owner'},query:'private',signal:new AbortController().signal});parentPort.postMessage('allowed');}catch(e){parentPort.postMessage(e.error);}})`,{eval:true});w.once("message",resolve);w.once("error",resolve);
 }));assert.equal(result,"E_DENIED");
});
