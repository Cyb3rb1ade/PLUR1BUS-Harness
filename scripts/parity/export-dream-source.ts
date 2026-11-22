import { pathToFileURL } from "node:url";
import { createCandidateSource, itemsFromEngineList, readCandidateMemory,
  type EngineMemoryCard, type EngineMemoryList } from "../../packages/core/src/dreams/producer.ts";
import type { CandidateInput, CandidateRecallStats } from "../../packages/core/src/dreams/types.ts";
import { exporterMain } from "./lib.mjs";

const card=(id:string,text:string,scope="agent-private",createdAt=75):EngineMemoryCard=>({id,text,scope,createdAt});
async function listing(name:string){
  const items=[card("a"," Alpha "),card("b","Alpha"),card("shared","other","workspace"),card("c","Candidate")];
  const pages:EngineMemoryList[]=[{items,truncated:false}];
  if(name==="two pages")pages.splice(0,1,{items:[card("a","Alpha","agent-private",80),card("b","Beta","agent-private",20)],truncated:true},
    {items:[card("b","Beta","agent-private",20),card("c","Candidate","agent-private",1)],truncated:false});
  if(name==="no progress")pages[0]={items:[card("a","Alpha","agent-private",100)],truncated:true};
  if(name==="bad time")pages[0]={items:[card("a","Alpha","agent-private",-1)],truncated:true};
  if(name==="no boundary")pages[0]={items:[],truncated:true};
  if(name==="missing id")delete pages[0]!.items[0]!.id;
  if(name==="projection refused")pages[0]!.truncated=true;
  const calls:unknown[]=[];
  let result;
  try{
    const entries=name.startsWith("projection")?itemsFromEngineList(pages[0]!):await readCandidateMemory(async q=>{
      calls.push(q);return pages[calls.length-1]!;
    },100);
    result={entries};
  }catch{result={refused:true};}
  return {name,pages,expected:{...result,calls}};
}
async function stats(name:string){
  const items:CandidateInput[]=[{content:"candidate",memoryId:"id",recalls:8,uniqueQueries:4},{content:"shared",partition:"workspace",memoryId:"shared"}];
  let reply:CandidateRecallStats={agentId:"alpha",items:[{id:"id",recalls:3,distinctQueries:3,lastRecalledAt:4}]};
  if(name==="missing receipt")reply.items=[];
  if(name==="foreign scope")reply.agentId="beta";
  if(name==="foreign identity")reply.items[0]!.id="foreign";
  if(name==="duplicate receipt")reply.items.push(reply.items[0]!);
  if(name==="negative count")reply.items[0]!.recalls=-1;
  const calls:unknown[]=[];
  const source=createCandidateSource({list:()=>items,...(name==="old capability"?{}:{stats:async(agentId,ids)=>{calls.push({agentId,ids});return reply;}})});
  let result;
  try{result={entries:await source.pull("alpha")};}catch{result={refused:true};}
  return {name,items,reply,expected:{...result,calls}};
}
export async function buildDreamSourceVectors(){
  const listings=[],signals=[];
  for(const name of ["projection","projection refused","one page","two pages","no progress","bad time","no boundary","missing id"])listings.push(await listing(name));
  for(const name of ["measured","missing receipt","foreign scope","foreign identity","duplicate receipt","negative count","old capability"])signals.push(await stats(name));
  return {source:{listings,signals}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"dreams",build:buildDreamSourceVectors});
}
