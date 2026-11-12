// RE-05/T4 neo-routing recordings from verified pinned Node sources.
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
  if (!source.equals(expected)) throw new Error(`pinned neo-routing source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/neo-arch.js");
const {routeNeoRecall,scoreNeoRecallItem,dedupeNeoLanesAgainstTexts,NEO_RECALL_LANES}=await import(pathToFileURL(path.join(root,"lib/neo-arch.js")));
const assert=(await import("node:assert/strict")).default;
const requester={requesterAgentId:"alpha",agentId:"alpha",requesterWorkspaceKey:"workspace:v1:one"};
const row=(id,extra={})=>({id,agentId:"alpha",origin:{scope:"agent_private",trustLevel:"user_asserted",role:"user"},visibility:{scope:"agent_private",agentId:extra.agentId??"alpha"},createdAt:1700000000000,statement:"Build green memory workspace",...extra});
const defs=[];
const categories=["project_fact","workspace_rule","architecture_decision","technical_constraint","tooling_constraint","user_preference","communication_style","behavior_feedback","failure","bug","assistant_mistake_candidate","open_question","todo","dream_synthesis","code_context","file_context","curation_note","unknown"];
for(const category of categories)defs.push({name:`category-${category}`,items:[row("a",{category})]});
for(const status of ["candidate","active","promoted","demoted","pruned","tombstoned","conflict"])defs.push({name:`status-${status}`,items:[row("a",{status})]});
for(const epistemicStatus of ["untrusted","observed","corroborated","trusted","disputed","invalidated","unknown",null])defs.push({name:`epistemic-${epistemicStatus}`,items:[row("a",{epistemicStatus})]});
for(const trustLevel of ["curated","validated","user_asserted","tool_observed","assistant_asserted","untrusted","unknown","__proto__","constructor","toString","hasOwnProperty"])defs.push({name:`trust-${trustLevel}`,items:[row("a",{origin:{scope:"agent_private",trustLevel,role:"assistant"}})]});
for(const v of [-1,0,0.5,1,2,"0.75",true,false,null,[],[0.4],{},"invalid"])defs.push({name:`salience-${JSON.stringify(v)}`,items:[row("a",{salience:v,recency:v})]});
for(const key of ["constructor","__proto__","toString","hasOwnProperty"])defs.push({name:`epistemic-prototype-${key}`,items:[row("a",{epistemicStatus:key})]});
for(const [field,value] of [["status",["demoted"]],["category",["project_fact"]],["category",false],["category",null],["epistemicStatus",["invalidated"]],["epistemicStatus",["trusted"]]])defs.push({name:`coercion-${field}-${JSON.stringify(value)}`,items:[row("a",{[field]:value})]});
defs.push({name:"role-array",items:[row("a",{origin:{scope:"agent_private",role:["assistant"],trustLevel:"user_asserted"}})]});
defs.push(
 {name:"foreign",items:[row("a",{agentId:"foreign"})]},
 {name:"hard-deleted",items:[row("a",{hardDeleted:true})]},
 {name:"stale",items:[row("a",{stale:true})]},
 {name:"vector",items:[row("a",{embedding:[1,0]}),row("b",{embedding:[0,1]})],queryVector:[1,0]},
 {name:"zero-vector",items:[row("a",{embedding:[0,0]})],queryVector:[1,0]},
 {name:"size-mismatch",items:[row("a",{embedding:[1]})],queryVector:[1,0]},
 {name:"ties",items:Array.from({length:8},(_,i)=>row(`tie-${i}`))},
 {name:"latest-demoted",items:[row("a",{status:"active"}),row("a",{status:"demoted",updatedAt:1700000000001})]},
 {name:"newest-first",items:[row("a",{status:"promoted",updatedAt:1700000000001}),row("a",{status:"active"})]},
 {name:"unicode",prompt:"ÄPFEL Grüße memory_thing next-code İSTANBUL",items:[row("a",{statement:"äpfel grüße memory_thing next-code istanbul"})]},
 {name:"dedupe",items:[row("a"),row("b",{statement:"unrelated tomato garden"})],exclude:["Build green memory workspace"]},
 {name:"dedupe-selected",items:[row("a"),row("b")],exclude:["Build green memory workspace"],onlyIds:["b"]},
 {name:"dedupe-empty",items:[row("a")],exclude:["a an I"]},
 {name:"dedupe-threshold",items:[row("a")],exclude:["Build green memory workspace extra"],threshold:0.8},
 {name:"threshold-equal",items:[row("a",{origin:{scope:"agent_private"},salience:0,recency:0,statement:""})],minScore:0},
 {name:"anonymous",items:[row(""),row(null),row(0)]}
);
function run(){return defs.map(def=>{const prompt=def.prompt??"Build green workspace";const opts={...requester,maxPerLane:2,minScore:def.minScore??0.08,queryVector:def.queryVector??null};const lanes=routeNeoRecall(def.items,prompt,opts);const dedupeOptions={...(def.onlyIds?{onlyIds:def.onlyIds}:{}),...(def.threshold===undefined?{}:{threshold:def.threshold})};return {...def,prompt,maxPerLane:2,minScore:opts.minScore,queryVector:opts.queryVector,exclude:def.exclude??[],scores:NEO_RECALL_LANES.map(lane=>({lane,values:def.items.map(item=>scoreNeoRecallItem(item,prompt,lane,opts))})),lanes,deduped:dedupeNeoLanesAgainstTexts(lanes,def.exclude??[],dedupeOptions)};});}
const cases=run();assert.deepEqual(run(),cases);const here=path.dirname(fileURLToPath(import.meta.url));writeFileSync(path.join(here,"golden/neo-routing.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},cases},null,2)+"\n");console.log(`Recorded ${cases.length} Node score/routing/dedupe scenarios across ${NEO_RECALL_LANES.length} lanes twice`);
