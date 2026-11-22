import { pathToFileURL } from "node:url";
import type { HarnessConfig } from "@plur1bus/config-schema";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { aggregate } from "../../packages/core/src/dreams/learn/aggregation.ts";
import { LearnService } from "../../packages/core/src/dreams/learn/service.ts";
import { digest } from "../../packages/core/src/dreams/learn/selection.ts";
import { LearnStore } from "../../packages/core/src/dreams/learn/store.ts";
import type { Transcript } from "../../packages/core/src/dreams/learn/types.ts";
import { exporterMain } from "./lib.mjs";

const target={scope:"agent" as const,owner:"ada",agentId:"alpha"};
const owner=deriveUserPrincipal(target.owner);
const person={kind:"person" as const,role:"owner" as const,userId:"ada"};
const transcript:Transcript={session:{id:"s1",kind:"direct",agentId:"alpha",owner,scope:"workspace",
  chatKey:null,title:"",pinned:false,memoryMode:"remember",createdAt:0,updatedAt:2,lastTurnAt:2,archivedAt:null,turnCount:1},
  events:[],days:["1970-01-01"],messages:[{id:"msg1",sessionId:"s1",turnId:"t1",seq:1,role:"user",text:"procedure",tokens:1,createdAt:2}]};
async function scenario(name:string){
  const store=new LearnStore(":memory:");
  const run=store.begin(target,{from:1,to:20},20);
  run.sessionIds=["s1"];run.digest="handoff";store.save(run);
  const finding=aggregate([{kind:"procedural",change:"add",text:"Fixture procedure",contentKey:"procedure",
    evidence:[{sessionId:"s1",turnId:"t1",sourceId:"msg1",source:"message",trust:"person",day:"1970-01-01",agentId:"alpha",owner}]}
  ],target,run.id,1)[0]!;
  store.publish(run,[finding],21);
  const calls:string[]=[];
  const ctrl=new AbortController();
  const service=new LearnService({
    store,now:()=>25,principal:()=>person,mayReadTarget:()=>true,source:{session:()=>transcript.session,
      mayRead:()=>name!=="revoked",evidence:()=>transcript,sessions:()=>[transcript.session],transcript:()=>transcript},
    model:{async complete(){throw Error("not a model operation");}},config:()=>({dreams:{learn:{agents:{alpha:{owner:"ada"}}}}} as HarnessConfig),
    readPort:async()=>null,card:async()=>null,signal:ctrl.signal,
    h3:{available:()=>name!=="missing",async submit(request){
      calls.push(request.idempotencyKey);
      if(name==="retry"&&calls.length===1)throw Error("workspace unavailable");
      return {receiptId:"receipt"};
    }},
  });
  try{
    await service.handoff();await service.handoff();
    const current=store.finding(finding.id)!;
    return {name,target,snapshot:JSON.stringify(transcript),finding:JSON.stringify(finding),
      expected:{calls,recorded:store.handoff(finding.id,digest(current))}};
  }finally{await service.close();}
}
export async function buildLearnHandoffVectors(){
  const handoff=[];
  for(const name of ["successful","missing","retry","revoked"])handoff.push(await scenario(name));
  return {handoff};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"learn",build:buildLearnHandoffVectors});
}
