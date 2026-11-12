// RE-05/T3 emotion recordings and production vocabulary extraction from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file> [--write-data]
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  if (!source.equals(expected)) throw new Error(`pinned emotion source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/emotional-state.js");
const {EmotionalState}=await import(pathToFileURL(path.join(root,"lib/emotional-state.js")));
const assert=(await import("node:assert/strict")).default;
const NOW=1710000000000;
const RealDate=Date;
globalThis.Date=class extends RealDate { constructor(...args){super(...(args.length?args:[NOW]));} static now(){return NOW;} };
const state={version:2,current:{joy:0.91,trust:0.82},nuanceState:{shame:0.6},lastUpdateAt:NOW};
const cases=[
 {name:"missing-agent",raw:JSON.stringify({state})},
 {name:"foreign-agent",raw:JSON.stringify({agentId:"foreign",state})},
 {name:"unbound-same-agent",raw:JSON.stringify({agentId:"alpha",state})},
 {name:"duplicate-agent",raw:`{"agentId":"foreign","agentId":"alpha","state":${JSON.stringify(state)}}`},
 {name:"foreign-owner",raw:JSON.stringify({agentId:"alpha",ownership:{ownerUserId:"foreign"},state})},
 {name:"foreign-workspace",raw:JSON.stringify({agentId:"alpha",ownership:{workspaceIdentity:"foreign"},state})},
 {name:"symlink",raw:JSON.stringify({agentId:"alpha",state}),link:true},
 {name:"corrupt",raw:"{"},
];
const {symlinkSync}=await import("node:fs");
function run(){
 const dir=mkdtempSync(path.join(tmpdir(),"mood-ownership-"));
 try{return cases.map((input,i)=>{
  const target=path.join(dir,`state-${i}.json`);writeFileSync(target,input.raw);
  const file=input.link?path.join(dir,`link-${i}.json`):target;
  if(input.link)symlinkSync(target,file);
  const mood=new EmotionalState();const hydrated=mood.hydrateOnce(file);
  return {...input,hydrated,stateLine:JSON.stringify(mood.serializeState()),unchanged:readFileSync(target,"utf8")===input.raw};
 });}finally{rmSync(dir,{recursive:true,force:true});}
}
try{
 const results=run();assert.deepEqual(run(),results);
 const here=path.dirname(fileURLToPath(import.meta.url));
 writeFileSync(path.join(here,"golden/emotion-ownership.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},cases:results},null,2)+"\n");
 console.log("Recorded eight actual Node mood ownership/restoration cases twice");
}finally{globalThis.Date=RealDate;}
