// RE-05/T4 neo-prelude recordings from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file> [--write-data]
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "b097045b6f115275baa8b15016321c3ba080c812";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") throw new Error("pinned source, read-only git and Node 24.21.0 required");
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned neo-prelude source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/neo-arch.js");verify("engine/recall/neo-prelude.js");
const {createNeoStore,searchNeoCandidatesGlobal,dedupeNeoLanesAgainstTexts,formatNeoRecallContext}=await import(pathToFileURL(path.join(root,"lib/neo-arch.js")));
const {readNeoPrelude}=await import(pathToFileURL(path.join(root,"engine/recall/neo-prelude.js")));
const {mkdtempSync,mkdirSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const assert=(await import("node:assert/strict")).default;
const requester={requesterAgentId:"alpha",agentId:"alpha",requesterWorkspaceKey:"workspace:v1:one"};const now=1700000000000;
const row=(id,extra={})=>({id,agentId:"alpha",origin:{scope:"agent_private",trustLevel:"user_asserted"},visibility:{scope:"agent_private",agentId:extra.agentId??"alpha"},category:"project_fact",statement:"green memory workspace",createdAt:now,...extra});
const defs=[
 {name:"window",candidates:[row("a",{embedding:[1,0]})],behavior:[row("b",{category:"behavior_feedback",statement:"remember clear responses",embedding:[0,1]})]},
 {name:"empty"},
 {name:"global-only",entries:[row("index-only")],vectors:{"index-only":[1,0]}},
 {name:"global-disabled",globalEnabled:false,entries:[row("index-only")],vectors:{"index-only":[1,0]}},
 {name:"global-excludes-window",candidates:[row("a",{embedding:[1,0]})],entries:[row("a"),row("b")],vectors:{a:[1,0],b:[1,0]}},
 {name:"dedupe-global-only",candidates:[row("a",{embedding:[1,0]})],entries:[row("a"),row("b")],vectors:{a:[1,0],b:[1,0]},excludeTexts:["green memory workspace"]},
 {name:"provider-failure",candidates:[row("a")],failure:true,entries:[row("b")],vectors:{b:[1,0]}},
 {name:"foreign",candidates:[row("a",{agentId:"beta"})],entries:[row("b",{agentId:"beta"})],vectors:{b:[1,0]}},
 {name:"warm",candidates:[row("a",{embedding:[1,0]})],entries:[row("b")],vectors:{b:[1,0]},warmOnly:true},
];
async function run(){const cases=[];for(const def of defs){const scratch=mkdtempSync(path.join(tmpdir(),"neo-prelude-"));try{
 const store=createNeoStore(scratch,"workspace",{readOnly:true});mkdirSync(store.paths.workspaceDir,{recursive:true});const files=[];
 for(const [name,rows] of [["memory-candidates.jsonl",def.candidates],["behavior-cards.jsonl",def.behavior],["candidate-index.jsonl",def.entries]])if(rows){files.push({name,text:rows.map(r=>JSON.stringify(r)+"\n").join("")});}
 if(def.vectors){const entries={};let offset=0;const bytes=[];for(const [id,vector] of Object.entries(def.vectors)){const b=Buffer.alloc(vector.length*4);vector.forEach((n,i)=>b.writeFloatLE(n,i*4));entries[id]={offset,length:b.length,dims:vector.length};offset+=b.length;bytes.push(...b);}files.push({name:"vector-index.json",text:JSON.stringify({version:1,endian:"LE",file:"vectors.1.f32",entries})},{name:"vectors.1.f32",bytes});}
 for(const f of files)writeFileSync(path.join(store.paths.workspaceDir,f.name),f.text??Buffer.from(f.bytes));
 const calls=[];const embeddings={embedQuery:async(prompt,options)=>{calls.push({prompt,options});if(def.failure)throw new Error("synthetic provider failure");return [1,0];}};
 const globalEnabled=def.globalEnabled!==false;let globalCalls=0;
 const runNeoGlobalSearch=(store,items,queryVector,requester)=>{if(!globalEnabled || !queryVector?.length)return null;globalCalls++;const excludeIds=new Set(items.map(r=>r.id?String(r.id):"").filter(Boolean));const global=searchNeoCandidatesGlobal(store,{queryVector,requester,excludeIds,now,topK:30,minSimilarity:0.35,halfLifeDays:30,maxCandidates:20000});for(const hit of global.hits)items.push(hit.item);return new Set(global.hits.map(hit=>String(hit.item.id)));};
 const prelude={};const {neoLanes,neoGlobalIds}=await readNeoPrelude({neoStore:store,requester,prompt:"green memory workspace",embeddings,embedTimeoutMs:4000,timeoutSymbol:Symbol("timeout"),runNeoGlobalSearch,logger:{warn(){},debug(){}},prelude});
 let lanes=neoLanes;const excludeTexts=def.excludeTexts??[];if(neoGlobalIds?.size && excludeTexts.length)lanes=dedupeNeoLanesAgainstTexts(lanes,excludeTexts,{onlyIds:neoGlobalIds,threshold:0.8}).lanes;
 const output=def.warmOnly?"":formatNeoRecallContext(lanes,{idempotencyKey:"fixture-turn"});
 for(const f of files)assert.deepEqual([...readFileSync(path.join(store.paths.workspaceDir,f.name))],[...Buffer.from(f.text??f.bytes)]);
 cases.push({name:def.name,files,globalEnabled,failure:def.failure??false,warmOnly:def.warmOnly??false,excludeTexts,prompt:"green memory workspace",calls,globalCalls,output});
 }finally{rmSync(scratch,{recursive:true,force:true});}}return cases;}
const cases=await run();assert.deepEqual(await run(),cases);const here=path.dirname(fileURLToPath(import.meta.url));writeFileSync(path.join(here,"golden/neo-prelude.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},cases},null,2)+"\n");console.log(`Recorded ${cases.length} actual Node readNeoPrelude/file/format compositions twice with deterministic offline query embeddings`);
