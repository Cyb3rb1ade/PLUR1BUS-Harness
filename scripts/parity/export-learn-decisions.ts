import { pathToFileURL } from "node:url";
import type { HarnessConfig } from "@plur1bus/config-schema";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { aggregate } from "../../packages/core/src/dreams/learn/aggregation.ts";
import { LearnService } from "../../packages/core/src/dreams/learn/service.ts";
import { digest } from "../../packages/core/src/dreams/learn/selection.ts";
import { LearnStore } from "../../packages/core/src/dreams/learn/store.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import type { Target, Transcript } from "../../packages/core/src/dreams/learn/types.ts";
import type { Principal } from "../../packages/core/src/rbac/types.ts";
import { exporterMain } from "./lib.mjs";

const target:Target={scope:"agent",owner:"ada",agentId:"alpha"};
const who:Principal={kind:"person",userId:"ada",role:"owner"};
const owner=deriveUserPrincipal(target.owner);
const transcript:Transcript={
  session:{id:"s1",kind:"direct",agentId:"alpha",owner,scope:"workspace",chatKey:null,title:"",pinned:false,
    memoryMode:"remember",createdAt:1,updatedAt:15,lastTurnAt:15,archivedAt:null,turnCount:1},
  events:[],days:["1970-01-01"],messages:[{id:"msg1",sessionId:"s1",turnId:"t1",seq:1,role:"user",text:"Learned fixture text",tokens:2,createdAt:15}],
};

async function scenario(name:string){
  const store=new LearnStore(":memory:");
  const run=store.begin(target,{from:1,to:20},20);run.sessionIds=["s1"];run.digest="fixture";store.save(run);
  const finding=aggregate([{kind:"knowledge",change:"add",text:"Learned fixture text",contentKey:"fixture",evidence:[
    {sessionId:"s1",turnId:"t1",sourceId:"msg1",source:"message",trust:"person",day:"1970-01-01",agentId:"alpha",owner}] }],target,run.id,1)[0]!;
  store.publish(run,[finding],21);
  const controller=new AbortController();
  let live=true;
  const service=new LearnService({
    store,source:{sessions:()=>[transcript.session],session:id=>id==="s1"?transcript.session:null,mayRead:()=>true,
      transcript:()=>transcript,evidence:()=>transcript},
    model:{async complete(){throw Error("human decisions cannot call a model");}},now:()=>25,
    principal:()=>live?who:null,mayReadTarget:(_t,p)=>live&&p.userId==="ada",
    config:()=>({} as HarnessConfig),readPort:async()=>null,card:async()=>null,signal:controller.signal,
  });
  const calls:unknown[]=[];
  try{
    if(name==="revoked")live=false;
    const person=name==="other owner"?{...who,userId:"ben"}:who;
    const outcome=name==="rejected"?"rejected":"accepted";
    const hash=name==="wrong hash"?"stale":digest(store.finding(finding.id)!);
    let result;
    try{
      result=await service.decide({id:finding.id,contentHash:hash,outcome},person,async (method,params)=>{
        calls.push({method,params});
        if(name==="definite refusal")throw new RpcError("E_DENIED","fixture",{reason:"fixture"});
        if(name==="unconfirmed")return {runId:"import-fixture",imported:0,linked:0};
        return {runId:"import-fixture",imported:1,linked:0};
      });
    }catch(error){if(!(error instanceof RpcError))throw error;result={error:error.reason==="fixture"?"effect-refused":error.reason};}
    return {name,target,snapshot:JSON.stringify(transcript),finding:JSON.stringify(finding),expected:{
      result,calls,status:store.finding(finding.id)?.status,action:store.action(finding.id,1)}};
  }finally{await service.close();}
}

export async function buildLearnDecisionVectors(){
  const decisions=[];
  for(const name of ["accepted","rejected","wrong hash","revoked","other owner","definite refusal","unconfirmed"])decisions.push(await scenario(name));
  return {decisions};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"learn",build:buildLearnDecisionVectors});
}
