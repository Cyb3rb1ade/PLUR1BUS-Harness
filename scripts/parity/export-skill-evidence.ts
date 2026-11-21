import { pathToFileURL } from "node:url";
import { WorkflowEvidence, type WorkflowExecution } from "../../packages/core/src/skill-mining/evidence.ts";
import { exporterMain } from "./lib.mjs";

export function buildSkillEvidenceVectors(){
  const evidence=new WorkflowEvidence(":memory:");
  const known={owner:"owner-a",agentId:"alpha",sessionId:"session-a",turnId:"turn-a",callId:"call-a",
    tool:"file.read",version:"a".repeat(64),success:true};
  const failed={...known,callId:"failed",success:false};
  try{
    evidence.record(known);evidence.record(known);evidence.record(failed);
    const queries: {name:string;value:WorkflowExecution}[]=[{name:"known",value:known},{name:"failed",value:failed},
      {name:"wrong owner",value:{...known,owner:"owner-b"}},{name:"wrong agent",value:{...known,agentId:"other"}},
      {name:"other session",value:{...known,sessionId:"session-b"}},{name:"other turn",value:{...known,turnId:"turn-b"}},
      {name:"other call",value:{...known,callId:"call-b"}},{name:"other tool",value:{...known,tool:"file.list"}},
      {name:"other version",value:{...known,version:"b".repeat(64)}}];
    const verified=queries.map(({name,value})=>({name,value,verified:evidence.verified(
      {owner:value.owner,agentId:value.agentId,scope:"scope-a"},value.sessionId,value.turnId,value.callId,value.tool,value.version)}));
    const changed={...known,success:false};
    evidence.record(changed);
    const after=evidence.verified({owner:known.owner,agentId:known.agentId,scope:"scope-a"},known.sessionId,known.turnId,known.callId,known.tool,known.version);
    return {evidence:{known,failed,verified,finalized:{divergence:"finalized-evidence-is-immutable",changed,after}}};
  }finally{evidence.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"skills",build:buildSkillEvidenceVectors});
}
