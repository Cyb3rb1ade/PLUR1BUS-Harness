import { pathToFileURL } from "node:url";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { aggregate } from "../../packages/core/src/dreams/learn/aggregation.ts";
import { refuteFinding, wordFinding } from "../../packages/core/src/dreams/learn/refutation.ts";
import { verifyFinding, type LearnReadPort } from "../../packages/core/src/dreams/learn/verify.ts";
import { LearnError, type Transcript } from "../../packages/core/src/dreams/learn/types.ts";
import { exporterMain } from "./lib.mjs";

const owner=deriveUserPrincipal("ada");
const transcript:Transcript={session:{id:"s1",kind:"direct",agentId:"alpha",owner,scope:"workspace",
  chatKey:null,title:"",pinned:false,memoryMode:"remember",createdAt:0,updatedAt:2,lastTurnAt:2,archivedAt:null,turnCount:1},
  events:[],days:["1970-01-01"],messages:[{id:"msg1",sessionId:"s1",turnId:"t1",seq:1,role:"user",text:"fixture token",tokens:1,createdAt:2}]};

function finding(path:string,agent=false){
  return aggregate([{kind:"knowledge",change:"add",text:"Fixture claim",contentKey:"claim",
    evidence:[{sessionId:"s1",turnId:"t1",sourceId:"msg1",source:"message",trust:"person",day:"1970-01-01",agentId:"alpha",owner}],
    checks:[{path,contains:"fixture token"}]}],agent?{scope:"agent",owner:"ada",agentId:"alpha"}:
      {scope:"project",owner:"ada",agentId:"alpha",projectId:"workspace"},"run",1)[0]!;
}

export async function buildLearnReviewVectors(){
  const verification=[];
  for(const name of ["supported","contradicted","no read port","missing","truncated","byte cap","agent",
    "../outside","/rooted","C:\\absolute",".env",".git/config","foo//doc","notes/secret.md","notes/PRIVATE_key.txt"]){
    const checked=finding(name.includes("/")||name.includes("\\")||name===".env"?name:"docs/notes.md",name==="agent");
    const calls:unknown[]=[];
    const port:LearnReadPort={async call(method,args){
      calls.push({method,args});
      if(name==="missing")return {ok:false};
      const text=name==="byte cap"?"é".repeat(17_000):name==="contradicted"?"other text":"fixture token";
      return {ok:true,text,...(name==="truncated"?{truncated:true}:{})};
    }};
    const expected=await verifyFinding(checked,name==="no read port"?null:port,new AbortController().signal);
    verification.push({name,checked,expected,calls});
  }
  const review=[];
  for(const name of ["holds","refuted","insufficient","unknown verdict","extra field","missing evidence","C bypass","worded","empty wording","bad wording"]){
    const original=finding("docs/notes.md");
    original.desiredTier=name==="C bypass"?"C":"B";
    original.models=["small-fixture"];
    original.modelClasses=["small"];
    const stage=name==="worded"||name.endsWith("wording")?"wording":"skeptic";
    const body=stage==="wording"?{text:name==="empty wording"?"  ":name==="bad wording"?123:"  Clearer claim.  "}:
      name==="extra field"?{verdict:"holds",memoryId:"fake"}:{verdict:name==="unknown verdict"?"other":name};
    const response=JSON.stringify(body);
    const calls:unknown[]=[];
    const call=async (stage:string,key:string,data:unknown)=>{
      calls.push({stage,key,data});
      return {text:response,model:"large-fixture",inputTokens:2,outputTokens:1};
    };
    const sources=name==="missing evidence"?[]:[transcript];
    let expected;
    try{
      const result=stage==="wording"?await wordFinding(original,call):await refuteFinding(original,sources,call);
      expected={result};
    }catch(error){if(!(error instanceof LearnError))throw error;expected={error:error.reason};}
    review.push({name,stage,original,response,sources,calls,expected});
  }
  return {review:{verification,review}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"learn",build:buildLearnReviewVectors});
}
