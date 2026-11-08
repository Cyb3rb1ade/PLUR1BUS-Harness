// RE-05/T3 emotion recordings and production vocabulary extraction from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file> [--write-data]
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") throw new Error("pinned source, read-only git and Node 24.21.0 required");
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned emotion source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

for(const file of ["lib/speaker-segment-schema.js","lib/speaker-proposer.js","lib/speaker-mapping-store.js"])verify(file);
const api=await import(pathToFileURL(path.join(root,"lib/speaker-segment-schema.js")));
const proposer=await import(pathToFileURL(path.join(root,"lib/speaker-proposer.js")));
const mappings=await import(pathToFileURL(path.join(root,"lib/speaker-mapping-store.js")));
const {bindHostPaths,resetHostPaths}=await import(pathToFileURL(path.join(root,"lib/host-paths.js")));
const assert=(await import("node:assert/strict")).default;
delete process.env.PLUR1BUS_SPEAKER_MAPPING_FORCE_MEMORY;
const NOW=1710000000000;const RealDate=Date;
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NOW;}};
const inputs=[null,{},[],true,"plain",{speakerLabel:"speaker_0",text:"Hello fixture"},
 ...["discord_voice","telegram_voice","youtube","upload","podcast","meeting","unknown","other",null].map(source=>({source,text:"Public fixture",speakerLabel:"speaker_0"})),
 ...["discord_user_stream","asr_diarize","sortformer","manual","contextual_proposal","enrollment","unknown","invalid"].map(attributionSource=>({attributionSource})),
 {sourceId:0,speakerDisplayName:true,startMs:null,endMs:"0x10",speakerConfidence:"0.7",words:[null,{startMs:null,endMs:-5,word:123,confidence:"Infinity"}]},
 {sourceId:[1,null,2],speakerDisplayName:{name:"fixture"},startMs:10,endMs:-5,words:[],diarizationModel:23,asrModel:false},
 {speakerLabel:"",text:2,speakerConfidence:4,startMs:"Infinity",endMs:"NaN",words:"invalid"},
 {speakerLabel:"s\ud83d",text:"x\ud83d",speakerDisplayName:"n\ud83d"},
];
const transcripts=["<!-- media-output-id: abcd-1234 -->\nHallo Alex", "prefix <!-- media-output-id: ABCD-1234 --> suffix", "<!-- media-output-id: abc -->\n<!-- media-output-id: def -->\nText", "<!-- media-output-id: invalid -->\nText", "Public fixture"]; 
const utterances=["Hallo Alex!","HalloAlex!","Hi, Jordan.","Hey Kim! Hallo Alex!","Danke schön Alex!","Vielen Dank Alex!","Excuse me, Morgan!","Hallo Ömer!","Hallo x!","hi alice", "Hallo Alex! Hallo Alex!", "Guten Morgen Taylor!", "ordinary text", "Sorry,Alice.","Moin\ufeffAlex!"];
async function run(){
 const normalized=inputs.map(input=>({input,line:JSON.stringify(api.normalizeSpeakerSegment(input)),formattedLine:JSON.stringify(api.formatSpeakerSegments([input])),mappedLine:JSON.stringify(api.applySpeakerMappings([input],new Map([["speaker_0","Confirmed Fixture"],["unknown","Unknown Fixture"]])))}));
 const media=transcripts.map(input=>({input,strippedLine:JSON.stringify(api.stripMediaOutputIdToken(input)),ids:api.extractMediaOutputIds(input)}));
 const proposals=[];
 for(const confirmed of [false,true])for(const text of utterances){
  const scratch=mkdtempSync(path.join(tmpdir(),"speaker-proposals-"));
  try{
   bindHostPaths({stateDirOverride:()=>scratch});
   const db=mappings.getSpeakerMappingDb();assert.equal(typeof db.prepare,"function","actual SQLite required");
   if(confirmed)mappings.setManualSpeakerMapping("alpha","speaker_0","Confirmed Fixture");
   mappings.setManualSpeakerMapping("beta","speaker_0","Other Agent");
   const segments=[{speakerLabel:"speaker_0",text},{speakerLabel:"speaker_1",text:"Hi Robin!"}];
   const result=await proposer.proposeSpeakerNames(segments,"alpha");
   const first=proposer.storeNewProposals("alpha",result);const second=proposer.storeNewProposals("alpha",result);
   const rows=mappings.getSpeakerMappingsByAgent("alpha");
   const active=new Map(mappings.getConfirmedMappings("alpha").map(m=>[m.speakerLabel,m.speakerDisplayName]));
   proposals.push({text,confirmed,segments,line:JSON.stringify(result),first,second,rowsLine:JSON.stringify(rows),mappedLine:JSON.stringify(api.applySpeakerMappings(segments,active))});
  }finally{mappings.resetSpeakerMappingDbForTests();resetHostPaths();rmSync(scratch,{recursive:true,force:true});}
 }
 const identityAliases=[];
 for(const label of ["s\ud83d","s\udc00"]){
  const scratch=mkdtempSync(path.join(tmpdir(),"speaker-alias-"));
  try{
   bindHostPaths({stateDirOverride:()=>scratch});
   assert.equal(typeof mappings.getSpeakerMappingDb().prepare,"function");
   const segments=[{speakerLabel:label,text:"Hallo Alex!"},{speakerLabel:"s�",text:"Hi Jordan!"}];
   const proposed=await proposer.proposeSpeakerNames(segments,"alpha");
   const counts=proposer.storeNewProposals("alpha",proposed);
   identityAliases.push({segments,proposalsLine:JSON.stringify(proposed),counts,rowsLine:JSON.stringify(mappings.getSpeakerMappingsByAgent("alpha"))});
  }finally{mappings.resetSpeakerMappingDbForTests();resetHostPaths();rmSync(scratch,{recursive:true,force:true});}
 }
 return {normalized,media,proposals,identityAliases};
}
try{
 const result=await run();assert.deepEqual(await run(),result);
 const here=path.dirname(fileURLToPath(import.meta.url));
 writeFileSync(path.join(here,"golden/speaker.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},...result},null,2)+"\n");
 console.log(`Recorded ${result.normalized.length} normalization, ${result.media.length} media, ${result.proposals.length} SQLite proposal and ${result.identityAliases.length} SQLite identity-alias cases twice`);
}finally{globalThis.Date=RealDate;}
