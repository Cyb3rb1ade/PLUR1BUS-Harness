import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DreamStore } from "../../packages/core/src/dreams/store.ts";
import { DreamScheduler } from "../../packages/core/src/dreams/scheduler.ts";
import type { CandidateInput, CandidatePromotionResult, DreamJobRun } from "../../packages/core/src/dreams/types.ts";
import { exporterMain } from "./lib.mjs";

async function scenario(name:string){
  const now=1_750_000_000_000, agent="alpha", phase=name==="light only"?"light":"deep";
  const logsDir=mkdtempSync(join(tmpdir(),"p4k-promotion-"));
  const store=new DreamStore(":memory:");
  const row:CandidateInput={content:"Candidate",memoryId:"memory-1",recalls:3,uniqueQueries:3,score:.75};
  if(name==="workspace")row.partition="workspace";
  if(name==="no memory identity")delete row.memoryId;
  if(name==="no measured utility"){delete row.recalls;delete row.uniqueQueries;row.createdAt=now-7*86_400_000;row.importance=1;}
  if(name==="under recall threshold")row.recalls=2;
  const calls:string[][]=[];
  const promote=async (id:string,ids:readonly string[]):Promise<CandidatePromotionResult>=>{
    calls.push([...ids]);
    let response:{id:string;outcome:"promoted"|"skipped";reason:string}={id:"memory-1",outcome:"promoted",reason:"integrated"};
    if(name==="wrong id")response={...response,id:"memory-2"};
    if(name==="bad reason")response={...response,reason:"not-integrated"};
    if(name==="already promoted")response={...response,outcome:"skipped",reason:"already-promoted"};
    if(name==="not confirmed")response={...response,outcome:"skipped",reason:"not-found"};
    return {agentId:name==="wrong agent"?"other":id,items:name==="empty receipt"?[]:name==="duplicate receipt"?[response,response]:[response]};
  };
  const job=phase==="light"?"light-dream":"consolidate-daily";
  const scheduler=new DreamScheduler({
    store,clock:{now:()=>now,setTimer(){throw Error("unexpected timer");}},agents:()=>[agent],defaultTimezone:"UTC",
    logsDir,logger:{info(){},warn(){},error(){}},idFactory:()=>"fixture-run",
    engine:{jobs:{list:()=>[{name:job,needsLlm:false,singleton:false}],async run(job):Promise<DreamJobRun>{
      return {runId:"engine",job,outcome:"completed",...(name==="bad diary"?{diary:{written:false}}:{})};
    }}},
    candidates:{pull(){if(name==="unavailable source")throw Error("fixture unavailable");return [row];},...(name==="missing capability"?{}:{promote})}
  });
  try{
    scheduler.syncAgents();
    for(let i=0;i<3;i++)store.recordCapture(agent,5,now);
    const run=await scheduler.runPhase(agent,phase,{trigger:"manual"});
    return {name,input:row,expected:{outcome:run.outcome,reason:run.reason,counts:run.counts,calls,
      states:store.listCandidates(agent).map(c=>({state:c.state,partition:c.partition,hash:c.contentHash,decision:c.decision}))}};
  }finally{await scheduler.stop();store.close();rmSync(logsDir,{force:true,recursive:true});}
}

export async function buildDreamPromotionVectors(){
  const promotions=[];
  for(const name of ["integrated","already promoted","not confirmed","empty receipt","wrong agent","wrong id","bad reason",
    "duplicate receipt","workspace","no memory identity","no measured utility","under recall threshold","missing capability",
    "unavailable source","bad diary","light only"])promotions.push(await scenario(name));
  return {promotions};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"dreams",build:buildDreamPromotionVectors});
}
