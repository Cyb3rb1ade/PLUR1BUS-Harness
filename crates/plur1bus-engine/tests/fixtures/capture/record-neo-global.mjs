// RE-05/T4 neo-global recordings from verified pinned Node sources.
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
  if (!source.equals(expected)) throw new Error(`pinned neo-global source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/neo-arch.js");
const {createNeoStore,searchNeoCandidatesGlobal,latestNeoRevisionById,isNeoRecordAccessible}=await import(pathToFileURL(path.join(root,"lib/neo-arch.js")));
const {mkdtempSync,mkdirSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const assert=(await import("node:assert/strict")).default;
const requester={requesterAgentId:"alpha",agentId:"alpha",requesterWorkspaceKey:"workspace:v1:one"};
const now=1700000000000;
const row=(id,extra={})=>({id,agentId:"alpha",origin:{scope:"agent_private"},visibility:{scope:"agent_private",agentId:extra.agentId??"alpha"},statement:`synthetic ${id}`,status:"candidate",createdAt:now,...extra});
const defs=[
 {name:"index-basic",entries:[row("a"),row("b"),row("c")],vectors:{a:[1,0],b:[0,1],c:[0.8,0.6]}},
 {name:"fallback-inline",journal:[row("a",{embedding:[1,0]}),row("b",{embedding:[0.8,0.6]})]},
 {name:"fallback-sidecar",journal:[row("a"),row("b")],vectors:{a:[1,0],b:[0.8,0.6]}},
 {name:"missing-index-empty",journal:[]},
 {name:"empty-index",entries:[]},
 {name:"foreign",entries:[row("a"),row("foreign",{agentId:"beta"})],vectors:{a:[1,0],foreign:[1,0]}},
 {name:"latest-revoked",entries:[row("a"),row("a",{agentId:"beta",updatedAt:now+1})],vectors:{a:[1,0]}},
 {name:"latest-status",entries:[row("a"),row("a",{status:"pruned",updatedAt:now+1})],vectors:{a:[1,0]}},
 {name:"statuses",entries:["candidate","active","promoted","demoted","pruned","tombstoned","conflict"].map((status,i)=>row(`s${i}`,{status})),vectors:Object.fromEntries(Array.from({length:7},(_,i)=>[`s${i}`,[1,0]]))},
 {name:"stale-deleted",entries:[row("a",{stale:true}),row("b",{hardDeleted:true}),row("c")],vectors:{a:[1,0],b:[1,0],c:[1,0]}},
 {name:"exclude",entries:[row("a"),row("b")],vectors:{a:[1,0],b:[1,0]},excludeIds:["a"]},
 {name:"recency",entries:[row("old",{createdAt:now-30*86400000}),row("new"),row("unknown",{createdAt:"invalid"})],vectors:{old:[1,0],new:[1,0],unknown:[1,0]}},
 {name:"start-time",entries:[row("a",{createdAt:now,startTime:now-86400000}),row("b",{createdAt:"2023-11-14T22:13:20.000Z"})],vectors:{a:[1,0],b:[1,0]}},
 {name:"future",entries:[row("a",{createdAt:now+86400000})],vectors:{a:[1,0]}},
 {name:"no-vector",entries:[row("a")]},
 {name:"zero-vector",entries:[row("a")],vectors:{a:[0,0]}},
 {name:"wrong-dimensions",entries:[row("a")],vectors:{a:[1]}},
 {name:"zero-query",entries:[row("a")],vectors:{a:[1,0]},queryVector:[0,0]},
 {name:"empty-query",entries:[row("a")],vectors:{a:[1,0]},queryVector:[]},
 {name:"similarity-equal",entries:[row("a")],vectors:{a:[1,0]},minSimilarity:1},
 {name:"top-k",entries:[row("a"),row("b"),row("c")],vectors:{a:[1,0],b:[1,0],c:[1,0]},topK:1},
 {name:"partial-and-malformed",entries:[row("a")],extraRaw:"{broken\n"+JSON.stringify(row("unfinished")),vectors:{a:[1,0],unfinished:[1,0]}},
 {name:"foreign-cap-starvation",entries:[row("a",{createdAt:1}),row("b",{createdAt:2}),...Array.from({length:120},(_,i)=>row(`foreign-${i}`,{agentId:"beta",createdAt:now+i}))],vectors:{a:[1,0],b:[1,0]},maxCandidates:100},
];
function filesFor(def,authorized=false) {
 const files=[];let entries=def.entries,journal=def.journal;
 if(authorized){if(entries)entries=latestNeoRevisionById(entries).filter(row=>isNeoRecordAccessible(row,requester));if(journal)journal=latestNeoRevisionById(journal).filter(row=>isNeoRecordAccessible(row,requester));}
 if(entries)files.push({name:"candidate-index.jsonl",text:entries.map(r=>JSON.stringify(r)+"\n").join("")+(authorized?"":def.extraRaw??"")});
 if(journal)files.push({name:"memory-candidates.jsonl",text:journal.map(r=>JSON.stringify(r)+"\n").join("")});
 if(def.vectors){let offset=0;const entries={};const bytes=[];for(const [id,vector] of Object.entries(def.vectors)){const b=Buffer.alloc(vector.length*4);vector.forEach((n,i)=>b.writeFloatLE(n,i*4));entries[id]={offset,length:b.length,dims:vector.length};offset+=b.length;bytes.push(...b);}
 files.push({name:"vector-index.json",text:JSON.stringify({version:1,endian:"LE",file:"vectors.3.f32",entries})},{name:"vectors.3.f32",bytes});}
 return files;
}
function read(files,options){const scratch=mkdtempSync(path.join(tmpdir(),"neo-global-"));try {const store=createNeoStore(scratch,"workspace",{readOnly:true});mkdirSync(store.paths.workspaceDir,{recursive:true});for(const f of files)writeFileSync(path.join(store.paths.workspaceDir,f.name),f.text??Buffer.from(f.bytes));const result=searchNeoCandidatesGlobal(store,{...options,requester});delete result.ms;delete result.indexLines;return result;}finally{rmSync(scratch,{recursive:true,force:true});}}
function run(){return defs.map(def=>{const files=filesFor(def);const options={queryVector:def.queryVector??[1,0],topK:def.topK??30,minSimilarity:def.minSimilarity??0.35,halfLifeDays:30,maxCandidates:def.maxCandidates??20000,excludeIds:def.excludeIds??[],now};return {name:def.name,files,options,output:read(files,options),authorizedOutput:read(filesFor(def,true),options)};});}
const cases=run();assert.deepEqual(run(),cases);const here=path.dirname(fileURLToPath(import.meta.url));writeFileSync(path.join(here,"golden/neo-global.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},cases},null,2)+"\n");console.log(`Recorded ${cases.length} actual Node global index/fallback searches twice, plus separately recorded authorized-source observations`);
