import { pathToFileURL } from "node:url";
import { SkillMining, type MiningScope, type SkillProposalQueue } from "../../packages/core/src/skill-mining/miner.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import type { EventRecord, SessionRecord, TurnRecord } from "../../packages/core/src/session/types.ts";
import { buildSkillMiningVectors } from "./export-skill-mining.ts";
import { exporterMain } from "./lib.mjs";

const baseline=buildSkillMiningVectors().mining.find(r=>r.name==="valid")!;

async function scenario(name:string){
  const calls:unknown[]=[];
  const stored=new Map<string,{id:string,status:"pending"}>();
  const queue:SkillProposalQueue={
    supportsSkillArtifacts:true,state:name==="unavailable"?"engine-unavailable":"ready",
    async find(scope,hash){
      calls.push({operation:"find",scope,hash});
      return stored.get(hash)??null;
    },
    async propose(scope,candidate){
      calls.push({operation:"propose",scope,hash:candidate.workflowHash,enabled:candidate.enabled});
      const receipt={id:"fixture-proposal",status:(name==="nonpending"?"accepted":"pending") as "pending"};
      stored.set(candidate.workflowHash,receipt);return receipt;
    },
  };
  const svc=new SkillMining({
    listSessions:()=>({sessions:baseline.sessions as SessionRecord[],truncated:false}),
    listTurns:id=>baseline.turns.filter(t=>t.sessionId===id) as TurnRecord[],
    listEvents(id,after=0,limit=2000){
      return (baseline.events[id as "s1"|"s2"] as EventRecord[]).filter(e=>e.seq>after).slice(0,limit);
    },
  },()=>baseline.tools,{verified(_scope,_s,_t,_call,_tool,_version){return name!=="no proof";}},queue);
  const result:unknown[]=[];
  try{
    result.push(await svc.propose(baseline.scope as MiningScope));
    if(name==="deduplicated")result.push(await svc.propose(baseline.scope as MiningScope));
  }catch(error){
    if(!(error instanceof RpcError))throw error;
    result.push({error:error.error});
  }
  return {name,expected:{result,calls,status:svc.status()}};
}

export async function buildSkillProposalVectors(){
  const proposals=[];
  for(const name of ["available","deduplicated","unavailable","nonpending","no proof"])proposals.push(await scenario(name));
  return {proposals};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"skills",build:buildSkillProposalVectors});
}
