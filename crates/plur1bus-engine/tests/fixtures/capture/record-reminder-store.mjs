// Records actual pinned Node capture rows and chunk plans; never edit its output.
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
// Verify the test helper before importing it, as for every engine source above.
const helper = "tests/helpers/hash-embedder.js";
const helperExpected = sha(git("show", `${pin}:${helper}`));
if (sha(readFileSync(join(source, helper))) !== helperExpected) throw new Error("pinned helper hash mismatch");
hashes.push({ pathParts: [helper], sha256: helperExpected });
const {hashEmbedder}=await load("tests/helpers/hash-embedder.js");

const {MemoryDB}=await load("engine/store/memory-db.js");
const {saveReminder}=await load("lib/reminder-store.js");
const {ensureEpistemicCutoff}=await load("lib/epistemic-cutoff.js");
const {appendTombstoneToRegistry,contentFingerprint}=await load("lib/tombstone.js");
const assert=(await import("node:assert/strict")).default;
const NOW=1710000000000;const RealDate=Date;
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NOW;}};
const text="Bitte Testbericht in 2 Minuten prüfen.";
const logger={info(){},warn(){},error(){},debug(){}};
async function record(){
 const cases=[];
 for(const kind of ["new","duplicate","terminal","foreign-owner","foreign-scope","invalidated","tombstoned","concurrent"]){
  const scratch=mkdtempSync(join(realpathSync(tmpdir()),"reminder-store-"));let db;
  try{
   const base=join(scratch,"stores");mkdirSync(base);ensureEpistemicCutoff(base,NOW);
   db=new MemoryDB(join(base,"alpha"),384,logger);await db.init();
   const calls=[];const embedder=hashEmbedder();
   const options={text,remindAt:NOW+120000,agentId:"alpha",workspaceKey:"/fixture-workspace",embeddings:{async embedQuery(input){calls.push(input);return embedder.embedQuery(input);}}};
   if(kind!=="new"&&kind!=="concurrent"){
    const first=await saveReminder(db,options);
    const values=kind==="terminal"?{reminderStatus:"acknowledged"}:kind==="foreign-owner"?{ownerUserId:"foreign"}:kind==="foreign-scope"?{scope:"user",ownerUserId:"foreign"}:kind==="invalidated"?{epistemicStatus:"invalidated"}:null;
    if(values)await db.table.update({where:`id = '${first.id}'`,values});
    if(kind==="tombstoned")appendTombstoneToRegistry(base,"alpha",{schemaVersion:1,memoryId:first.id,canonicalOriginId:"reminder-fixture",agentId:"alpha",scope:"agent-private",workspaceId:"",ownerUserId:"",status:"committed",contentFingerprint:contentFingerprint(text)});
   }
   if(kind==="concurrent"){
    let count=0,release;const gate=new Promise(resolve=>{release=resolve;});
    const wrapper={table:{query(){let q=db.table.query();return {where(sql){q=q.where(sql);return this;},limit(n){q=q.limit(n);return this;},async toArray(){const rows=await q.toArray();count++;if(count===2)release();await gate;return rows;}};}},store:row=>db.store(row)};
    await Promise.all([saveReminder(wrapper,options),saveReminder(wrapper,options)]);
   }else{await saveReminder(db,options);}
   const schema=await db.table.schema();const rows=(await db.table.query().toArray()).filter(r=>r.id!=="__schema__");
   const project=row=>Object.fromEntries(schema.fields.map(field=>[field.name,field.name==="vector"?Array.from(row.vector):field.name==="id"?"volatile-id":row[field.name]]));
   cases.push({kind,text,remindAt:options.remindAt,calls,rowLines:rows.map(row=>JSON.stringify(project(row)))});
  }finally{await db?._closeHandles("reminder-fixture");rmSync(scratch,{recursive:true,force:true});}
 }
 return cases;
}
globalThis.fetch=async()=>{throw new Error("recorder refuses network");};
try{
 const first=await record();assert.deepEqual(await record(),first);
 writeFileSync(join(here,"golden/reminder-store.json"),JSON.stringify({recordedFrom:{commit:pin,node:process.version,sourcesSha256:Object.fromEntries(["lib/reminder-store.js","engine/store/memory-db.js"].map(name=>[name,sha(readFileSync(join(source,name)))]))},cases:first},null,2)+"\n");
 console.log("Recorded eight actual Node/Lance reminder ownership, tombstone, duplicate and concurrent-write cases twice");
}finally{globalThis.Date=RealDate;}
