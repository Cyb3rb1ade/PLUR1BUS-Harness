import { pathToFileURL } from "node:url";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { installationFindings } from "../../packages/core/src/dreams/learn/installation.ts";
import { LearnError, type SelectionSource } from "../../packages/core/src/dreams/learn/types.ts";
import type { SessionRecord } from "../../packages/core/src/session/types.ts";
import type { Principal } from "../../packages/core/src/rbac/types.ts";
import { exporterMain } from "./lib.mjs";

const target={scope:"installation" as const,owner:"ada",agentId:"alpha"};
const window={from:1,to:100};
function session(id:string,agentId:string):SessionRecord{
  return {id,agentId,owner:deriveUserPrincipal("ada"),kind:"direct",scope:"workspace",chatKey:null,title:"",
    pinned:false,memoryMode:"remember",createdAt:1,updatedAt:20,lastTurnAt:20,archivedAt:null,turnCount:1};
}

function scenario(name:string){
  const person:Principal={kind:name==="agent"?"agent":"person",userId:"ada",role:name==="non-owner"?"admin":"owner"};
  const rows=[session("s1","alpha"),session("s2","beta")];
  const shape={objects:1,arrays:0,strings:1,numbers:0,booleans:0,nulls:0,fields:1,depth:1,truncated:false};
  const fault=(sessionId:string,seq:number,tool="file.read")=>({sessionId,turnId:"turn"+seq,seq,at:23,
    metadata:{version:1 as const,tool,errorClass:"tool-failed" as const,shape}});
  const events=name==="overflow"?Array.from({length:4001},(_,i)=>fault("s1",i+1)):
    name==="empty"?[]:[fault("s2",1),fault("missing",2),fault("s1",3),fault("s1",4,"file.list")];
  const source:SelectionSource={
    sessions(){throw Error("installation has no transcript candidate scan");},
    transcript(){throw Error("installation cannot read a transcript");},
    session:id=>rows.find(row=>row.id===id)??null,
    mayRead:(_t,s)=>name!=="denied scope"||s.id!=="s2",
    ...(name==="missing port"?{}:{toolErrors:()=>events}),
  };
  const cap=name==="session cap"?1:50;
  let expected;
  try{expected={result:installationFindings(source,target,person,window,"run-fixture",cap)};}
  catch(error){if(!(error instanceof LearnError))throw error;expected={error:error.reason};}
  return {name,person,rows,events:name==="overflow"?[]:events.map(e=>JSON.stringify(e)),cap,expected};
}

export function buildLearnInstallationVectors(){
  return {installation:["grouped","session cap","denied scope","empty","missing port","overflow","non-owner","agent"].map(scenario)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"learn",build:buildLearnInstallationVectors});
}
