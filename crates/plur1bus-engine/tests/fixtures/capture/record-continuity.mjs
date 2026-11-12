// RE-05/T4 continuity recordings from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file> [--write-data]
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") throw new Error("pinned source, read-only git and Node 24.21.0 required");
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned continuity source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/continuity-gate.js");
const {ContinuityGate,filterAssociativeCandidates,filterPatternCandidates}=await import(pathToFileURL(path.join(root,"lib/continuity-gate.js")));
const assert=(await import("node:assert/strict")).default;
const inputs=[];
for(const type of ["associative","pattern","unknown"])
 for(const score of [-1,0,0.7,0.75,0.75000001,1])
  for(const count of [0,1,2])inputs.push({config:{},type,score,state:{associativeSurfacedCount:count,patternSurfacedCount:count},options:{}});
for(const options of [
 {depth:2},{depth:2.1},{depth:-1},{depth:3,id:"a",vectorTopIds:["a"]},
 {id:"a",vectorTopIds:["a"]},{id:"a",vectorTopIds:["b"]},{id:"",vectorTopIds:[""]},
 {emotionalTrajectory:"GRIEF",currentRegister:"joy"},{emotionalTrajectory:"celebration",currentRegister:"anguish"},
 {emotionalTrajectory:"anger",currentRegister:"loss"},{emotionalTrajectory:"joy",currentRegister:"delight"},
 {emotionalTrajectory:"lossless",currentRegister:"elation"},{emotionalTrajectory:"",currentRegister:"joy"},
 ])for(const type of ["associative","pattern"])inputs.push({config:{},type,score:0.9,state:{},options});
for(const max of [-1,0,0.5,1,2])for(const count of [0,1])for(const type of ["associative","pattern"])
 inputs.push({config:{assocThreshold:0,patternThreshold:0,maxAssociations:max,maxPatterns:max},type,score:0.5,state:{associativeSurfacedCount:count,patternSurfacedCount:count},options:{}});
function snapshot(state){return {...state,...(state.surfacedIds?{surfacedIds:[...state.surfacedIds]}:{})};}
function run(){
 const direct=inputs.map(input=>({input,line:JSON.stringify(new ContinuityGate(input.config).shouldSurface(input.type,input.score,input.state,input.options))}));
 const sequences=[];
 for(const config of [{},{assocThreshold:0,patternThreshold:0,maxAssociations:2,maxPatterns:2},{maxAssociations:0,maxPatterns:0}]){
  const gate=new ContinuityGate(config),state={associativeSurfacedCount:0,patternSurfacedCount:0};const steps=[];
  for(const [type,score,id] of [["associative",0.9,"a"],["pattern",0.8,"p"],["associative",1,"a"],["pattern",1,"p"],["unknown",1,"x"],["associative",1,""]]){
   const decision=gate.shouldSurface(type,score,state,{id});if(decision.allow)gate.record(state,type,id);
   steps.push({type,score,id,line:JSON.stringify(decision),state:snapshot(state)});
  }sequences.push({config,steps});
 }
 const lists=[];
 for(const maximum of [0,1,2])for(const count of [0,1]){
  const state={associativeSurfacedCount:count,patternSurfacedCount:0};
  const candidates=[{id:"plain"},{id:"weak",graphSource:"graph",relevanceScore:0},{id:"deep",graphSource:"graph",associatedScore:1,depth:3},{id:"a",graphSource:"graph",associatedScore:0.8},{id:"b",graphSource:"graph",associationStrength:0.9},{id:"tail"}];
  const result=filterAssociativeCandidates(candidates,{maxAssociations:maximum,assocThreshold:0,sessionState:state});
  lists.push({maximum,count,candidates,result,state:snapshot(state)});
 }
 const patterns=[];
 for(const maximum of [0,1,2])for(const count of [0,1])for(const trajectory of ["grief","joy",""]){
  const state={associativeSurfacedCount:0,patternSurfacedCount:count};
  const matched={pattern:{patternKey:"fixture-pattern",emotionalTrajectory:trajectory},score:0.8,triggerIds:["a","b"]};
  const result=filterPatternCandidates(matched,{maxPatterns:maximum,currentRegister:"celebration",sessionState:state});
  patterns.push({maximum,count,matched,result,state:snapshot(state)});
 }
 return {direct,sequences,lists,patterns};
}
const result=run();assert.deepEqual(run(),result);
const here=path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(here,"golden/continuity.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},...result},null,2)+"\n");
console.log(`Recorded ${result.direct.length} direct, ${result.sequences.length} session, ${result.lists.length} association-list and ${result.patterns.length} pattern cases twice`);
