// Records actual pinned Node knowledge-pending file transitions; never edit its output.
// PLUR1BUS_ENGINE_SRC=/path/to/pin PLUR1BUS_ENGINE_GIT=/read-only/git node record-knowledge-pending.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const {readKnowledgePendingSnapshot,trackKnowledgePending,removeKnowledgePending}=await load("engine/knowledge/knowledge-pending.js");
const assert=(await import("node:assert/strict")).default;
const NOW=1735689600000;let clock=NOW;
const RealDate=Date,previousFetch=globalThis.fetch;
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
globalThis.fetch=async()=>{throw new Error("unrecorded network refused");};
const item=(id,extra={})=>({sourceAgent:"alpha",memoryId:id,...extra});
const scenarios=[
 {name:"empty"},
 {name:"defaults",raw:{pending:[item("a"),item("b",{category:"decision",importance:0.8})]}},
 {name:"last-store-fallback",raw:{lastStoreAt:"2024-01-01T00:00:00.000Z",lastUpdateAt:"2024-06-01T00:00:00.000Z",pending:[item("a",{importance:"0.7",reason:"fixture"})]}},
 {name:"duplicate-key-last-wins",raw:{pending:[item("a",{importance:0.2}),item("b",{importance:0.7}),item("a",{importance:0.9,category:"decision"})]}},
 {name:"newest-first-stable-ties",raw:{pending:[item("a",{importance:0.7,queuedAt:"2024-01-01T00:00:00.000Z"}),item("b",{importance:0.7,queuedAt:"2024-02-01T00:00:00.000Z"}),item("c",{importance:0.7,queuedAt:"2024-02-01T00:00:00.000Z"})]}},
 {name:"legacy-ids",raw:{pendingMemoryIds:["legacy-a","",null,"legacy-b"],lastStoreAt:"2024-01-01T00:00:00.000Z"}},
 {name:"legacy-key-collision",raw:{pending:[item("a",{key:"legacy-a",importance:0.8})],pendingMemoryIds:["legacy-a"]}},
 {name:"cap-read",raw:{pending:Array.from({length:205},(_,i)=>item(`id-${i}`,{importance:i/300}))}},
 {name:"track-empty",actions:[{kind:"track",memory:item("a")}]},
 {name:"track-replaces-own-key",raw:{pending:[item("a",{importance:0.9,queuedAt:"2024-01-01T00:00:00.000Z"}),item("b")]},actions:[{kind:"track",memory:item("a",{importance:0.6,category:"decision",reason:"explicit"})}]},
 {name:"distinct-source-agents",actions:[{kind:"track",memory:item("a")},{kind:"track",memory:item("a",{sourceAgent:"beta",importance:0.8})}]},
 {name:"legacy-and-tracked",raw:{pendingMemoryIds:["a"]},actions:[{kind:"track",memory:item("a")}]},
 {name:"track-over-cap",raw:{pending:Array.from({length:200},(_,i)=>item(`id-${i}`,{importance:0.7}))},actions:[{kind:"track",memory:item("new",{importance:0.8})}]},
 {name:"track-low-over-cap",raw:{pending:Array.from({length:200},(_,i)=>item(`id-${i}`,{importance:0.7}))},actions:[{kind:"track",memory:item("new",{importance:0.1})}]},
 {name:"track-missing-id",actions:[{kind:"track",memory:{sourceAgent:"alpha"}}]},
 {name:"remove-key",raw:{pending:[item("a"),item("b")],pendingMemoryIds:["a"]},actions:[{kind:"remove",keys:["alpha:a"],legacy:[]}]},
 {name:"remove-legacy-only",raw:{pending:[item("a"),item("b")],pendingMemoryIds:["a"]},actions:[{kind:"remove",keys:[],legacy:["a"]}]},
 {name:"remove-empty",actions:[{kind:"remove",keys:[],legacy:[]}]},
 {name:"track-remove-track",actions:[{kind:"track",memory:item("a",{importance:0.8})},{kind:"remove",keys:["alpha:a"],legacy:[]},{kind:"track",memory:item("a",{importance:0.6})}]},
];
function record(){return scenarios.map(scenario=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),"knowledge-pending-")));clock=NOW;
 const dir=join(root,".adaptive-learning"),path=join(dir,"knowledge-pending.json"),log=join(dir,"curation-log.jsonl");
 try{
  if(scenario.raw!==undefined){mkdirSync(dir);writeFileSync(path,JSON.stringify(scenario.raw));}
  const initial=readKnowledgePendingSnapshot(root),steps=[];
  for(const [index,action] of (scenario.actions??[]).entries()){
   clock=NOW+(index+1)*1000;
   if(action.kind==="track")trackKnowledgePending(root,action.memory);else removeKnowledgePending(root,action.keys,action.legacy);
   const persistedText=existsSync(path)?readFileSync(path,"utf8"):null;
   const persisted=persistedText===null?null:JSON.parse(persistedText);
   const snapshot=readKnowledgePendingSnapshot(root);
   const curation=existsSync(log)?readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line)):[];
   steps.push({now:clock,action,persisted,persistedText,snapshot,curation});
  }
  return {scenario,initial,steps};
 }finally{rmSync(root,{recursive:true,force:true});}
});}
try{
 const cases=record();assert.deepEqual(record(),cases);
 const output=JSON.stringify({pin,node:process.version,now:NOW,sourceHashes:hashes,sourcePathJoiner:["open","claw"],boundaries:{filesystem:"actual pinned read/track/remove helpers; real private temporary files and owned Node locks",providers:"none; network refused",normalization:"none; fixed clock only"},cases},null,2)+"\n";
 writeFileSync(join(here,"golden/knowledge-pending.json"),output);console.log(`Recorded ${cases.length} knowledge-pending cases twice; SHA-256 ${sha(output)}`);
}finally{globalThis.Date=RealDate;globalThis.fetch=previousFetch;}
