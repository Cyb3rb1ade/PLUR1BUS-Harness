import { pathToFileURL } from "node:url";
import { WorkflowEvidence } from "../../packages/core/src/skill-mining/evidence.ts";
import { mineSessionWorkflows, type MiningConfig, type MiningSessions, type MiningTool } from "../../packages/core/src/skill-mining/miner.ts";
import type { EventRecord, SessionRecord, TurnRecord } from "../../packages/core/src/session/types.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import { exporterMain } from "./lib.mjs";

const scope={owner:"fixture-owner",agentId:"alpha",scope:"workspace"};
const tools:MiningTool[]=[{name:"file.read",version:"a".repeat(64)},{name:"file.list",version:"b".repeat(64)}];
function session(id:string):SessionRecord{
  return {id,kind:"direct",owner:scope.owner,agentId:scope.agentId,scope:scope.scope,chatKey:null,title:"fixture private title",
    pinned:false,memoryMode:"remember",createdAt:1,updatedAt:20,lastTurnAt:19,archivedAt:21,turnCount:1};
}
function events(id:string,turn:string):EventRecord[]{
  return tools.flatMap((tool,i):EventRecord[]=>{
    const call="call-"+i;
    return [{sessionId:id,turnId:turn,seq:2*i+1,type:"tool.call",at:8+i,data:{id:call,name:tool.name,args:["fixture-private-value"]}},
      {sessionId:id,turnId:turn,seq:2*i+2,type:"tool.result",at:9+i,data:{id:call,output:JSON.stringify({isError:false,visible:"fixture-private-output"})}}];
  });
}

function scenario(name:string){
  const sessions=[session("s2"),session("s1")];
  const turns:TurnRecord[]=sessions.map((s,i)=>({id:"turn-"+i,sessionId:s.id,seq:1,state:"completed",
    startedAt:8,endedAt:14,error:null,incognito:false}));
  const all=turns.flatMap(turn=>{
    const rows=events(turn.sessionId,turn.id);
    if(name!=="shared result")return rows;
    const first=rows[0]!, last=rows[3]!;
    return [first,{...first,seq:2,at:9},{...last,data:{...last.data,id:first.data.id}}];
  });
  const q=all.filter(e=>e.sessionId==="s1");
  const config:MiningConfig={minSessions:2,minSteps:2,maxSteps:20,maxSessions:200,maxEvents:name==="event cap"?3:20000};
  if(name==="wrong session scope")sessions[1]!.scope="other";
  if(name==="other owner")sessions[1]!.owner="wrong";
  if(name==="other agent")sessions[1]!.agentId="other";
  if(name==="incognito session")sessions[1]!.memoryMode="incognito";
  if(name==="active session")sessions[1]!.archivedAt=null;
  if(name==="incognito turn")turns[1]!.incognito=true;
  if(name==="unfinished")turns[1]!.endedAt=null;
  if(name==="foreign event")q[1]!.sessionId="elsewhere";
  if(name==="nonadvancing")q[0]!.seq=0;
  if(name==="unregistered")q[2]!.data.name="other.tool";
  if(name==="known failure")q[1]!.data.output=JSON.stringify({isError:true});
  if(name==="prose success")q[1]!.data.output="Everything worked";
  if(name==="duplicate call"){q[2]!.data.id="call-0";q[3]!.data.id="call-0";}
  if(name==="wrong result")q[1]!.data.id="unexpected";
  if(name==="order changes"){q[0]!.data.name=tools[1]!.name;q[2]!.data.name=tools[0]!.name;}
  if(name==="invalid config")config.minSessions=1;
  const proof=new WorkflowEvidence(":memory:");
  const listed:MiningSessions={
    listSessions(){return {sessions,truncated:name==="session cap"};},
    listTurns(id){return turns.filter(t=>t.sessionId===id);},
    listEvents(id,after=0,limit=2000){return (id==="s1"?q:all.filter(e=>e.sessionId===id))
      .filter(e=>name==="nonadvancing"&&id==="s1"?after===0:e.seq>after).slice(0,limit);},
  };
  const recorded=turns.flatMap(t=>tools.map((tool,i)=>{
    const nameOfTool=name==="order changes"&&t.sessionId==="s1"?tools[1-i]!:tool;
    return {owner:scope.owner,agentId:scope.agentId,sessionId:t.sessionId,turnId:t.id,callId:"call-"+i,
      tool:nameOfTool.name,version:name==="wrong proof version"&&t.sessionId==="s1"?"c".repeat(64):nameOfTool.version,
      success:name!=="unverified"||t.sessionId!=="s1"};
  }));
  for(const row of recorded)proof.record(row);
  let expected;
  try{expected={candidates:mineSessionWorkflows(listed,scope,tools,proof,config)};}
  catch(error){if(!(error instanceof RpcError))throw error;expected={error:error.error};}
  finally{proof.close();}
  return {name,scope,tools,config,sessions,turns,events:{s1:q,s2:all.filter(e=>e.sessionId==="s2")},recorded,expected};
}
export function buildSkillMiningVectors(){
  return {mining:["valid","wrong session scope","other owner","other agent","incognito session","active session","incognito turn","unfinished",
    "foreign event","nonadvancing","unregistered","known failure","prose success","duplicate call","shared result","wrong result","order changes",
    "wrong proof version","unverified","invalid config","event cap","session cap"].map(scenario)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"skills",build:buildSkillMiningVectors});
}
