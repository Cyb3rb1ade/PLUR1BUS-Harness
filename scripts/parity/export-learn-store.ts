import { pathToFileURL } from "node:url";
import { LearnStore } from "../../packages/core/src/dreams/learn/store.ts";
import type { Target } from "../../packages/core/src/dreams/learn/types.ts";
import { exporterMain } from "./lib.mjs";

export function buildLearnStoreVectors(){
  const store=new LearnStore(":memory:");
  const target:Target={owner:"ada",agentId:"alpha",scope:"agent"};
  const other:Target={owner:"ben",agentId:"alpha",scope:"agent"};
  try{
    const run=store.begin(target,{from:100,to:200},201);
    const initial=structuredClone(run);
    const sameWindow=store.begin(target,{from:100,to:200},210);
    run.sessionIds=["fixture-session"];run.digest="fixture-digest";run.tokens=5;store.save(run);
    store.checkpoint(run.id,"extract:fixture-session",{text:"[]",inputTokens:2,outputTokens:1,model:"fixture"});
    const checkpoint=store.payload(run.id,"extract:fixture-session");
    const runsBefore=store.runs(target.owner,target);
    store.finish(run,"failed","provider-failed",300);
    const retained=store.payload(run.id,"extract:fixture-session");
    for(const from of [200,300]){
      const attempt=store.begin(target,{from,to:from+100},from+100);
      store.finish(attempt,"failed","provider-failed",from+200);
    }
    store.begin(other,{from:100,to:200},201);
    const breaker=store.breakerOpen(target,500), otherBreaker=store.breakerOpen(other,500);
    const nextDayBreaker=store.breakerOpen(target,86_400_000);
    const health=store.health(500);
    store.reconcile({now:600,checkpointDays:30,validTarget:()=>true,validSession:()=>false,validEvidence:()=>false});
    return {store:{initial,sameWindow,checkpoint,runsBefore,retained,breaker,otherBreaker,nextDayBreaker,health,
      invalidated:store.invalidated(run.id),afterReconcile:store.get(run.id),afterPayload:store.payload(run.id,"extract:fixture-session")}};
  }finally{store.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"learn",build:buildLearnStoreVectors});
}
