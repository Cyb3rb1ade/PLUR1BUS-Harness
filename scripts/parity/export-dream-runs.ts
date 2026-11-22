import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DreamStore } from "../../packages/core/src/dreams/store.ts";
import { DreamScheduler } from "../../packages/core/src/dreams/scheduler.ts";
import type { DreamJobRun } from "../../packages/core/src/dreams/types.ts";
import { exporterMain } from "./lib.mjs";

async function scenario(name: string) {
  const now = 1_750_000_000_000;
  const agentId = "agent-fixture";
  const logsDir = mkdtempSync(join(tmpdir(), "p4k-dream-runs-"));
  const store = new DreamStore(":memory:");
  const calls: {job:string; dueId:string|null}[] = [];
  const scheduler = new DreamScheduler({
    store,
    engine:{jobs:{
      list:()=>[{name:"rem-dream",needsLlm:true,singleton:false},{name:"discover-semantic-links",needsLlm:false,singleton:false}],
      async run(job, _agent, opts): Promise<DreamJobRun>{
        calls.push({job,dueId:opts?.dueId??null});
        const primary = job==="rem-dream";
        const prefix={runId:"engine-fixture",job,cost:{inputTokens:5,...(primary?{outputTokens:2}:{})}};
        if(name==="primary skipped"&&primary) return {...prefix,outcome:"skipped",reason:"no_llm_provider"};
        if(name==="job failed"&&primary) return {...prefix,outcome:"failed",reason:"fixture_failure"};
        if(name==="incomplete"&&primary) return {...prefix,outcome:"incomplete",reason:"fixture_pending"};
        return {...prefix,outcome:"completed",...(name==="diary failed"?{diary:{written:false}}:{})};
      },
    }},
    clock:{now:()=>now,setTimer(){throw new Error("fixture has no timer");}},
    logger:{info(){},warn(){},error(){}}, logsDir, agents:()=>[agentId], defaultTimezone:"UTC",
    idFactory:()=>"fixture-run", llmRoute:()=>name!=="missing route", nativeJobDues:true,
    breakerSessions:name==="breaker cap"?0:3, requireDiary:{rem:name==="diary missing"},
  });
  try {
    scheduler.syncAgents();
    for(let i=0;i<3;i++) store.recordCapture(agentId,5,now);
    if(name==="idempotent"){
      const key=scheduler.plan(agentId,"rem").idempotencyKey;
      store.insertRun({runId:"previous",agentId,phase:"rem",jobId:"rem-dream",partition:"agent-private",idempotencyKey:key,
        trigger:"cron",scheduledFor:null,startedAt:now,logPath:null});
      if(!store.claimKey("previous",key)) throw Error("fixture claim failed");
    }
    const abort = new AbortController();
    if(name==="cancelled") abort.abort();
    const row=await scheduler.runPhase(agentId,"rem",{trigger:"cron",scheduledFor:4000,signal:abort.signal});
    const schedule=store.getSchedule(agentId,"rem")!;
    return {name,result:{outcome:row.outcome,reason:row.reason,counts:row.counts,tokensIn:row.tokensIn,tokensOut:row.tokensOut,
      claimed:row.claimed,capturesAcc:schedule.capturesAcc,breakerState:schedule.breakerState,calls}};
  } finally { store.close(); rmSync(logsDir,{force:true,recursive:true}); }
}
export async function buildDreamRunVectors() {
  const runs=[];
  for(const name of ["completed","primary skipped","job failed","incomplete","diary failed","diary missing","missing route","breaker cap","cancelled","idempotent"]){
    runs.push(await scenario(name));
  }
  return {runs};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"dreams",build:buildDreamRunVectors});
}
