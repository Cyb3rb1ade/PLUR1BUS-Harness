// RE-05/T5 conflict-resolution recordings from verified pinned Node sources.
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
  if (!source.equals(expected)) throw new Error(`pinned conflict-resolution source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/jobs/conflict-resolver.js");
verify("lib/jobs/apply-conflict-resolution.js");
const {runConflictResolver}=await import(pathToFileURL(path.join(root,"lib/jobs/conflict-resolver.js")));
const {resolutionApplyId,resolutionApplyText,applyConflictViaSafeUpdate,findResolvableConflict}=await import(pathToFileURL(path.join(root,"lib/jobs/apply-conflict-resolution.js")));
const assert=(await import("node:assert/strict")).default;
const {tmpdir}=await import("node:os");
const RealDate=Date;const now=1735689600000;
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
const original={schemaVersion:1,timestamp:"2024-12-01T00:00:00.000Z",newMemoryId:"00000000-0000-4000-8000-000000000001",existingMemoryId:"00000000-0000-4000-8000-000000000002",newAgentId:"alpha",existingAgentId:"alpha",newText:"New synthetic decision",existingText:"Prior synthetic decision",score:0.8,category:"decision",mergeDecision:"stored_separately"};
const decisions=[
 {resolution:"keep_a",confidence:0.95,reason:"fixture"},
 {resolution:"keep_b",confidence:1,reason:"fixture"},
 {resolution:"merge",confidence:0.9,reason:"fixture",mergedText:"Combined synthetic decision"},
 {resolution:"uncertain",confidence:1,reason:"fixture"},
 {resolution:"merge",confidence:0.89,reason:"fixture",mergedText:"Review synthetic decision"},
 {resolution:"keep_a",confidence:0.9,reason:"fixture"},
 {resolution:"unknown",confidence:0.95,reason:"fixture"},
 {resolution:"keep_a",reason:"fixture"},
 {resolution:"keep_a",confidence:"0.99",reason:"fixture"},
 {resolution:"merge",confidence:2,reason:"fixture",mergedText:"Out of range fixture"},
];
async function run(){
 const proposals=[];
 for(const decision of decisions){
  const dir=mkdtempSync(path.join(tmpdir(),"conflict-resolution-recording-"));
  try{
   mkdirSync(path.join(dir,".adaptive-learning"));writeFileSync(path.join(dir,".adaptive-learning/conflict-log.jsonl"),JSON.stringify(original)+"\n");
   let calls=0;
   const result=await runConflictResolver({workspaceDir:dir,agentId:"alpha",llmCfg:{},callLlm:async()=>{calls++;return JSON.stringify(decision);}});
   const line=readFileSync(path.join(dir,".adaptive-learning/conflict-resolved.jsonl"),"utf8");
   const found=findResolvableConflict(dir,original.existingMemoryId);
   proposals.push({decision,result,calls,line,found});
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
 const selectors=[null,{},...decisions.map(d=>({...d,original})),
  {resolution:"merge",original:{newMemoryId:"only-new",mergedText:"original fallback"}},
  {resolution:"keep_a",original:{existingMemoryId:123,existingText:42}},
  {resolution:"keep_b",original:{newMemoryId:false,newText:["one","two"]}},
  {resolution:"other",mergedText:{key:"value"},original:{existingMemoryId:"x"}},
  {resolution:"keep_b",original:{newMemoryId:"unicode",newText:"A"+String.fromCharCode(0xd83d)}},
  {resolution:"merge",mergedText:[String.fromCharCode(0xde00),["nested",null]]},
 ].map(input=>({input,id:resolutionApplyId(input),text:resolutionApplyText(input)}));
 const apply=[];
 for(const input of [
  {conflict:{existingMemoryId:original.existingMemoryId,mergedText:"text",vector:[1,0]},options:{}},
  {conflict:{existingMemoryId:original.existingMemoryId,mergedText:"text",vector:[1,0]},options:{confirm:"true"}},
  {conflict:{},options:{confirm:true}},
  {conflict:{existingMemoryId:original.existingMemoryId},options:{confirm:true}},
  {conflict:{existingMemoryId:original.existingMemoryId,mergedText:"text"},options:{confirm:true}},
 ]){
  const result=await applyConflictViaSafeUpdate({getById:async()=>{throw new Error("unexpected DB read");}},input.conflict,input.options);
  apply.push({...input,result});
 }
 return {proposals,selectors,apply};
}
try{
 const recorded=await run();assert.deepEqual(recorded,await run());
 writeFileSync(new URL("./golden/conflict-resolution.json",import.meta.url),JSON.stringify({pin:PIN,now,sourcesSha256:Object.fromEntries(verified),...recorded},null,2)+"\n");
 console.log(`Recorded ${recorded.proposals.length} actual Node proposal shapes, ${recorded.selectors.length} selections and ${recorded.apply.length} confirmation gates twice`);
}finally{globalThis.Date=RealDate;}
