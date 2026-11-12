// Records safeUpdate through actual pinned Node and Lance; never edit outputs.
// PLUR1BUS_ENGINE_SRC=/path/to/pin PLUR1BUS_ENGINE_GIT=/read-only/git node record-rows.mjs
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const {MemoryDB}=await load("engine/store/memory-db.js");
const {safeUpdate}=await load("lib/safe-update.js");
const {ensureEpistemicCutoff}=await load("lib/epistemic-cutoff.js");
const assert=(await import("node:assert/strict")).default;
const NOW=1710000000000, ID="00000000-0000-4000-8000-000000000001";
const RealDate=Date; globalThis.Date=class extends RealDate { constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NOW;} };
globalThis.fetch=async()=>{throw new Error("recorder refuses network");};
const evidence={updateSource:"capture",updateEvidence:"synthetic explicit evidence",confidence:0.8};
const version={text:"Revised synthetic claim",summary:"Revised summary",vector:[1,0,0,0]};
const cases=[
 {name:"version",patch:version},{name:"summary",patch:{summary:"Revised summary",vector:[1,0,0,0]}},
 {name:"metadata",patch:{importance:0.8,category:"preference"}}, {name:"vector",patch:{vector:[0,1,0,0]}},
 {name:"trusted",patch:version,fields:{epistemicStatus:"trusted"}},
 {name:"corroborated",patch:version,fields:{epistemicStatus:"corroborated"}},
 {name:"untrusted",patch:version,fields:{epistemicStatus:"untrusted"}},
 {name:"pending",patch:version,fields:{importanceStatus:"pending"}},
 {name:"explicit-importance",patch:{...version,importance:0.7},fields:{importanceStatus:"pending"}},
 {name:"critical",patch:version,fields:{type:"gesundheit",confirmed:false}},
 {name:"reminder-reset",patch:version,fields:{memoryKind:"reminder",reminderStatus:"pending",remindAt:NOW+1000,reminderKey:"synthetic-reminder"}},
 {name:"empty-patch",patch:{}},{name:"missing-vector",patch:{text:"Revised"}},
 {name:"missing-evidence",patch:version,evidence:{}},
 {name:"drift-rejected",patch:{...version,vector:[0,1,0,0]}},
 {name:"drift-bypass",patch:{...version,vector:[0,1,0,0]},skipDriftGate:true},
 {name:"inactive",patch:version,fields:{status:"superseded"}},
 {name:"idempotent",patch:version,idempotent:true}, {name:"event-read-failure",patch:version,fail:"read"},
 {name:"successor-write-failure",patch:version,fail:"store"},
 {name:"supersede-failure",patch:version,fail:"patch"},
 {name:"event-write-failure",patch:version,fail:"event"},
 {name:"edge-write-failure",patch:version,fail:"edge"},
];
async function record(){const output=[];
for(const definition of cases){
 const scratch=mkdtempSync(join(realpathSync(tmpdir()),"safe-update-"));let db;
 try{
 const base=join(scratch,"stores");mkdirSync(base);ensureEpistemicCutoff(base,NOW);
 db=new MemoryDB(join(base,"agent"),4);await db.init();
 await db.store({id:ID,text:"Original synthetic claim",summary:"Original summary",vector:[1,0,0,0],agentId:"agent",storedBy:"agent",scope:"agent-private",status:"active",epistemicStatus:"observed",importance:0.5,category:"fact",createdAt:NOW-1000,validFrom:NOW-5000,validUntil:NOW+5000,chunkGroupId:"synthetic-chunk",...definition.fields});
 const events=[],edges=[],calls=[];
 const original=await db.getById(ID);
 const neo={async readReconsolidationEvents(){calls.push("read");if(definition.fail==="read")throw new Error("fixture");if(definition.idempotent){const {computeIdempotencyKey}=await load("lib/safe-update.js");return [{idempotencyKey:computeIdempotencyKey(original,definition.patch,definition.evidence??evidence)}];}return events;},async appendReconsolidationEvents(rows){calls.push("event");if(definition.fail==="event")throw new Error("fixture");events.push(...rows);},async readGraphEdges(){return [{source:ID,target:"peer",kind:"related",weight:0.5}];},async appendGraphEdges(rows){calls.push("edge");if(definition.fail==="edge")throw new Error("fixture");edges.push(...rows);}};
 const wrapper={getById:id=>db.getById(id),async store(row){calls.push("store");if(definition.fail==="store")throw new Error("fixture");return db.store(row);},async update(id,patch){calls.push("patch");if(definition.fail==="patch")throw new Error("fixture");return db.update(id,patch);}};
 let result;try{result={value:await safeUpdate(wrapper,ID,definition.patch,definition.evidence??evidence,{neoStore:neo,skipDriftGate:definition.skipDriftGate})};}catch{result={error:true};}
 const schema=await db.table.schema();
 const project=row=>Object.fromEntries(schema.fields.map(field=>[field.name,field.name==="vector"?Array.from(row.vector):row[field.name]]));
 const rows=(await db.table.query().toArray()).filter(row=>row.id!=="__schema__").map(project).sort((a,b)=>a.id===ID?-1:b.id===ID?1:0);
 const ids=new Map(rows.filter(row=>row.id!==ID).map(row=>[row.id,"successor-id"]));for(const event of events)ids.set(event.id,"event-id");
 const normal=value=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==="bigint"?Number(v):typeof v==="string"?ids.get(v)??v:ArrayBuffer.isView(v)?Array.from(v):v));
 output.push(normal({...definition,evidence:definition.evidence??evidence,original:project(original),result,rows,events,edges,calls}));
 }finally{await db?._closeHandles("safe-update-fixture");rmSync(scratch,{recursive:true,force:true});}
}return output;}
try{const first=await record();assert.deepEqual(await record(),first);writeFileSync(join(here,"golden/safe-update.json"),JSON.stringify({provenance:{commit:pin,node:process.version,sourceHashes:Object.fromEntries(["lib/safe-update.js","engine/store/memory-db.js"].map(name=>[name,sha(readFileSync(join(source,name)))]))},now:NOW,cases:first},null,2)+"\n");console.log(`Recorded ${first.length} real Node/Lance safe-update scenarios twice`);}finally{globalThis.Date=RealDate;}
