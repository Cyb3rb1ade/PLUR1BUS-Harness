import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../core/src/core.ts";
import { flatTestInternals } from "../../core/test/helpers/flat-embedder.ts";
import { createCoreLink } from "../src/core-link.ts";
import { createApiServer } from "../src/server.ts";
import { LicenceLedger } from "../../core/src/licences/ledger.ts";
import { memoryAuditSink } from "../../core/src/rbac/audit.ts";
test("HTTP owner creates once through durable saga and persists model-specific licence identity",{timeout:60000},async t=>{
 const home=mkdtempSync(join(tmpdir(),"m3-p4-http-")),config=defaults();
 config.engine={neo:{enabled:false},gc:{enabled:false},obsidianBridge:{enabled:false},merging:{enabled:false},dreaming:{enabled:false},skillMiner:{enabled:false},temporalContext:{enabled:false},conversationReactivationRecall:{enabled:false},reranker:{enabled:false}};
 writeFileSync(join(home,"config.json"),JSON.stringify(config));const core=createCore({home,testInternals:flatTestInternals()});await core.start();
 const link=createCoreLink(home),ownerToken=randomBytes(32).toString("hex"),api=createApiServer({core:link,ownerToken});const {url}=await api.listen();
 t.after(async()=>{await api.close();await link.close();await core.stop({budgetMs:5000});rmSync(home,{recursive:true,force:true});});
 const login=await fetch(url+"/api/v1/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:ownerToken})});assert.equal(login.status,200);await login.text();const cookie=login.headers.get("set-cookie")!.split(";")[0]!;
 let id=0;const rpc=async(method:string,params:unknown)=>{
  const csrf=await (await fetch(url+"/api/v1/csrf",{headers:{cookie}})).json() as any;
  return await (await fetch(url+"/rpc",{method:"POST",headers:{cookie,"content-type":"application/json","x-csrf-token":csrf.token},body:JSON.stringify({jsonrpc:"2.0",id:++id,method,params})})).json() as any;
 };
 // A fresh store (no agent table yet) can still take another embedding model; the pre-check of config.set says so.
 assert.deepEqual((await rpc("model.memory.status",{})).result,{embedding:{provider:"local-transformers",model:"intfloat/multilingual-e5-small",dimensions:384,configured:false},reranker:{provider:"local-transformers",model:"woxpas-ai/bge-reranker-v2-m3-onnx"},embeddingSwitch:"allowed"});
 const gemma=[{key:"engine.embedding",value:{provider:"local-transformers",local:{model:"google/embeddinggemma-2",dimensions:768}}}];
 assert.deepEqual((await rpc("model.licence.check",{changes:gemma})).result,{ok:true});
 const unpinned=await rpc("model.licence.check",{changes:[{key:"engine.embedding.local",value:{model:"onnx-community/embeddinggemma-2-ONNX"}}]});assert.equal(unpinned.error.data.reason,"embedding-model-unavailable");
 const payload={name:"alpha",persona:"The alpha agent.",idempotencyKey:"http-create-request-alpha"};
 const [first,second]=await Promise.all([rpc("agent.create",payload),rpc("agent.create",payload)]);assert.deepEqual(first.result,{agentId:"alpha"});assert.deepEqual(second.result,{agentId:"alpha",replayed:true});
 assert.equal(Object.keys(JSON.parse(readFileSync(join(home,"config.json"),"utf8")).agents).length,1);
 const model="jinaai/jina-embeddings-v3";const confirmed=await rpc("model.licence.confirm",{model,accepted:true});assert.equal(confirmed.result.acceptance.who,"local-owner");assert.equal(confirmed.result.acceptance.revision.length,40);assert.equal(confirmed.result.acceptance.licence,"CC BY-NC-4.0");
 const ledger=new LicenceLedger(join(home,"state","model-licences.sqlite"),memoryAuditSink(),Date.now);try{assert.deepEqual(ledger.list(),[confirmed.result.acceptance]);}finally{ledger.close();}
 // The created agent's table holds the E5 vector space now: another model is a migration, never a config write.
 assert.equal((await rpc("model.memory.status",{})).result.embeddingSwitch,"migration-required");
 for (const changes of [gemma,[{key:"engine.embedding.local",value:{model,dimensions:1024}}]]) {
  const refused=await rpc("model.licence.check",{changes});assert.equal(refused.error.data.error,"E_CONFLICT");assert.equal(refused.error.data.reason,"embedding-migration-required");
 }
 assert.equal((await rpc("model.licence.check",{changes:[{key:"engine.reranker.local",value:{model:"jinaai/jina-reranker-v2-base-multilingual"}}]})).error.data.reason,"model-licence-required");
 const spoof=await rpc("model.licence.confirm",{model,accepted:true,who:"other"});assert.equal(spoof.error.data.error,"E_INVALID_PARAMS");
 const unauth=await fetch(url+"/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"agent.create",params:payload})});assert.equal(unauth.status,401);await unauth.text();
});

test.todo("KNOWN GAP: moving a store that already holds memories to another embedding model needs the pinned engine's public validation step; memory reembed stops at validating until it exists");
