import { pathToFileURL } from "node:url";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { aggregate } from "../../packages/core/src/dreams/learn/aggregation.ts";
import { digest } from "../../packages/core/src/dreams/learn/selection.ts";
import { LearnStore } from "../../packages/core/src/dreams/learn/store.ts";
import type { Evidence, Finding, Target } from "../../packages/core/src/dreams/learn/types.ts";
import { exporterMain } from "./lib.mjs";

export function buildLearnFindingStoreVectors(){
  const store=new LearnStore(":memory:");
  const target:Target={scope:"agent",owner:"ada",agentId:"alpha"};
  const person=deriveUserPrincipal(target.owner);
  const days=86_400_000;
  const evidence:Evidence={sessionId:"s1",turnId:"t1",sourceId:"msg1",source:"message",trust:"person",
    day:"1970-01-01",agentId:"alpha",owner:person};
  const keep:Record<string,string>={};
  function create(name:string,start:number,end:number,notes:string[],fresh=false){
    const run=store.begin(target,{from:start,to:end},end);
    const findings=aggregate(notes.map(text=>({kind:"knowledge",change:"add",contentKey:text,text,
      evidence:[fresh?{...evidence,sessionId:"s2",sourceId:"msg2",day:"1970-01-02"}:evidence]})),target,run.id,1);
    keep[name]=JSON.stringify(findings);
    run.sessionIds=fresh?["s2"]:["s1"];run.digest=name;store.save(run);
    store.publish(run,findings,end+1);
    return run;
  }
  try{
    const first=create("first",10,20,["kept","reviewed"]);
    const initial=store.findings(first.id);
    const kept=initial.find(f=>f.text==="kept")!, rejected=initial.find(f=>f.text==="reviewed")!;
    store.startAction(kept);
    const actionStarted=store.action(kept.id,1);
    const receipt={operation:"memory.importText.apply",runId:"apply-fixture"};
    store.decide(kept.id,"ada","accepted",24,receipt);
    store.decide(rejected.id,"ada","rejected",25,{});
    const decisions=store.decisions(first.id).sort((a,b)=>a.findingId.localeCompare(b.findingId));
    const initialPrediction=store.prediction(kept.id);
    const repeated=create("repeated",20,30,["kept","reviewed"]);
    const reopened=create("reopened",30,40,["reviewed"],true);
    const reopenedFinding=store.findings(reopened.id)[0] as Finding;
    const wide=store.begin(target,{from:24,to:14*days+25},14*days+25);
    const observations=Array.from({length:10},(_,i)=>({sessionId:"observed-"+i,at:100+i,signals:[]}));
    wide.sessionIds=observations.map(obs=>obs.sessionId);
    wide.digest="observation";
    store.save(wide);
    store.publish(wide,[],wide.startedAt+1,observations);
    const confirmed=store.prediction(kept.id);
    const stable=store.targetFindings(target).map(f=>({id:f.id,status:f.status,hash:digest(f)}));
    store.reconcile({now:15*days,checkpointDays:7,validTarget:()=>true,validSession:id=>id!=="s1"&&!id.startsWith("observed"),validEvidence:e=>e.sessionId!=="s1"});
    const withdrawn=store.finding(kept.id);
    return { "finding-store":{target,keep,observations,expected:{initial,actionStarted,decisions,initialPrediction,
      repeated:store.get(repeated.id)?.findings,reopenedFinding,confirmed,stable,withdrawn,afterPrediction:store.prediction(kept.id),
      action:store.action(kept.id,1),summaries:store.decidedFindings("ada").map(r=>({id:r.finding.id,outcome:r.outcome}))}} };
  }finally{store.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"learn",build:buildLearnFindingStoreVectors});
}
