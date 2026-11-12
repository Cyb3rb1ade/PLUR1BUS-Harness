// RE-05/T5 conflict-ledger recordings from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file>
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") {
  throw new Error("pinned source, read-only git and Node 24.21.0 required");
}
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned conflict-ledger source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("engine/commands/command-helpers.js");

const { appendConflictLog, buildConflictSummaryFromLog } = await import(pathToFileURL(path.join(root, "engine/commands/command-helpers.js")));
const assert=(await import("node:assert/strict")).default;
const {tmpdir}=await import("node:os");
const realDate=Date;const now=1735689600000;
globalThis.Date=class extends realDate { constructor(...args){super(...(args.length?args:[now]));}static now(){return now;} };
const entry=(overrides={})=>({schemaVersion:1,timestamp:"2024-12-01T00:00:00.000Z",newMemoryId:"new-memory",newAgentId:"alpha",newText:"A synthetic decision",existingMemoryId:"existing-memory",existingAgentId:"beta",existingText:"Another synthetic decision",score:0.8,category:"decision",mergeDecision:"stored_separately",...overrides});
const inputs=[
 {name:"current-source-pair",entries:[entry({timestamp:new Date().toISOString(),newMemoryId:"00000000-0000-4000-8000-000000000001",existingMemoryId:"00000000-0000-4000-8000-000000000002"})]},
 {name:"single",entries:[entry()]},
 {name:"two",entries:[entry(),entry({timestamp:"2024-12-02T00:00:00.000Z",pending:true})]},
 {name:"repeated",entries:[entry(),entry()]},
 {name:"out-of-order",entries:[entry({timestamp:"2024-12-03T00:00:00.000Z"}),entry(),entry({timestamp:"2024-12-02T00:00:00.000Z"})]},
 {name:"unicode-bytes",entries:[entry({newText:"Äpfel 😀"}),entry({newText:"Äpfel 😀"})]},
 {name:"pending-status",entries:[entry({status:"pending"}),entry({status:"done"}),entry({pending:"false"})]},
 {name:"missing-times",entries:[entry({timestamp:null}),entry({timestamp:""}),entry({timestamp:"invalid"})]},
 {name:"epoch-zero",entries:[entry({timestamp:"1970-01-01T00:00:00.000Z"}),entry({timestamp:0})]},
 {name:"future-negative",entries:[entry({timestamp:"1960-01-01T00:00:00.000Z"}),entry({timestamp:"2030-01-01T00:00:00.000Z"})]},
 {name:"pending-candidate",entries:[entry({newMemoryId:null,mergeDecision:"no_merge_llm_call"})]},
 {name:"empty-existing-log",prefix:"",entries:[entry()]},
 {name:"malformed-existing-line",prefix:"not-json\n",entries:[entry()]},
 {name:"torn-existing-line",prefix:'{"old":',entries:[entry()]},
 {name:"two-existing-records",prefix:[entry({timestamp:"2024-12-03T00:00:00.000Z"}),entry()].map(v=>JSON.stringify(v)).join("\n")+"\n",entries:[entry({timestamp:"2024-12-02T00:00:00.000Z"})]},
 {name:"thousand-boundary",prefix:Array.from({length:1000},()=>JSON.stringify(entry())).join("\n")+"\n",entries:[entry({timestamp:"2024-12-04T00:00:00.000Z"}),entry({timestamp:"2024-12-05T00:00:00.000Z"})]},
];
function run(){
 const cases=[];const warn=console.warn;console.warn=()=>{};
 try{for(const input of inputs){
  const dir=mkdtempSync(path.join(tmpdir(),"conflict-ledger-recording-"));
  try{
   if(input.prefix!==undefined){mkdirSync(path.join(dir,".adaptive-learning"));writeFileSync(path.join(dir,".adaptive-learning/conflict-log.jsonl"),input.prefix);}
   const after=[];
   for(const entry of input.entries){appendConflictLog(dir,entry);after.push(JSON.parse(readFileSync(path.join(dir,".adaptive-learning/conflict-review-summary.json"),"utf8")));}
   const log=readFileSync(path.join(dir,".adaptive-learning/conflict-log.jsonl"),"utf8");
   const rebuilt=buildConflictSummaryFromLog(dir,{maxLines:1000,budgetMs:1000000});
   cases.push({...input,log,after,rebuilt});
  }finally{rmSync(dir,{recursive:true,force:true});}
 }}finally{console.warn=warn;}
 return cases;
}
const cases=run();assert.deepEqual(cases,run());
writeFileSync(new URL("./golden/conflict-ledger.json",import.meta.url),JSON.stringify({pin:PIN,now,sourcesSha256:Object.fromEntries(verified),cases},null,2)+"\n");
console.log(`Recorded ${cases.length} actual Node conflict-ledger cases twice`);
