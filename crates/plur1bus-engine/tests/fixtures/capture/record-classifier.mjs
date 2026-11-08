// Records actual pinned Node capture rows and chunk plans; never edit its output.
// PLUR1BUS_ENGINE_SRC=/path/to/pin PLUR1BUS_ENGINE_GIT=/read-only/git node record-rows.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pin = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const sourceGit = process.env.PLUR1BUS_ENGINE_GIT;
if (!source || !sourceGit) throw new Error("pinned source and read-only Git source are required");
if (process.version !== "v24.21.0") throw new Error("capture recorder requires Node 24.21.0");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", ["-C", sourceGit, ...args], { maxBuffer: 16 * 1024 * 1024 });
const legacyMarker = ["open", "claw"].join("");
const paths = git("ls-tree", "-r", "--name-only", pin, "engine", "lib", "tests/helpers", "package.json", `${legacyMarker}.plugin.json`)
  .toString().trim().split("\n").filter((name) => /\.(?:js|json)$/.test(name));
const hashes = [];
for (const name of paths) {
  const expected = sha(git("show", `${pin}:${name}`));
  const actual = sha(readFileSync(join(source, name)));
  if (actual !== expected) throw new Error("pinned source hash mismatch");
  hashes.push({ pathParts: name.split(legacyMarker), sha256: actual });
}

// Dependencies resolve from this prepared Harness checkout; Node source still comes from the verified pin.
const require = createRequire(resolve(here, "../../../../../packages/core/package.json"));
const engineRequire = createRequire(require.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
const dependencies = new Map(["@lancedb/lancedb", "apache-arrow", "openai", "@huggingface/transformers"]
  .map((name) => [name, pathToFileURL(engineRequire.resolve(name)).href]));
registerHooks({
  resolve(specifier, context, nextResolve) {
    return dependencies.has(specifier)
      ? { url: dependencies.get(specifier), shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const load = (name) => import(pathToFileURL(join(source, name)).href);
// Verify the test helper before importing it, as for every engine source above.
const helper = "tests/helpers/hash-embedder.js";
const helperExpected = sha(git("show", `${pin}:${helper}`));
if (sha(readFileSync(join(source, helper))) !== helperExpected) throw new Error("pinned helper hash mismatch");
hashes.push({ pathParts: [helper], sha256: helperExpected });
const [{ createEngine }, { internalsOf }, { createStubHost }, { hashEmbedder }] = await Promise.all([
  load("engine/create-engine.js"), load("engine/internals.js"), load("lib/host-services.js"),
  load("tests/helpers/hash-embedder.js"),
]);
const assert=(await import("node:assert/strict")).default;
const fixedNow=1_710_000_000_000;
const RealDate=Date,realFetch=globalThis.fetch;
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[fixedNow]));}static now(){return fixedNow;}};
globalThis.fetch=async()=>{throw new Error("unrecorded network refused");};
const answer=JSON.stringify({valence:0.6,arousal:0.4,dominance:0.5,intensity:0.7,primary_emotion:"joy",secondary_emotion:"trust",emotion_labels:{joy:0.7,trust:0.3},confidence:0.92,language:"en"});
const texts=["The release planning meeting takes place every Thursday morning.","I am very happy and grateful that the public fixture project is finally ready!","I am sad and worried about the public fixture release schedule.","I trust the team and appreciate their reliable work on the public fixture."];
const scenarios=[
 {name:"no-provider",config:{}},
 {name:"deferred",provider:"valid",config:{}},
 {name:"inline",provider:"valid",config:{emotion:{t3:{captureMode:"inline"}}}},
 {name:"fixed-t1",provider:"valid",config:{emotion:{tier:"t1"}}},
 {name:"fixed-t2",provider:"valid",config:{emotion:{tier:"t2"}}},
 {name:"fixed-t3",provider:"valid",config:{emotion:{tier:"t3"}}},
 {name:"t3-disabled",provider:"valid",config:{emotion:{t3:{enabled:false}}}},
 {name:"inline-refused",provider:"throw",config:{emotion:{t3:{captureMode:"inline"}}}},
 {name:"inline-malformed",provider:"malformed",config:{emotion:{tier:"t3",t3:{captureMode:"inline"}}}},
 {name:"confident-deferred",provider:"valid",config:{emotion:{t3:{escalationConfidence:0}}}},
 {name:"importance-forces-pending",provider:"valid",config:{emotion:{t3:{escalationConfidence:0,refineImportanceMin:0.4}}}},
 {name:"temperament",config:{emotion:{temperaments:{"capture-agent":{baseline:{joy:0.9,trust:0.1},moodInfluence:0.7}}}}},
 {name:"flashbulb",provider:"valid",config:{emotion:{tier:"t3",intensityHalfLifeFactor:2},memoryDynamics:{flashbulbEncoding:true}}},
 {name:"reminder",config:{},texts:["Remind me in 5 minutes to check the public fixture release checklist."]},
];
for(const scenario of scenarios){
 if(scenario.provider || scenario.name==="no-provider")scenario.config={...scenario.config,emotion:{...scenario.config.emotion,t3:{enabled:true,...scenario.config.emotion?.t3}}};
}
const columns=["text","sourceMessageRole","category","importance","importanceStatus","emotionalValence","emotionalIntensity","emotionalDominant","moodContextAtCapture","emotionStatus","memoryStrength","halfLifeDays","lastStrengthenedAt","lastDynamicsAt","memoryClass","neverForget","coreMemoryScore","coreMemoryReason","memoryKind","remindAt","reminderStatus"];
async function run(){const results=[];
 for(const scenario of scenarios){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"capture-classifier-"))),workspace=join(root,"workspace");mkdirSync(workspace);
  const calls=[];let engine;
  try{
   const llm=scenario.provider?{async complete(params){const {signal,purpose,...contract}=params;calls.push({line:JSON.stringify(contract),purpose:purpose??null,cancel:signal instanceof AbortSignal});if(scenario.provider==="throw")throw new Error("synthetic unavailable route");return {text:scenario.provider==="malformed"?"invalid fixture answer":answer,provider:"fixture",model:"fixture",usage:{}};}}:undefined;
   const host=createStubHost({stateDir:join(root,"state"),logger:{info(){},warn(){},error(){},debug(){}},clock:()=>fixedNow,workspaceDir:async()=>workspace,llm,runtime:llm?{llm}:null});
   const config={...scenario.config,baseDbPath:join(root,"stores"),embedding:{provider:"local-transformers",local:{dimensions:384}},autoCapture:true,autoRecall:false,captureChunking:false,duplicateThreshold:1.01,neo:{enabled:false},metaCognition:{enabled:false},merging:{enabled:false},runtime:{llmResultCacheEnabled:false,llmResultCachePersist:false}};
   engine=createEngine(host,config,{internals:{embeddings:hashEmbedder(),reranker:null}});
   const outcomes=[];
   for(const [index,content] of (scenario.texts??texts).entries()){
    outcomes.push(await engine.capture({agentId:"capture-agent",principal:{agentId:"capture-agent",workspace:`workspace-dir:v1:${workspace}`,channel:"telegram",accountId:"default",chat:{id:"capture-chat",kind:"direct"},trust:"proved"},agent:{origin:"user",background:false},messages:[{role:index%2===1?"assistant":"user",content}],runId:`classifier-${index}`,sessionKey:"classification-session",incognito:false,signal:AbortSignal.timeout(15000)},{}).done);
   }
   const rows=await internalsOf(engine).pool.withDb("capture-agent",async db=>{await db.init();return (await db.table.query().toArray()).filter(row=>row.id!=="__schema__").map(row=>Object.fromEntries(columns.map(key=>[key,typeof row[key]==="bigint"?Number(row[key]):row[key]])));});
   assert(rows.length>0,`scenario must actually store rows: ${scenario.name}; ${JSON.stringify(outcomes)}`);
   assert(outcomes.some(outcome=>outcome.stored>0),`capture must commit: ${scenario.name}`);
   if(["inline","fixed-t3","flashbulb"].includes(scenario.name))assert(calls.length>0,`enabled route must be called: ${scenario.name}`);
   if(scenario.name==="deferred")assert(rows.some(row=>row.emotionStatus==="pending_t3"),"deferred provider must produce pending rows");
   results.push({scenario,outcomes,rows,calls});
  }finally{await engine?.close({budgetMs:5000});rmSync(root,{recursive:true,force:true});}
 }return results;}
try{
 const recordings=await run();assert.deepEqual(await run(),recordings);
 const metadata={commit:pin,node:process.version,fixedNow,sourceHashes:hashes,sourcePathJoiner:["open","claw"],fixturePorts:{embedding:"pinned hash embedder",llm:"recorded synthetic callback; no network",reranker:"absent"}};
 const output=JSON.stringify({metadata,answer,recordings},null,2)+"\n";
 if(output.toLowerCase().includes(legacyMarker))throw new Error("invalid naming");
 writeFileSync(join(here,"golden/classifier.json"),output);
 console.log(`Recorded ${recordings.length} actual capture/Lance scenarios twice`);
}finally{globalThis.Date=RealDate;globalThis.fetch=realFetch;}
