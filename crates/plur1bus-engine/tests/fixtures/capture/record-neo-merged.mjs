// RE-05/T4 neo-merged recordings from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file> [--write-data]
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "b097045b6f115275baa8b15016321c3ba080c812";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") throw new Error("pinned source, read-only git and Node 24.21.0 required");
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned neo-merged source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/neo-arch.js");
const {createNeoStore}=await import(pathToFileURL(path.join(root,"lib/neo-arch.js")));
const {mkdtempSync,mkdirSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");
const assert=(await import("node:assert/strict")).default;
const requester={requesterAgentId:"alpha",agentId:"alpha",workspaceIdentity:"workspace:v1:one",requesterWorkspaceKey:"workspace:v1:one"};
const row=(id,n,agent="alpha",extra={})=>({id,agentId:agent,origin:{scope:"agent_private"},visibility:{scope:"agent_private",agentId:agent},createdAt:1700000000000+n,statement:`synthetic ${id}`,...extra});
const defs=[
 {name:"canonical",canonical:[row("a",1),row("b",2)],limit:1},
 {name:"merged",canonical:[row("a",1),row("b",3)],legacy:[row("c",2)],limit:2},
 {name:"legacy-newer",canonical:[row("a",1)],legacy:[row("a",1,"alpha",{updatedAt:1700000000010,statement:"new legacy"})],limit:2},
 {name:"canonical-tie",canonical:[row("a",1,"alpha",{statement:"canonical"})],legacy:[row("a",1,"alpha",{statement:"legacy"})],limit:2},
 {name:"canonical-revisions",canonical:[row("a",1),row("a",1,"alpha",{updatedAt:1700000000003,statement:"new canonical"})],limit:3},
 {name:"canonical-revoked",canonical:[row("a",1),row("a",1,"foreign",{updatedAt:1700000000003})],limit:3},
 {name:"legacy-revoked",canonical:[row("a",1)],legacy:[row("a",1,"foreign",{updatedAt:1700000000003})],limit:3},
 {name:"fresh-old-record",canonical:[row("a",1,"alpha",{updatedAt:1700000000100}),row("b",2),row("c",3)],limit:1},
 {name:"stable-times",canonical:[row("a",1),row("b",1)],legacy:[row("c",1)],limit:3},
 {name:"undated",canonical:[row("a",1,"alpha",{createdAt:null}),row("b",2,"alpha",{createdAt:"invalid"}),row("c",3)],limit:3},
 {name:"iso-times",canonical:[row("a",1,"alpha",{createdAt:"2026-01-02T00:00:00Z"}),row("b",2,"alpha",{createdAt:"2026-01-01",updatedAt:"2026-01-03T01:00:00+01:00"})],limit:1},
 {name:"start-time",canonical:[row("a",1,"alpha",{startTime:1700000000005}),row("b",3)],limit:2},
 {name:"malformed",raw:["", "{broken", "null", "false", "  ",JSON.stringify(row("a",1))],limit:2},
 {name:"anonymous",canonical:[row("",1),{...row("b",2),id:undefined}],limit:2},
 {name:"zero",canonical:[row("a",1)],limit:0},
 {name:"acl-tail-growth",canonical:[row("a",1),row("b",2),...Array.from({length:140},(_,i)=>row(`foreign-${i}`,i+3,"foreign"))],limit:2},
 {name:"canonical-revisions-starve",canonical:[row("older",1),...Array.from({length:25},(_,i)=>row("repeat",i+2))],limit:2},
 {name:"unsafe-legacy",key:"tenant/a",legacy:[row("legacy",1)],canonical:[row("canonical",2)],limit:2},
 {name:"dot-legacy",key:".",legacy:[row("legacy",1)],limit:2},
 {name:"dotdot-legacy",key:"..",legacy:[row("legacy",1)],limit:2},
];
async function run(){const cases=[];const methods={patterns:"readPatterns",graph:"readGraphEdges",dreams:"readDreams",episodes:"readEpisodes",candidates:"readCandidates"};
 for(const def of defs){const scratch=mkdtempSync(path.join(tmpdir(),"neo-merged-"));try{
 const store=createNeoStore(scratch,def.key??"workspace",{readOnly:true});const canonical=def.raw??(def.canonical??[]).map(row=>JSON.stringify(row));const legacy=(def.legacy??[]).map(row=>JSON.stringify(row));
 for(const name of Object.keys(methods)){mkdirSync(path.dirname(store.paths[name]),{recursive:true});writeFileSync(store.paths[name],canonical.join("\n")+"\n");if(legacy.length){mkdirSync(path.dirname(store.legacyPaths[name]),{recursive:true});writeFileSync(store.legacyPaths[name],legacy.join("\n")+"\n");}}
 const outputs=Object.fromEntries(Object.entries(methods).map(([name,method])=>[name,store[method](def.limit,requester)]));
 cases.push({name:def.name,key:def.key??"workspace",limit:def.limit,canonicalLines:canonical,legacyLines:legacy,outputs});
 }finally{rmSync(scratch,{recursive:true,force:true});}}
 const layouts=["workspace","tenant/a","tenant_a",".","..","","   ","Ä🙂 Team","a_Ä_b","a🙂🙂b","__inner__","x".repeat(130)].map(key=>{const store=createNeoStore("/synthetic-root",key,{readOnly:true});return {key,canonical:path.basename(store.paths.workspaceDir),legacy:path.basename(path.dirname(store.legacyPaths.patterns))};});
 return {cases,layouts};}
const first=await run();assert.deepEqual(await run(),first);const here=path.dirname(fileURLToPath(import.meta.url));writeFileSync(path.join(here,"golden/neo-merged.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},requester,...first},null,2)+"\n");console.log(`Recorded ${first.cases.length} real Node JSONL scenarios across five readers and ${first.layouts.length} layouts twice`);
