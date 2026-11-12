// RX4: exercise the real frozen Node copier through createSnapshot, including live mutation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root); assert.equal(process.version, "v24.21.0");
const source = JSON.parse(readFileSync(new URL("./guards-sources.json", import.meta.url), "utf8"));
const sources = [];
function walk(dir) { for (const e of readdirSync(dir, {withFileTypes:true})) {const file = path.join(dir,e.name); if(e.isDirectory()) walk(file); else if(e.name.endsWith(".js")) sources.push(file);} }
walk(path.join(root,"engine")); walk(path.join(root,"lib"));
const hash = createHash("sha256");
for (const file of sources.sort()) {hash.update(`${path.relative(root,file)}\0`); hash.update(readFileSync(file)); hash.update("\0");}
assert.equal(hash.digest("hex"),source.treeSha256);
const {createSnapshot} = await import(pathToFileURL(path.join(root,"lib/snapshot/store-snapshot.js")));
const raw = s => Buffer.from(s).toString("hex");
const ref = name => {const b=Buffer.from(name); assert.ok(b.length < 16384);return Buffer.concat([Buffer.from([0x12]),Buffer.from(b.length < 128 ? [b.length] : [0x80|(b.length&127),b.length>>7]),b]).toString("hex");};
const table = (manifest=ref("x.lance")) => ({"data/x.lance":raw("synthetic column payload"),"_versions/1.manifest":manifest});
const cases = [
 {name:"empty", payloads:{}},
 {name:"plain-utf16-sort",payloads:{"z":raw("plain"),"\ue000":raw("bmp"),"🧠":raw("astral"),"nested/file":raw("nested")}},
 {name:"table-v1",payloads:table()},
 {name:"table-v2",payloads:{"data/x.lance":raw("synthetic"),"_versions/18446744073709551614.manifest":ref("x.lance"),"_versions/18446744073709551613.manifest":ref("x.lance")}},
 {name:"huge-v1-wins",payloads:{...table(),"_versions/999999999999999999999999999999999.manifest":ref("missing.lance")}},
 {name:"invalid-v2-ignored",payloads:{...table(),"_versions/99999999999999999999.manifest":ref("missing.lance"),"_versions/no.manifest":ref("missing.lance")}},
 {name:"zero-version",payloads:{"_versions/0.manifest":raw("empty")}},
 {name:"no-numeric-manifest",payloads:{"_versions/README":raw("ignored"),"data/x.lance":raw("payload")}},
 {name:"missing-data-reference",payloads:table(ref("missing.lance"))},
 {name:"transaction-reference",payloads:{...table(ref("x.lance")+ref("commit.txn")),"_transactions/commit.txn":raw("txn")}},
 {name:"missing-transaction-reference",payloads:table(ref("x.lance")+ref("absent.txn"))},
 {name:"long-reference",payloads:{...table(ref("a".repeat(130)+".lance")),["data/"+"a".repeat(130)+".lance"]:raw("long")}},
 {name:"unsafe-reference-ignored",payloads:table(ref("../outside.lance")+ref("/outside.lance"))},
 {name:"head-moves-once",payloads:table(),mutation:"once"},
 {name:"head-always-moves",payloads:table(),mutation:"always"},
 {name:"manifest-bytes-move-once",payloads:table(),mutation:"bytes"},
 {name:"manifest-payload-vanishes-once",payloads:{...table(),"data/y.lance":raw("temporary")},mutation:"vanish"},
 {name:"nested-tables",payloads:Object.fromEntries(Object.entries(table()).flatMap(([k,v])=>[[`a.lance/${k}`,v],[`b.lance/${k}`,v]]))},
 {name:"derived-cache",payloads:{"ordinary":raw("keep"),"llm-result-cache-v1/results.db":raw("derived"),"llm-result-cache-v1/results.db-wal":raw("wal"),"llm-result-cache-v10/keep":raw("keep similar")},rustException:"cache-excluded"},
];
// Previously recorded synthetic Node/Lance tables: exercise actual protobuf
// manifests in addition to the small controlled mutation fixtures above.
for (const [name, relative] of [["real-node-shared-lance", "shared-store-node"], ["real-node-empty-lance", "adopt-stores/empty"]]) {
 const base = new URL(`./${relative}/`, import.meta.url); const payloads = {};
 function collect(dir, prefix="") {for (const entry of readdirSync(dir,{withFileTypes:true})) {const rel=prefix+entry.name;const file=new URL(entry.name+(entry.isDirectory()?"/":""),dir);if(entry.isDirectory())collect(file,rel+"/");else payloads[rel]=readFileSync(file).toString("hex");}}
 collect(base); cases.push({name,payloads});
}
async function record() {
 const results=[];
 for(const c of cases) {
  const work=mkdtempSync(path.join(tmpdir(),"rx4-snapshot-copy-"));const base=path.join(work,"source"),state=path.join(work,"state");mkdirSync(base);mkdirSync(state);
  for(const [p,hex] of Object.entries(c.payloads)) {const f=path.join(base,p);mkdirSync(path.dirname(f),{recursive:true});writeFileSync(f,Buffer.from(hex,"hex"));}
  let copies=0, mutations=0;
  const intercepted={...fs,async copyFile(s,d,...args){await fs.copyFile(s,d,...args);copies++;
   if(path.relative(base,s).replaceAll(path.sep,"/")!=="data/x.lance") return;
   if(c.mutation==="always" || (c.mutation==="once" && mutations===0)) {mutations++;await fs.writeFile(path.join(base,`_versions/${mutations+1}.manifest`),Buffer.from(ref("x.lance"),"hex"));}
   if(c.mutation==="bytes" && mutations===0){mutations++;await fs.writeFile(path.join(base,"_versions/1.manifest"),Buffer.concat([Buffer.from(ref("x.lance"),"hex"),Buffer.from([0])]));}
   if(c.mutation==="vanish" && mutations===0){mutations++;await fs.unlink(path.join(base,"data/y.lance"));}
  }};
  try {
   let result;
   try {const made=await createSnapshot({stateDir:state,baseDbPath:base,now:()=>1794096000000,fsImpl:intercepted});const manifest=JSON.parse(await fs.readFile(path.join(made.dir,"snapshot.json"),"utf8"));const payloads={};for(const f of manifest.files) payloads[f.path]=(await fs.readFile(path.join(made.dir,f.path))).toString("hex");result={files:manifest.files,bytes:made.bytes,payloads};}
   catch(e){assert.equal(typeof e.reason,"string");result={error:e.reason};}
   results.push({...c,copies,mutations,result});
  } finally {rmSync(work,{recursive:true,force:true});}
 }
 return results;
}
const recorded=await record();assert.deepEqual(await record(),recorded);
writeFileSync(new URL("./golden/snapshot-copy.json",import.meta.url),JSON.stringify({recordedFrom:{engine:"node",source,node:process.version},cases:recorded},null,2)+"\n");
console.log(`Recorded ${recorded.length} actual Node copier cases twice; cache exception retains original result`);
