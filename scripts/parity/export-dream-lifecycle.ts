import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DreamStore } from "../../packages/core/src/dreams/store.ts";
import { DreamScheduler } from "../../packages/core/src/dreams/scheduler.ts";
import { DAY_MS, type DreamJobRun } from "../../packages/core/src/dreams/types.ts";
import { exporterMain } from "./lib.mjs";

async function scenario(name: string) {
  const base = 1_750_000_000_000;
  let now = base;
  let agents = ["alpha"];
  const store = new DreamStore(":memory:");
  const logsDir = mkdtempSync(join(tmpdir(), "p4k-dream-life-"));
  let alarm: (() => void | Promise<void>) | undefined;
  let wakeAt: number | null = null;
  let nextId = 0;
  const scheduler = new DreamScheduler({
    store, agents:()=>agents, staggerWindowS:0, defaultTimezone:"UTC",
    clock:{now:()=>now,setTimer(fn,delay){
      alarm=fn;
      wakeAt=now+delay;
      return {cancel(){alarm=undefined;wakeAt=null;}};
    }},
    engine:{jobs:{
      list:()=>[{name:"light-dream",needsLlm:false,singleton:false}],
      async run(job): Promise<DreamJobRun>{return {runId:"job",job,outcome:"completed"};},
    }},
    logger:{info(){},warn(){},error(){}},logsDir,idFactory:()=>"fixture-"+(++nextId),
  });
  try {
    scheduler.syncAgents();
    if(name==="startup due"||name==="disabled due"||name==="returning agent"||name==="cron due"){
      store.updateSchedule("alpha","light",{nextRunAt:base+(name==="startup due"||name==="disabled due"?-1:1000),
        ...(name==="disabled due"?{enabled:false}:{})});
    }
    if(name==="removed agent")agents=[];
    if(name.startsWith("retry")){
      const at=base-(name==="retry too old"?DAY_MS+1:name==="retry boundary"?DAY_MS:100);
      const trigger=name==="retry manual"?"manual":"cron";
      const key="crashed-window";
      store.insertRun({runId:"crashed",agentId:"alpha",phase:"light",jobId:"light-dream",partition:"agent-private",
        trigger,scheduledFor:at,idempotencyKey:key,startedAt:at,logPath:null});
      store.claimKey("crashed",key);
      if(name==="retry exhausted"){
        store.insertRun({runId:"prior",agentId:"alpha",phase:"light",jobId:"light-dream",partition:"agent-private",
          trigger:"catchup",scheduledFor:at,idempotencyKey:key,startedAt:at+1,logPath:null});
        store.finishRun("prior",{outcome:"failed",reason:"fixture",finishedAt:at+2,counts:{}});
      }
    }
    if(name==="prestart capture")scheduler.recordCapture("alpha",150);
    await scheduler.start();
    if(name==="cron due"){now+=1000;await alarm?.();}
    if(name==="returning agent"){
      agents=[];now+=500;await alarm?.();
      agents=["alpha"];now+=500;await alarm?.();
    }
    if(name==="importance threshold")scheduler.recordCapture("alpha",150);
    if(name==="below importance threshold")scheduler.recordCapture("alpha",149);
    if(name==="minimum gap"){
      store.insertRun({runId:"prior",agentId:"alpha",phase:"light",jobId:"light-dream",partition:"agent-private",
        trigger:"manual",scheduledFor:null,idempotencyKey:"prior",startedAt:base-1,logPath:null});
      store.finishRun("prior",{outcome:"failed",reason:"fixture",finishedAt:base,counts:{}});
      scheduler.recordCapture("alpha",150);
    }
    if(name==="stopped"){await scheduler.stop();scheduler.recordCapture("alpha",150);await alarm?.();}
    await scheduler.idle();
    const runs=store.listRuns({agentId:"alpha",phase:"light"}).map(run=>({id:run.runId,trigger:run.trigger,at:run.scheduledFor,
      ...(run.runId.startsWith("fixture-")?{}:{outcome:run.outcome,reason:run.reason,claimed:run.claimed})})).sort((a,b)=>a.id.localeCompare(b.id));
    const schedule=store.getSchedule("alpha","light");
    return {name,expected:{runs,wakeAt,captures:name==="importance threshold"?null:schedule?.capturesAcc??null}};
  } finally { await scheduler.stop(); store.close(); rmSync(logsDir,{force:true,recursive:true}); }
}

export async function buildDreamLifecycleVectors(){
  const rows=[];
  for(const name of ["startup due","disabled due","cron due","returning agent","removed agent","retry once","retry boundary",
    "retry too old","retry exhausted","retry manual","prestart capture","importance threshold","below importance threshold","minimum gap","stopped"]){
    rows.push(await scenario(name));
  }
  return {lifecycle:rows};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"dreams",build:buildDreamLifecycleVectors});
}
