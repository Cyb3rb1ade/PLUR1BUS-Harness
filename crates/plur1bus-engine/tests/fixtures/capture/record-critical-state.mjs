// RE-05/T4 critical-state recordings from verified pinned Node sources.
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
  if (!source.equals(expected)) throw new Error(`pinned critical-state source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/critical-push-classifier.js");
const api=await import(pathToFileURL(path.join(root,"lib/critical-push-classifier.js")));
const review=await import(pathToFileURL(path.join(root,"lib/critical-review.js")));
const assert=(await import("node:assert/strict")).default;
const here=path.dirname(fileURLToPath(import.meta.url));
const cards=[];
for(const role of [undefined,"user","USER","assistant","agent","Assistant","tool",null,0,1])for(const origin of [undefined,"dm","correction","correct","edit","dream"]){
 for(const signals of [{},{importance:0.89},{importance:0.9},{importance:"0.9"},{importance:"Infinity"},{coreMemoryScore:0.9},{neverForget:true},{neverForget:1},{neverForget:"1"},{memoryClass:"dream"}])cards.push({sourceMessageRole:role,origin,...signals});
}
const responses=[...api.CRITICAL_TYPES,"fakt"," Gesundheit ","PERSON","health","```gesundheit```","gesundheit because reasons","",null,42];
async function run(){
 const state=cards.map(card=>({card,role:review.resolveSourceRole(card),assistant:review.isAssistantSourced(card),explicit:review.hasExplicitImportanceSignal(card),dream:review.isDreamCard(card),eligible:review.isEligibleForCriticalHighlight(card)}));
 const classification=[];
 for(const content of ["Synthetic memory", "", "  ", "🙂\nSynthetic claim"]){for(const response of responses){const calls=[];const result=await api.classifyMemory(content,{async complete(params){calls.push(params);return {text:response};}});classification.push({content,response,result,calls});}}
 for(const kind of ["absent","reject"]){const calls=[];let result;try{result={value:await api.classifyMemory("Synthetic memory",kind==="absent"?null:{async complete(params){calls.push(params);throw new Error("synthetic refusal");}})};}catch{result={error:true};}classification.push({kind,content:"Synthetic memory",result,calls});}
 return {state,classification};
}
const first=await run();assert.deepEqual(await run(),first);
const probe="SYNTHETIC_PROMPT_SPLIT";let captured;await api.classifyMemory(probe,{async complete({prompt}){captured=prompt;return {text:"fakt"};}});const [prefix,suffix]=captured.split(probe);assert.ok(prefix&&suffix);
const provenance={commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)};
const data=JSON.stringify({provenance,promptPrefix:prefix,promptSuffix:suffix},null,2)+"\n";
writeFileSync(path.resolve(here,"../../../src/capture/critical-data.json"),data);
writeFileSync(path.join(here,"golden/critical-state.json"),JSON.stringify({provenance,dataSha256:digest(data),...first},null,2)+"\n");console.log(`Recorded ${first.state.length} state and ${first.classification.length} classification cases twice`);
