// Exercise the actual frozen C2 read-only planner with deterministic synthetic boundary providers.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,readdirSync,mkdirSync,mkdtempSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";import path from "node:path";import {pathToFileURL} from "node:url";
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,"v24.21.0");
const source=JSON.parse(readFileSync(new URL("./reembedding-sources.json",import.meta.url),"utf8"));const paths=[];
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith(".js"))paths.push(p);}}
walk(path.join(root,"engine"));walk(path.join(root,"lib"));const hash=createHash("sha256");for(const p of paths.sort()){hash.update(`${path.relative(root,p)}\0`);hash.update(readFileSync(p));hash.update("\0");}assert.equal(hash.digest("hex"),source.treeSha256);
const {createReembeddingPlan}=await import(pathToFileURL(path.join(root,"lib/reembedding/planner.js")));
const {normalizeEmbeddingFingerprint}=await import(pathToFileURL(path.join(root,"lib/reembedding/fingerprint.js")));
const fp=(model="source",dimensions=4,provider="openai")=>normalizeEmbeddingFingerprint({provider,model,dimensions,revision:"synthetic-immutable-r1"},[]);
const inventory=()=>[{generation:"active",selection:{mode:"legacy"},configRevision:"config-synthetic-a",fingerprint:fp(),tables:[{tableId:"agent-a/memories",version:"7",rowCount:3,estimatedBytes:100},{tableId:"agent-b/memories",version:"9",rowCount:2,estimatedBytes:50}]}];
const request=()=>({id:"migration-a",target:{fingerprint:fp("target",8)},confirmationTtlMs:60000});
const cases=[];function add(name,change=()=>{}){const c={name,request:request(),inventory:inventory(),now:1000,freeBytes:1000000,artifacts:{ready:false,verified:false},probe:"valid"};change(c);cases.push(c);}
add("remote");add("empty-tables",c=>c.inventory[0].tables=[]);
add("generation-source",c=>delete c.inventory[0].selection);
add("explicit-target",c=>c.request.targetGeneration="target-generation");
add("source-and-target-secret-ref",c=>{c.inventory[0].secretRef={source:"env",provider:"local",id:"SOURCE_CONFIG"};c.request.target.secretRef={source:"store",provider:"local",id:"TARGET_CONFIG"};});
add("raw-fingerprint-order",c=>c.request.target.fingerprint=Object.fromEntries(Object.entries(c.request.target.fingerprint).reverse()));
add("local-deferred",c=>c.request.target.fingerprint=fp("target-local",8,"local-transformers"));
add("local-ready-unverified",c=>{c.request.target.fingerprint=fp("target-local",8,"local-transformers");c.artifacts.ready=true;});
add("local-verified",c=>{c.request.target.fingerprint=fp("target-local",8,"local-transformers");c.artifacts={ready:true,verified:true};});
add("default-ttl",c=>delete c.request.confirmationTtlMs);
for(const n of [1,53,54,64,65,128])add(`id-length-${n}`,c=>c.request.id="m".repeat(n));
for(const n of [64,65])add(`generation-length-${n}`,c=>c.request.targetGeneration="g".repeat(n));
for(const ttl of [0,999,1000,3600000,3600001,1.5])add(`ttl-${ttl}`,c=>c.request.confirmationTtlMs=ttl);
add("no-active",c=>c.inventory=[]);add("two-active",c=>c.inventory.push({...c.inventory[0],generation:"other"}));
add("target-is-source",c=>c.request.targetGeneration="active");add("no-change",c=>c.request.target.fingerprint=fp());
add("low-disk",c=>c.freeBytes=1);add("disk-exact",c=>c.freeBytes=388);add("disk-one-short",c=>c.freeBytes=387);
add("invalid-probe-width",c=>c.probe="short");add("invalid-probe-finite",c=>c.probe="nan");add("probe-failure",c=>c.probe="throw");
add("duplicate-table",c=>c.inventory[0].tables.push(c.inventory[0].tables[0]));add("table-dimension",c=>c.inventory[0].tables[0].dimensions=9);
add("table-traversal",c=>c.inventory[0].tables[0].tableId="../memories");add("missing-table-version",c=>delete c.inventory[0].tables[0].version);
add("negative-rows",c=>c.inventory[0].tables[0].rowCount=-1);add("fractional-bytes",c=>c.inventory[0].tables[0].estimatedBytes=1.5);
add("invalid-selection",c=>c.inventory[0].selection={mode:"legacy",extra:true});add("invalid-secret-ref",c=>c.request.target.secretRef={source:"env",provider:"INVALID",id:"SYNTHETIC_CONFIG"});
add("negative-clock",c=>c.now=-1);add("fractional-clock",c=>c.now=1.5);
add("raw-target-credential",c=>{c.request.target.fingerprint={...c.request.target.fingerprint,apiKey:"synthetic-private-value"};c.rustException="secret-bearing-plan";});
add("raw-source-credential",c=>{c.inventory[0].fingerprint={...c.inventory[0].fingerprint,apiKey:"synthetic-private-value"};c.rustException="secret-bearing-plan";});
async function run(){const out=[];for(const c of cases){const calls=[];try{const result=await createReembeddingPlan(c.request,{
 now:()=>c.now,randomBytes:()=>Buffer.alloc(32,9),
 inventoryActiveGeneration:async()=>{calls.push("inventory");return c.inventory;},
 statDisk:async()=>{calls.push("disk");return{freeBytes:c.freeBytes};},
 inspectTargetArtifacts:async()=>{calls.push("artifacts");return c.artifacts;},
 probeTargetProvider:async()=>{calls.push("probe");if(c.probe==="throw")throw Error("synthetic probe failure");if(c.probe==="short")return[];const v=Array(c.request.target.fingerprint.dimensions).fill(.25);if(c.probe==="nan")v[0]=NaN;return v;}
 });out.push({...c,calls,result:{plan:result.plan,planDigest:result.planDigest,persisted:result.confirmation.persisted,proofSha256:createHash("sha256").update(result.confirmation.token).digest("hex")}});}catch(e){out.push({...c,calls,error:e.message});}}return out;}
const recorded=await run();assert.deepEqual(await run(),recorded);assert.ok(recorded.some(c=>c.result));
writeFileSync(new URL("./golden/reembedding-plan.json",import.meta.url),JSON.stringify({recordedFrom:{engine:"node",source,node:process.version},cases:recorded},null,2)+"\n");
console.log(`Recorded ${recorded.length} actual Node planner cases twice`);
