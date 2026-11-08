// RE-05/T4 neo-watermark recordings from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file> [--write-data]
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "b5f8e285a16f1e9e7ae0e44313538d8c353d7eaa";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") throw new Error("pinned source, read-only git and Node 24.21.0 required");
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned neo-watermark source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/episode-watermark.js");
const api = await import(pathToFileURL(path.join(root,"lib/episode-watermark.js")));
const assert=(await import("node:assert/strict")).default;
const now="2026-11-08T12:00:00.000Z";
const OriginalDate=Date;
const states=[{}, {lastProcessedMessageCount:12,postProcessingFailures:2}, {lastProcessedMessageCount:12,sessionWatermarks:{}}, {sessionWatermarks:null}, {sessionWatermarks:{"s:a":{count:10,failures:2,at:"2026-01-01"},"s:b":{count:50,failures:3,at:"2026-02-01"}},unknown:"keep"}];
const defs=[];
for(let i=0;i<states.length;i++)for(const session of ["a","b","__proto__","", "\ud800"]){
 defs.push({name:`read-${i}-${session}`,action:"read",state:states[i],session});
 defs.push({name:`claim-${i}-${session}`,action:"claim",state:states[i],session});
 for(const [baseline,to] of [[0,5],[10,20],[10,3],[0,3],[9,10],[0,60]])defs.push({name:`advance-${i}-${session}-${baseline}-${to}`,action:"advance",state:states[i],session,change:{baseline,to}});
 for(const baseline of [0,10,9])defs.push({name:`failure-${i}-${session}-${baseline}`,action:"failure",state:states[i],session,change:{baseline,failures:3}});
}
for(const value of [null,false,true,"12",-3,0,0.5,2.9])defs.push({name:`strict-count-${JSON.stringify(value)}`,action:"advance",state:{sessionWatermarks:{"s:a":{count:value,failures:value}}},session:"a",change:{baseline:value,to:value}});
const many={sessionWatermarks:Object.fromEntries(Array.from({length:500},(_,i)=>[`s:${i}`,{count:i,failures:0,at:i<2?"equal":String(i).padStart(4,"0")}]))};
defs.push({name:"evict-500",action:"advance",state:many,session:"new",change:{baseline:0,to:2}});
defs.push({name:"retain-updated-500",action:"failure",state:many,session:"0",change:{baseline:0,failures:2}});
function run(){globalThis.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:[now]));}static now(){return new OriginalDate(now).getTime();}};try{return defs.map(def=>{let output;const state=structuredClone(def.state);switch(def.action){case "read":output=api.readSessionWatermark(state,def.session);break;case "claim":output=api.planLegacyWatermarkClaim(state,def.session);break;case "advance":output=api.planWatermarkAdvance(state,def.session,def.change);break;case "failure":output=api.planWatermarkFailure(state,def.session,def.change);break;}assert.deepEqual(state,def.state);return {...def,now,output};});}finally{globalThis.Date=OriginalDate;}}
const cases=run();assert.deepEqual(run(),cases);const here=path.dirname(fileURLToPath(import.meta.url));writeFileSync(path.join(here,"golden/neo-watermark.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},cases},null,2)+"\n");console.log(`Recorded ${cases.length} actual S2 session-watermark plans twice with fixed clock`);
