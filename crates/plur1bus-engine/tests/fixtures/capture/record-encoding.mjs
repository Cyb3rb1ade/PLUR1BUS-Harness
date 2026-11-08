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

verify("lib/encoding-llm.js");
const api=await import(pathToFileURL(path.join(root,"lib/encoding-llm.js")));
const assert=(await import("node:assert/strict")).default;
const NOW=1710000000000;
const inputs=[
 ...[null,"",true,[],"0.8",0,-1,0.39999999999999997,0.4,0.7,0.94,0.95,1].map(importance=>JSON.stringify({importance,intensity:0.9,dominant:"FEAR",emotions:{trust:0.4,anger:0.2},reason:"public fixture judgment"})),
 '{"importance":1e999}', '{"importance":0.8,"intensity":1e999}',
 JSON.stringify({importance:0.8,intensity:"1",dominant:["joy"],emotions:{joy:true,anger:"0.9",trust:0.5}}),
 JSON.stringify({importance:0.8,intensity:0.9,dominant:"joy",reason:"x".repeat(199)+"😀"}),
 'prefix {"importance":0.2} suffix', '{"importance":0.2} {"importance":0.3}',
];
const rows=[{}, {importance:0.94,memoryStrength:0.8}, {importance:0.95,memoryStrength:0.2,updateSource:"keep",updateEvidence:"keep",coreMemoryReason:"manual marker"},
 {importance:"0x1",memoryStrength:0.99}, {importance:0.2,memoryStrength:0.99,lastDynamicsAt:123}];
async function run(){
 const parsing=inputs.map(input=>({input,line:JSON.stringify(api.parseEncodingResponse(input))}));
 const refinement=[];
 for(const row of rows)for(const importance of [0.2,0.5,0.8,0.94])for(const flashbulbEncodingEnabled of [false,true]){
  const encoding=api.parseEncodingResponse(JSON.stringify({importance,intensity:0.95,dominant:"fear",emotions:{trust:0.4},reason:"fixture explanation"}));
  refinement.push({row,encoding,options:{flashbulbEncodingEnabled},line:JSON.stringify(api.buildRefinePatch(row,encoding,NOW,{flashbulbEncodingEnabled}))});
 }
 const cut=api.parseEncodingResponse(inputs[16]);
 refinement.push({row:{},encoding:cut,options:{},line:JSON.stringify(api.buildRefinePatch({},cut,NOW,{})),unicodeBoundary:true});
 const calls=[];
 for(const mode of ["missing","throw","empty","invalid","refused","valid"]){
  let messages=null;
  const callLlm=mode==="missing"?undefined:async value=>{messages=value;if(mode==="throw")throw new Error("synthetic route failure");return ({empty:"",invalid:"invalid fixture answer",refused:'{"importance":null}',valid:'{"importance":0.8,"intensity":0.7,"dominant":"trust"}'})[mode];};
  const result=await api.classifyEncoding("A public fixture memory.",{agentId:"alpha",callLlm});
  calls.push({mode,messages,promptHash:messages?digest(JSON.stringify(messages)):null,line:JSON.stringify(result)});
 }
 return {parsing,refinement,calls};
}
const result=await run();assert.deepEqual(await run(),result);
const here=path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(here,"golden/encoding.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},...result},null,2)+"\n");
console.log(`Recorded ${result.parsing.length} parsing, ${result.refinement.length} refinement and ${result.calls.length} host-call cases twice`);
