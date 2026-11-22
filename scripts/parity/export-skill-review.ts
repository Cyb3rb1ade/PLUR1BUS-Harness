import { pathToFileURL } from "node:url";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { SkillReview, type SkillProposal, type SkillProposalBackend } from "../../packages/core/src/skill-mining/review.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import type { ApprovalAnswer } from "../../packages/core/src/tools/approval.ts";
import { exporterMain } from "./lib.mjs";

const scope={owner:deriveUserPrincipal("ada"),agentId:"alpha",scope:"workspace"};
const hash="a".repeat(64);
function pending():SkillProposal{
  return {id:"fixture",scope,status:"pending",candidate:{schema:"plur1bus.skill-candidate/1",kind:"skill",author:"agent",
    enabled:false,name:"mined-workflow-"+hash.slice(0,16),workflowHash:hash,skillMd:"Fixture candidate",
    reason:"Verified repeated steps",sessionIds:["s1","s2"]}};
}
async function scenario(name:string){
  const calls:unknown[]=[];
  const asked:unknown[]=[];
  let reads=0,starts=0;
  const proposal=pending();
  if(name==="foreign scope")proposal.scope={...proposal.scope,agentId:"beta"};
  if(name==="nonpending")proposal.status="accepted";
  if(name==="active candidate")(proposal.candidate as {enabled:boolean}).enabled=true;
  if(name==="long candidate")proposal.candidate.skillMd="é".repeat(33_000);
  const backend:SkillProposalBackend={supportsSkillArtifacts:true,state:name==="missing"?"engine-unavailable":"ready",
    async list(){return[];},async find(){return null;},async propose(){throw Error("not reviewed through propose");},
    async get(){reads++;return name==="changed"&&reads>1?{...proposal,candidate:{...proposal.candidate,skillMd:"Changed"}}:proposal;},
    async accept(scope,id,expectedHash){calls.push({scope,id,expectedHash,decision:"accept"});},
    async reject(scope,id,expectedHash){calls.push({scope,id,expectedHash,decision:"reject"});}
  };
  const review=new SkillReview(backend,{
    async request(ask){
      asked.push({request:ask.request,tool:ask.tool,args:ask.args,principal:ask.principal,agentId:ask.agentId,park:ask.park});
      return {approved:name!=="denied",scope:name==="standing"?"always":"once"} as ApprovalAnswer;
    },
    begin(){starts++;return name!=="consumed";},
  });
  const ctrl=new AbortController();
  const actor={principal:"ada",role:name==="viewer"?"viewer":"owner",surface:3 as const,signal:ctrl.signal};
  let result;
  try{await review.decide(scope,"fixture",name==="rejected"?"reject":"accept",actor);result={ok:true};}
  catch(error){if(!(error instanceof RpcError))throw error;result={error:error.error};}
  return {name,scope,proposal:name==="long candidate"?pending():proposal,expected:{result,calls,asked,reads,starts}};
}
export async function buildSkillReviewVectors(){
  const review=[];
  for(const name of ["accepted","rejected","viewer","missing","foreign scope","nonpending","active candidate","long candidate",
    "denied","standing","changed","consumed"])review.push(await scenario(name));
  return {review};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"skills",build:buildSkillReviewVectors});
}
