import { pathToFileURL } from "node:url";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { aggregate, mergeEvidence, parseExtraction, vocabulary } from "../../packages/core/src/dreams/learn/aggregation.ts";
import { precisionGate, scoreFinding } from "../../packages/core/src/dreams/learn/calibration.ts";
import { LearnError, type Target, type Transcript } from "../../packages/core/src/dreams/learn/types.ts";
import { exporterMain } from "./lib.mjs";

const target:Target={scope:"agent",owner:"owner",agentId:"alpha"};
const owner=deriveUserPrincipal(target.owner);

function transcript(name:string):Transcript{
  return {session:{id:"s1",owner,agentId:"alpha",scope:"workspace",memoryMode:"remember",chatKey:null,
    kind:name.startsWith("channel")?"channel":"direct",...(name==="external origin"?{origin:"a2a" as const}:{}),
    updatedAt:1,createdAt:1,lastTurnAt:1,archivedAt:null,pinned:false,title:"",turnCount:1},
    messages:[{id:"person",sessionId:"s1",turnId:"turn1",seq:1,role:"user",text:"example",tokens:2,createdAt:1},
      {id:"agent",sessionId:"s1",turnId:"turn1",seq:2,role:"assistant",text:"example",tokens:2,createdAt:1}],
    events:[{sessionId:"s1",turnId:"turn1",seq:1,type:"turn.completed",data:{},at:1}],
    personMessageIds:name==="channel linked"?["person"]:[],days:["1970-01-01"]};
}

function extract(name:string){
  const source=transcript(name);
  const input={
    kind:"knowledge",change:"add",text:"  Untrusted notes  ",contentKey:"  ＢＲＡＮＣＨ\u00a0 Label  ",
    evidence:[{source:"message",id:"person"}],...(name==="two checks"?{checks:[{path:"docs/notes.md",contains:"notes"},{path:"src/lib.rs",contains:"use"}]}:{})
  };
  if(name==="valid event")input.evidence=[{source:"event",id:"1"}];
  if(name==="agent evidence")input.evidence=[{source:"message",id:"agent"}];
  if(name==="foreign id")input.evidence=[{source:"message",id:"other"}];
  if(name==="empty evidence")input.evidence=[];
  if(name==="bad kind")input.kind="inferred";
  if(name==="bad change")input.change="apply";
  if(name==="long text")input.text="😀".repeat(2001);
  if(name==="invalid content key")input.contentKey="bad\x01key";
  const object:Record<string,unknown>={...input};
  if(name==="fake trust")object.evidence=[{source:"message",id:"person",trust:"verified"}];
  if(name==="wrong memory id")object.memoryId="../fake";
  if(name==="extra field")object.target=target;
  if(name==="wrong check")object.checks=[{path:"x",contains:""}];
  const raw=JSON.stringify(name==="empty"?[]:name==="not array"?object:[object]);
  let expected;
  try{expected={raw:parseExtraction(raw,source)};}catch(error){if(!(error instanceof LearnError))throw error;expected={error:error.reason};}
  return {name,transcript:source,raw,expected};
}

export function buildLearnFindingVectors(){
  const extraction=["valid direct","agent evidence","channel linked","channel unlinked","external origin","valid event","two checks",
    "foreign id","empty evidence","bad kind","bad change","long text","invalid content key","fake trust","wrong memory id",
    "extra field","wrong check","empty","not array"].map(extract);
  const current=parseExtraction(extraction[0]!.raw,extraction[0]!.transcript)[0]!;
  const many={...current,text:"Many observations",evidence:[{...current.evidence[0]!,trust:"verified" as const},
    {...current.evidence[0]!,sessionId:"s2",sourceId:"evt2",day:"1970-01-02",trust:"verified" as const},
    {...current.evidence[0]!,sessionId:"s3",sourceId:"evt3",day:"1970-01-02",agentId:"beta",trust:"verified" as const}]};
  const batch=[current,many,{...current,kind:"procedural" as const,contentKey:"procedure",text:"Procedure"}];
  const findings=aggregate(batch,target,"run-fixture",7);
  const collationBatch=[
    ["case", "ärger im Büro"], ["case", "Ärger im Büro"],
    ["tie", "é"], ["tie", "e\u0301"],
    ["über", "über"], ["zebra", "Zebra"],
    ["äther", "Äther"], ["f", "f"],
    ["😀", "😀"], ["é", "é"],
  ].map(([contentKey,text]) => ({ ...current, contentKey: contentKey!, text: text! }));
  const other=aggregate([{...many,kind:"knowledge",change:"stale",memoryId:"existing",contentKey:undefined,text:"Same retained record"}],target,"run-fixture",7)[0]!;
  const scored=["agent verified","explicit manual","instruction","sensitive","untrusted","project match","contradicted","stale","retire"].map(name=>{
    const base=structuredClone((name==="stale"?other:findings.find(f=>f.kind==="knowledge"))!);
    base.evidence=many.evidence;
    if(name==="instruction")base.text="Always use the fixture";
    if(name==="sensitive")base.text="A diagnosis appears in the source";
    if(name==="untrusted")base.evidence=base.evidence.map(e=>({...e,trust:"untrusted"}));
    if(name==="project match")base.target={...base.target,scope:"project",projectId:"workspace"};
    if(name==="project match"){base.verify="supported";base.agreement="agrees";}
    if(name==="contradicted"){base.agreement="contradicts";}
    if(name==="stale")base.verify="contradicted";
    if(name==="retire")base.change="retire";
    const safety={personAuthored:name==="explicit manual",sensitive:false,targetVerified:true};
    const result=scoreFinding(base,safety);
    return {name,input:base,safety,expected:{score:result.score,desiredTier:result.desiredTier,effectiveTier:result.effectiveTier}};
  });
  return {findings:{extraction,aggregate:{batch,target,expected:findings,vocabulary:vocabulary(batch),
    merged:mergeEvidence(findings[0]!,{...findings[0]!,evidence:many.evidence})},scored,
    collation:{batch:collationBatch,target,expected:aggregate(collationBatch,target,"run-fixture",7),
      vocabulary:vocabulary(collationBatch)},
    precision:[[0,0],[49,49],[47,50],[48,50],[95,100]].map(([accepted,decided])=>precisionGate(accepted!,decided!))}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"learn",build:buildLearnFindingVectors});
}
