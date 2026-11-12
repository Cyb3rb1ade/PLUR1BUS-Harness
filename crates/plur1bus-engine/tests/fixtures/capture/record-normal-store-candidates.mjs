// Records actual pinned Node normal-store candidate and safe-duplicate selection; never edit its output.
// PLUR1BUS_ENGINE_SRC=/path/to/pin PLUR1BUS_ENGINE_GIT=/read-only/git node record-normal-store-candidates.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const assert = (await import("node:assert/strict")).default;
const {MemoryDB}=await load("engine/store/memory-db.js");
const NOW=1735689600000,OWNER=`user:v1:${sha("synthetic selection owner")}`,WORKSPACE="workspace:v1:selection";
const text="I enjoy drinking coffee every morning.";
const row=(n,distance,extra={})=>({id:`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`,text,agentId:"alpha",storedBy:"alpha",ownerUserId:OWNER,workspaceId:WORKSPACE,workspaceKey:WORKSPACE,scope:"agent-private",status:"active",epistemicStatus:"",validFrom:0,validUntil:0,_distance:distance,...extra});
const scenarios=[
 {name:"empty",rows:[]},
 {name:"duplicate-exact",rows:[row(1,0)]},
 {name:"exact-text-low-score",rows:[row(1,3)]},
 {name:"unsafe-version",text:"Use version 3",rows:[row(1,0,{text:"Use version 2"})]},
 {name:"case-punctuation",text:"i enjoy drinking coffee every morning!",rows:[row(1,.01)]},
 {name:"merge-band",text:"I enjoy coffee every morning",rows:[row(1,.2)]},
 {name:"below-merge",text:"unrelated",rows:[row(1,1)]},
 {name:"duplicate-boundary",threshold:0.8,merge:.7,rows:[row(1,.25)]},
 {name:"merge-boundary",threshold:.95,merge:.8,text:"related",rows:[row(1,.25)]},
 {name:"top-sorted-stable",text:"related",rows:[row(1,.4),row(2,.2),row(3,.2)]},
 {name:"first-ten-only",text:"target exact",rows:[...Array.from({length:10},(_,i)=>row(i+1,.9,{text:"unrelated"})),row(20,2,{text:"target exact"})]},
 {name:"first-five-only",text:"unrelated",rows:[...Array.from({length:5},(_,i)=>row(i+1,0,{text:"unrelated near"})),row(20,.25)]},
 {name:"inactive-invalidated",rows:[row(1,0,{status:"superseded"}),row(2,0,{epistemicStatus:"invalidated"}),row(3,.01)]},
 {name:"null-status",rows:[row(1,0,{status:null})]},
 {name:"empty-status",rows:[row(1,0,{status:""}),row(2,.1)]},
 {name:"same-window",window:{validFrom:10,validUntil:20},rows:[row(1,0,{validFrom:10,validUntil:20})]},
 {name:"different-window",window:{validFrom:10,validUntil:20},rows:[row(1,0,{validFrom:10,validUntil:21})]},
 {name:"known-vs-unknown",window:{validFrom:10},rows:[row(1,0)]},
 {name:"first-unsafe-second-safe",window:{validFrom:10,validUntil:20},rows:[row(1,0,{validFrom:11,validUntil:20}),row(2,.01,{validFrom:10,validUntil:20})]},
 {name:"invalid-time-becomes-unknown",window:{validFrom:-1,validUntil:1.5},rows:[row(1,0,{validFrom:"invalid",validUntil:null})]},
 {name:"string-time",window:{validFrom:"10",validUntil:"20"},rows:[row(1,0,{validFrom:10,validUntil:20})]},
 {name:"unsafe-integer-time",window:{validFrom:9007199254740992},rows:[row(1,0)]},
 {name:"foreign-duplicate-starvation",rows:[...Array.from({length:10},(_,i)=>row(i+1,0,{agentId:"beta",storedBy:"beta"})),row(20,.01)]},
 {name:"foreign-merge-starvation",text:"related",rows:[...Array.from({length:5},(_,i)=>row(i+1,.2,{agentId:"beta",storedBy:"beta"})),row(20,.3)]},
];
const root=mkdtempSync(join(realpathSync(tmpdir()),"plur1bus-selection-oracle-"));
let engine;
try {
 const host=createStubHost({stateDir:join(root,"state"),pathOverrides:{[`${legacyMarker}Home`]:()=>root,stateDirOverride:()=>join(root,"state"),configPathOverride:()=>join(root,"state/config.json")},runtime:{llm:{complete:async()=>({text:"{}"})}}});
 engine=createEngine(host,{baseDbPath:join(root,"stores"),embedding:{provider:"local-transformers",local:{dimensions:384}},autoCapture:false,autoRecall:false,neo:{enabled:false},gc:{enabled:false},obsidianBridge:{enabled:false},metaCognition:{enabled:false}},{internals:{embeddings:hashEmbedder(),reranker:null}});
 const internal=internalsOf(engine);
 const {resolveDefaultArchiveDir}=await load("lib/telegram-commands/memory-edit.js");
 assert.equal(resolveDefaultArchiveDir(),join(root,`.${legacyMarker}`,"memory","_archive"));
 const access={agentId:"alpha",userPrincipal:OWNER,workspaceKey:WORKSPACE,workspaceAliases:{paths:[],aliases:[]}};
 const active=row=>(row.status==null||row.status==="active")&&row.epistemicStatus!=="invalidated";
 async function execute(s,authorizedFirst=false){
   const trace=[];
   const available=authorizedFirst?s.rows.filter(r=>internal.candidateVisibleForStore({entry:r},access)):s.rows;
   const db={init:async()=>{},_assertTrustedPath(){},_read:async(p,label)=>{trace.push({read:label});return p;},table:{countRows:async()=>available.length,vectorSearch(vector){const query={vector};return{where(predicate){query.predicate=predicate;return this;},limit(limit){query.limit=limit;return this;},async toArray(){trace.push(query);return available.filter(active).slice(0,query.limit);}};}},vectorSearchActive:MemoryDB.prototype.vectorSearchActive};
   const duplicate=await MemoryDB.prototype.findSimilar.call(db,[1,0],s.text??text,s.threshold??.95);
   const visible=duplicate.filter(c=>internal.candidateVisibleForStore(c,access));
   const safe=internal.findSafeDuplicateForValidity(visible,s.text??text,s.window??{})??null;
   const merge=await MemoryDB.prototype.findMergeCandidate.call(db,[1,0],s.merge??.7,s.threshold??.95);
   return {inputRows:available.filter(active),duplicates:duplicate,visibleDuplicates:visible,safe,merge:internal.candidateVisibleForStore(merge,access)?merge:null,rawMerge:merge,trace};
 }
 async function record(){const out=[];for(const scenario of scenarios){out.push({scenario,observed:await execute(scenario),authorizedFirst:await execute(scenario,true)});}return out;}
 const cases=await record();assert.deepEqual(await record(),cases);
 const output=JSON.stringify({pin,node:process.version,sourceHashes:hashes,sourcePathJoiner:["open","claw"],boundaries:{database:"offline preordered query port; actual MemoryDB and engine selectors",filter:"fixed Node active/epistemic predicate emulated by port; query text recorded",authorization:"actual pinned candidateVisibleForStore, both before and after budgets",normalization:"none"},cases},null,2)+"\n";
 writeFileSync(join(here,"golden/normal-store-candidates.json"),output);
 console.log(`Recorded ${cases.length} actual candidate selections twice; SHA-256 ${sha(output)}`);
}finally{await engine?.close({budgetMs:5000});rmSync(root,{recursive:true,force:true});}
