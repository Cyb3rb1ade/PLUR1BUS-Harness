// RE-05/T5 neo-narrative recordings from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file>
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "b097045b6f115275baa8b15016321c3ba080c812";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") {
  throw new Error("pinned source, read-only git and Node 24.21.0 required");
}
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned neo-narrative source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/episodes.js");

const { enrichEpisodeNarratively } = await import(pathToFileURL(path.join(root, "lib/episodes.js")));
const assert = (await import("node:assert/strict")).default;
const episode = { id: "episode", agentId: "alpha", title: "Original", summary: "Original summary", topics: ["original"], participants: ["Nutzer", "alpha"], emotionalDominant: "trust", emotionalIntensity: 0.4, emotionalTone: { joy: 0.2, trust: 0.4 }, opaque: { preserve: true } };
const turns = [{ role:"user", content:"Wir sprechen über Schulterschmerzen." }, { role:"assistant", content:"Ein Besuch bei Ada könnte helfen." }];
const names = { user:"Ada", assistant:"Alpha" };
const full = {title:" Der  Besuch ",summary:" Eine Geschichte. ",narrativeArc:"decision",turningPoint:" Die Wahl ",topics:["Schulterschmerzen","Besuch"],people:["Ada","Alpha","Grace"],emotion:"joy",emotionIntensity:"mittel"};
const inputs=[];
function add(name, response, extra={}) { inputs.push({ name, episode, turns, names, response: typeof response === "string" ? response : JSON.stringify(response), ...extra }); }
add("full",full);
for (const response of ["", " ", "null", "false", "42", '"string"', "[]", "{}", "invalid", "```JSON\n"+JSON.stringify(full)+"\n```", "prefix "+JSON.stringify(full)+" suffix", '{"title":"Broken"', '{"title":"First","title":"Last"}']) add("parse:"+response,response);
for(const [name,value] of [["low","niedrig"],["mid","mittel"],["high","hoch"],["unknown","unknown"],["missing",undefined],["null",null],["empty",""],["space"," "] ,["false",false],["true",true],["empty-array",[]],["single-array",[0.7]],["object",{}],["negative",-1],["large",2],["hex","0x10"]]) add("intensity:"+name,{emotion:"JOY",emotionIntensity:value});
for(const emotion of ["neutral","disgust","fear","nonsense"," TRUST "]) add("emotion:"+emotion,{emotion,emotionIntensity:"hoch"});
add("neutral-default",{emotion:"neutral"});
add("text-limits",{title:"x".repeat(81),summary:"s".repeat(601),turningPoint:"t".repeat(301),narrativeArc:"wrong"});
add("unicode-cuts",{title:"x".repeat(79)+"😀",summary:"s".repeat(599)+"😀",turningPoint:"t".repeat(299)+"😀"});
add("lists",{topics:[" a ","123","Topic","topic",false,". --","x".repeat(41),"Topic2","Topic3","Topic4","Topic5","Topic6"],people:["ada","ALPHA","Eva","Grace","grace","Linus","Alan","Edsger","Barbara","Extra"]},{episode:{...episode,voiceSpeakers:["Eva"]}});
add("list-unicode",{topics:["Äpfel","äpfel","Äpfel","ΟΣ","ος","οσ","Straße","STRASSE"],people:["ΩΜΕΓΑ","ωμεγα","ΟΣ","ος"]});
add("no-names",full,{names:null});
add("only-one-turn",full,{turns:turns.slice(0,1)});
add("one-existing-arc",full,{turns:turns.slice(0,1),episode:{...episode,narrativeArc:"emotional"}});
add("no-turns",full,{turns:[]});
add("tools-only",full,{turns:[{role:"tool",content:"secret"},{role:"tool",content:"skip"}]});
add("cleaned-empty",full,{turns:[{role:"user",content:"https://example.test/ 😀 `code`"},{role:"assistant",content:"<p> [media attached]"}]});
add("cleaning",full,{turns:[{role:"user",content:"[Audio Transcript] Ada: Hallo 😀 https://example.test/x <b> Text `code`\nNächster Satz\u0085Ende"},{role:"system",content:" System\t Kontext "}]});
add("newest-budget",full,{turns:Array.from({length:15},(_,i)=>({role:i%2?"assistant":"user",content:String(i).padStart(2,"0")+"x".repeat(620)}))});
add("prompt-surrogate-cut",full,{turns:[{role:"user",content:"x".repeat(599)+"𠀀suffix"},turns[1]]});
add("source-surrogate",full,{turns:[{role:"user",content:"bad\ud800source"},turns[1]]});
add("invalid-model-surrogate",{title:"bad\ud800title"});
add("provider-error",full,{fail:true});
add("voice-speakers",full,{episode:{...episode,voiceSpeakers:["Eva","Grace","ADA"]}});
add("model-cannot-change-authority",{...full,id:"forged",agentId:"other",ownerUserId:"other",scope:"global_user",memoryIds:["foreign"],opaque:{preserve:false}});
add("array-tone",{emotion:"joy",emotionIntensity:0.7},{episode:{...episode,emotionalTone:[0.1,0.2]}});
add("string-tone",{emotion:"joy",emotionIntensity:0.7},{episode:{...episode,emotionalTone:"ab"}});
add("nan-tone",{emotion:"joy",emotionIntensity:0.7},{episode:{...episode,emotionalTone:{joy:"not-a-number",trust:0.4}}});
add("content-coercion",full,{turns:[{role:"user",content:["Topic",null,"Text"]},{role:"assistant",content:{text:"source"}}]});
add("voice-coercion",full,{episode:{...episode,voiceSpeakers:[null,false,7,["Eva",null,"Ada"]]}});
async function record() {
 const out=[];
 for(const item of inputs) {
  const calls=[];
  const result=await enrichEpisodeNarratively(structuredClone(item.episode),structuredClone(item.turns),{},async(messages,cfg)=>{
   calls.push({messages,sha256:digest(JSON.stringify(messages)),maxTokens:cfg.maxTokens,temperature:cfg.temperature});
   if(item.fail)throw new Error("synthetic provider failure"); return item.response;
  },item.names?{participantNames:item.names}:{});
  out.push({...item,result,calls});
 }
 return out;
}
const cases=await record();assert.deepEqual(cases,await record());
const output={pin:PIN,sourcesSha256:Object.fromEntries(verified),cases};
writeFileSync(new URL("./golden/neo-narrative.json",import.meta.url),JSON.stringify(output,null,2)+"\n");
console.log(`Recorded ${cases.length} actual Node narrative cases twice`);
