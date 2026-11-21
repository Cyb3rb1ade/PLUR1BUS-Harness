import { pathToFileURL } from "node:url";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { LearnStore } from "../../packages/core/src/dreams/learn/store.ts";
import { LearnRunner } from "../../packages/core/src/dreams/learn/runner.ts";
import { LearnError, DEFAULT_LEARN_CONFIG, type Target, type Transcript } from "../../packages/core/src/dreams/learn/types.ts";
import type { Principal } from "../../packages/core/src/rbac/types.ts";
import { exporterMain } from "./lib.mjs";

const target:Target={scope:"agent",owner:"ada",agentId:"alpha"};
const person:Principal={kind:"person",userId:"ada",role:"owner"};
const window={from:1,to:101};
const now=200;

function transcript(id:string):Transcript{
  const message={id:"message-"+id,sessionId:id,turnId:"turn-"+id,seq:1,role:"user" as const,text:"Example statement",
    tokens:2,createdAt:50};
  return {session:{id,agentId:"alpha",owner:deriveUserPrincipal("ada"),scope:"workspace",kind:"direct",
    createdAt:1,lastTurnAt:60,updatedAt:60,archivedAt:null,pinned:false,memoryMode:"remember",chatKey:null,title:"",turnCount:1},
    messages:[message],events:[],days:["1970-01-01"]};
}

async function scenario(name:string){
  const store=new LearnStore(":memory:");
  const transcripts=name==="no sessions"?[]:name==="capped"?[transcript("one"),transcript("two")]:[transcript("one")];
  const snapshot=JSON.stringify(transcripts);
  const calls:unknown[]=[];
  const notices:unknown[]=[];
  let attempt=0;
  const maxTokens=name==="budget"?100:100_000;
  const maxSessions=name==="capped"?1:50;
  const enabled=name!=="disabled";
  const runner=new LearnRunner({
    store,now:()=>now,principal:()=>name==="lost identity"?null:person,
    config:()=>({...DEFAULT_LEARN_CONFIG,enabled,maxTokens,maxSessions,focus:"fixture focus"}),
    source:{sessions(_t,_w,limit,offset=0){
      if(name==="source unavailable")throw new LearnError("source-unavailable");
      return transcripts.slice(offset,offset+limit).map(t=>t.session);
    },mayRead:()=>true,transcript:s=>transcripts.find(t=>t.session.id===s.id)!},
    model:{async complete(req){
      calls.push({stage:req.stage,modelClass:req.modelClass,maxOutputTokens:req.maxOutputTokens,data:JSON.parse(req.data)});
      if(name==="provider failure"||(["resume","digest changed"].includes(name)&&attempt===0))throw Error("fixture failure");
      const id=JSON.parse(req.data).data.messages[0].id;
      const row={kind:"knowledge",change:"add",text:"Scoped fixture observation",contentKey:"fixture",evidence:[{source:"message",id}]};
      return {text:name==="invalid output"?"{invalid":JSON.stringify([row]),model:"fixture-small",
        inputTokens:name==="unmeasured response"?-1:5,outputTokens:2};
    }},
    notice:(_run,counts)=>notices.push(counts),
  });
  try{
    const abort=new AbortController();
    if(name==="cancelled")abort.abort();
    let run=await runner.run(target,window,abort.signal);
    if(["resume","completed again","digest changed"].includes(name)){
      attempt++;
      if(name==="digest changed")transcripts[0]!.messages[0]!.text="Changed statement";
      run=await runner.run(target,window,abort.signal);
    }
    return {name,config:{enabled,maxTokens,maxSessions,focus:"fixture focus"},snapshot,
      expected:{run,findings:store.findings(run.id),calls,notices}};
  }finally{await runner.idle();store.close();}
}

export async function buildLearnRunVectors(){
  const runs=[];
  for(const name of ["completed","disabled","lost identity","no sessions","source unavailable","capped","budget","provider failure",
    "unmeasured response","invalid output","cancelled","resume","completed again","digest changed"])runs.push(await scenario(name));
  return {runs};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"learn",build:buildLearnRunVectors});
}
