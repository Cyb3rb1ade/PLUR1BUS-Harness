import { pathToFileURL } from "node:url";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { selectTranscriptsWithCounts, selectionDigest, targetHash } from "../../packages/core/src/dreams/learn/selection.ts";
import { LearnError, type SelectionSource, type Target } from "../../packages/core/src/dreams/learn/types.ts";
import type { SessionRecord } from "../../packages/core/src/session/types.ts";
import type { Principal } from "../../packages/core/src/rbac/types.ts";
import { exporterMain } from "./lib.mjs";

function session(id: string, fields: Partial<SessionRecord> = {}): SessionRecord {
  return {id,kind:"direct",agentId:"alpha",owner:deriveUserPrincipal("owner"),scope:"workspace",chatKey:null,title:"",
    pinned:false,memoryMode:"remember",createdAt:1,updatedAt:22,lastTurnAt:null,archivedAt:null,turnCount:1,...fields};
}

function scenario(name: string) {
  const target: Target = {scope:"agent",owner:"owner",agentId:"alpha"};
  const who: Principal = {kind:"person",userId:"owner",role:"owner"};
  const window = {from:1,to:101};
  let cap = 50;
  let sessions = [session("s1")];
  const unreadable: string[] = [];
  if(name==="rank and cap"){
    cap=2;
    sessions=[session("s_Z"),session("s_a"),session("s_recent",{lastTurnAt:31}),session("s_old",{updatedAt:2})];
  }
  if(name==="scope filtering"){
    sessions=[session("ok"),session("other-owner",{owner:deriveUserPrincipal("other")}),session("other-agent",{agentId:"beta"}),
      session("forget",{memoryMode:"incognito"}),session("revoked")];
    unreadable.push("revoked");
  }
  if(name==="project"){
    target.scope="project";
    target.projectId="workspace";
    sessions=[session("other-project",{scope:"elsewhere"}),session("project-member",{agentId:"beta"})];
  }
  if(name==="installation"){
    target.scope="installation";
    sessions=[session("beta",{agentId:"beta"}),session("alpha")];
  }
  if(name==="duplicate across pages"){
    sessions=Array.from({length:51},(_,i)=>session("s"+i));
    sessions.push(sessions[0]!);
  }
  if(name==="person source") sessions=[session("s1",{kind:"channel"})];
  if(name==="non-human") who.kind="agent";
  if(name==="other principal") who.userId="other";
  if(name==="outside cap") cap=51;
  if(name==="invalid window") window.to=window.from;
  if(name==="missing project") target.scope="project";
  if(name==="project on agent") target.projectId="workspace";
  if(name==="target control") target.agentId="bad\x00id";

  const loaded: string[] = [];
  const source: SelectionSource = {
    sessions(_target,_window,limit,offset=0){return sessions.slice(offset,offset+limit);},
    mayRead(_target,row){return !unreadable.includes(row.id);},
    transcript(row){
      loaded.push(row.id);
      const messages = name==="empty"?[]:Array.from({length:name==="message cap"?2001:1},(_,i)=>({
        id:"msg"+i,sessionId:name==="cross message"?"other":row.id,turnId:"turn",seq:i,role:"user" as const,
        text:name==="byte cap"?"é".repeat(132_000):"example",tokens:2,createdAt:23,
      }));
      const events = name==="empty"?[]:Array.from({length:name==="event cap"?4001:1},(_,i)=>({
        sessionId:name==="cross event"?"other":row.id,turnId:"turn",seq:i,type:"turn.started" as const,data:{origin:"fixture"},at:23,
      }));
      return {session:name==="cross transcript"?{...row,owner:deriveUserPrincipal("other")}:row,
        messages,events,days:name==="empty"?[]:["1970-01-01"],...(name==="person source"?{personMessageIds:["msg0"]}:{})};
    },
  };
  let result;
  try{
    const {transcripts,truncated,omittedSessions}=selectTranscriptsWithCounts(source,target,who,window,cap);
    result={ids:transcripts.map(t=>t.session.id),digest:selectionDigest(transcripts),truncated,omittedSessions};
  }catch(error){
    if(!(error instanceof LearnError))throw error;
    result={error:error.reason};
  }
  return {name,target,who,window,cap,sessions,unreadable,expected:{...result,loaded,targetHash:targetHash(target)}};
}

export function buildLearnSelectionVectors(){
  return {selection:["rank and cap","scope filtering","project","installation","duplicate across pages","non-human","other principal",
    "outside cap","invalid window","missing project","project on agent","target control","cross transcript","cross message","cross event",
    "message cap","event cap","byte cap","empty","person source"].map(scenario)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"learn",build:buildLearnSelectionVectors});
}
