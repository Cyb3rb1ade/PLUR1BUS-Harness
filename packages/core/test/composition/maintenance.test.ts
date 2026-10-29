/** Actual composition must not recover jobs, watch code or start Engine work before maintenance release. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { FileJobPersistence } from "../../../media/src/jobs.ts";
import { openTurnComposition, type CompositionDeps } from "../../src/composition/index.ts";
import { createImportMaintenanceHold } from "../../src/import/maintenance-admission.ts";
import { createIdentityService } from "../../src/identity/service.ts";
import { createAgentRegistry } from "../../src/agents.ts";
import { layout } from "../../src/paths.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { SessionStore } from "../../src/session/store.ts";
import { createCallBudget } from "../../src/budget/index.ts";
import { FakePort } from "../media-search/fakes.ts";
import { useTempDirs } from "./helpers.ts";
const dirs=useTempDirs("p1b-held-composition-");
const RUN="9488a983-b15c-4281-9669-d09228686fc5";

async function rig(engine: unknown = {}, mediaSearch=false) {
  const home=dirs.make();const cfg=defaults();cfg.agents.a={};
  cfg.providers.media={adapters:[{id:"openai",model:"image-model-1"}]};
  if(mediaSearch){cfg.memory.mediaEmbedding.enabled=true;cfg.memory.mediaEmbedding.provider="local";cfg.memory.mediaEmbedding.backfill="auto";}
  const jobs=new FileJobPersistence(join(home,"media/jobs"));
  await jobs.put({id:"pending",adapter:"openai",operation:"generate",request:{prompt:"fixture"},state:"queued",progress:{fraction:0},createdAt:1,updatedAt:1});
  await mkdir(join(home,"media/outputs/.stage-0123abcd"),{recursive:true});
  await mkdir(join(home,"skills/reports"),{recursive:true});
  await writeFile(join(home,"skills/reports/SKILL.md"),"---\nname: reports\ndescription: Produce controlled report\n---\napproved workflow");
  await writeFile(join(home,"skills/index.json"),JSON.stringify({version:1,skills:[{id:"reports",enabled:true}]}));
  await mkdir(join(home,"state"),{recursive:true});
  const previousSessions=new SessionStore({path:join(home,"state/sessions.sqlite")});
  const session=previousSessions.createSession({kind:"direct",agentId:"a",owner:"local-owner"});
  const pendingTurn=previousSessions.beginTurn(session.id,"waiting",1).turn.id;previousSessions.close();
  const previousBudget=createCallBudget({path:join(home,"state/budget.sqlite"),clock:{now:()=>1}});
  const allowance=previousBudget.checkBeforeCall({principal:"local-owner",agent:"a",project:"held-fixture",turn:"held-fixture",model:"fixture",estimatedInputTokens:1,maxOutputTokens:1});
  assert.equal(allowance.kind,"allow");const reservation=allowance.reservationId;previousBudget.close();
  const logger={debug(){},info(){},warn(){},error(){},child(){return logger;},async close(){}} as never;
  const identity=createIdentityService({dbPath:join(home,"identity.sqlite"),clock:Date.now,audit:()=>{}});
  const hold=createImportMaintenanceHold(RUN);let hooks=0;
  const config:CompositionDeps={home,config:()=>cfg,engine:engine as never,agents:createAgentRegistry({config:()=>cfg},layout(home),logger),logger,
    identity,secrets:createSecretStore({keyring:createMemoryBackend(),file:createMemoryBackend(),fileFallback:()=>false,audit:createMemoryAuditSink()}),
    egress:{decide:async()=>({allowed:false})} as never,permissions:{current:()=>null,open:async()=>{throw Error("unused");}} as never,
    audit:memoryAuditSink(),clock:Date.now,signal:new AbortController().signal,isStopping:()=>false,notify:()=>{},mediaHostFetchReady:true,
    options:{onOpenAI:()=>{hooks++;},onVoice:()=>{hooks++;},providers:{profiles:{default:[{provider:"fixture",model:"fixture",adapter:{async *stream(){}}}]}}},
    ...{maintenance:{held:()=>hold.held,onRelease:hold.onRelease}},
  };
  const composition=await openTurnComposition(config);let closed=false;
  const close=async()=>{if(closed)return;closed=true;await composition.close();identity.close();};dirs.onCleanup(close);
  return {home,jobs,hold,composition,pendingTurn,reservation,hooks:()=>hooks,close};
}

it("held composition preserves queued media and staging and does not index or watch skills until release",async()=>{
  const r=await rig();
  assert.equal(r.composition.capabilities.status().entries,0);
  assert.equal((await r.jobs.get("pending"))?.state,"queued");
  assert.ok(existsSync(join(r.home,"media/outputs/.stage-0123abcd")));
  assert.equal(r.hooks(),0);
  await writeFile(join(r.home,"skills/reports/SKILL.md"),"---\ndescription: Updated controlled report\n---\nchanged");
  await new Promise(resolve=>setTimeout(resolve,75));
  assert.equal(r.composition.capabilities.status().entries,0,"no filesystem watcher runs during maintenance");
  await r.hold.release(RUN);
  assert.equal(r.composition.capabilities.status().entries,1);
  assert.equal((await r.jobs.get("pending"))?.state,"failed");
  assert.equal(existsSync(join(r.home,"media/outputs/.stage-0123abcd")),false);
  assert.equal(r.hooks(),2);
  await r.close();
});

it("held production media composition sends no backfill request before release",async()=>{
  const requests:string[]=[];
  const server=createServer((request,response)=>{requests.push(request.url??"");response.writeHead(204);response.end();});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const media=new FakePort();media.backfill.start=async()=>{await fetch(`http://127.0.0.1:${address.port}/backfill`);};
  try {
    const r=await rig({media},true);
    await new Promise(resolve=>setTimeout(resolve,75));assert.deepEqual(requests,[]);
    await r.hold.release(RUN);
    assert.deepEqual(requests,["/backfill"]);
    await r.close();
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it("closing a held composition cancels every deferred start",async()=>{
  const r=await rig();await r.close();await r.hold.release(RUN);
  assert.equal(r.hooks(),0);assert.equal((await r.jobs.get("pending"))?.state,"queued");
  assert.ok(existsSync(join(r.home,"media/outputs/.stage-0123abcd")));
  assert.equal(JSON.parse(await readFile(join(r.home,"skills/index.json"),"utf8")).skills.length,1);
});


it("held composition preserves interrupted turns and expired reservations until release",async()=>{
  const r=await rig();
  assert.equal(r.composition.sessions.store.getTurn(r.pendingTurn)?.state,"running");
  assert.equal(r.composition.budget?.reservation(r.reservation)?.expired,true);
  await r.hold.release(RUN);
  assert.equal(r.composition.sessions.store.getTurn(r.pendingTurn)?.state,"failed");
  assert.equal(r.composition.budget?.reservation(r.reservation),null);
  await r.close();
});

it("the real extension factory blocks both legacy transports before authentication or child startup",async()=>{
  const {composeExtensions}=await import("../../src/composition/extensions.ts");
  const {createWriter}=await import("../../src/logs/writer.ts");
  const {httpModern}=await import("../mcp/helpers/dual-fixture.ts");
  const {capturingLogger,caller,stdioDef,httpDef,NODE}=await import("../mcp/helpers/util.ts");
  const home=dirs.make();const cfg=defaults();const hold=createImportMaintenanceHold(RUN);const remote=await httpModern();
  const output=createWriter({dir:join(home,"logs"),role:"core.out",timers:false,source:{kind:"harness",id:"mcp",version:"0.1.0"}});
  const extensions=await composeExtensions({home,config:()=>cfg,clock:Date.now,logger:capturingLogger() as never,output,
    secrets:createSecretStore({keyring:createMemoryBackend(),file:createMemoryBackend(),fileFallback:()=>false,audit:createMemoryAuditSink()}),
    egress:{decide:async()=>({allowed:true,address:"127.0.0.1",family:4,host:"127.0.0.1",port:Number(new URL(remote.url).port)})} as never,
    maintenance:{held:()=>hold.held,onRelease:hold.onRelease}});
  try {
    extensions.registry.allowCommand(NODE);
    extensions.registry.register(stdioDef({name:"fixture"}));
    extensions.registry.register(httpDef(`${remote.url}/json`));
    for(const name of ["fixture","remote"])await assert.rejects(extensions.registry.listTools(name,caller),error=>(error as {code?:string}).code==="not-allowed");
    assert.equal(remote.requests.length,0);
    assert.equal(extensions.registry.status("fixture",caller.agentId).starts,0);
    await hold.release(RUN);
    await extensions.registry.listTools("fixture",caller);
    await extensions.registry.listTools("remote",caller);
    assert.equal(extensions.registry.status("fixture",caller.agentId).starts,1);
    assert.ok(remote.requests.length>0);
  } finally {await extensions.close();output.close();await remote.close();}
});
