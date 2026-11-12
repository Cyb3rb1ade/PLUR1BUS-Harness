// RE-05/T4 neo-vectors recordings from verified pinned Node sources.
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
  if (!source.equals(expected)) throw new Error(`pinned neo-vectors source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/neo-arch.js");
const {createNeoStore}=await import(pathToFileURL(path.join(root,"lib/neo-arch.js")));
const {mkdtempSync,mkdirSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const assert=(await import("node:assert/strict")).default;
const requester={requesterAgentId:"alpha",agentId:"alpha",workspaceIdentity:"workspace:v1:one",requesterWorkspaceKey:"workspace:v1:one"};
const row=(id,extra={})=>({id,agentId:"alpha",origin:{scope:"agent_private"},visibility:{scope:"agent_private",agentId:extra.agentId??"alpha"},createdAt:1700000000000,...extra});
const index=(id="a",extra={})=>({version:1,endian:"LE",file:"vectors.7.f32",entries:{[id]:{offset:0,length:12,dims:3}},...extra});
const bytes=(values)=>{const b=Buffer.alloc(values.length*4);values.forEach((n,i)=>b.writeFloatLE(n,i*4));return [...b];};
const defs=[
 {name:"batch-offset-order",canonical:[row("a"),row("b"),row("c")],index:index("b",{entries:{b:{offset:0,length:12,dims:3},a:{offset:12,length:12,dims:3},c:{offset:24,length:12,dims:3}}}),vector:[9,8,7,0.1,0.2,0.3,-1,0,1]},
 {name:"false-id",canonical:[row(0)],index:index("0"),vector:[1,2,3]},
 {name:"canonical",canonical:[row("a")],index:index(),vector:[0.1,-0.5,3]},
 {name:"inline",canonical:[row("a",{embedding:[0.1,0.2,0.3]})],index:index(),vector:[9,9,9]},
 {name:"inline-null",canonical:[row("a",{embedding:null})],index:index(),vector:[9,9,9]},
 {name:"no-index",canonical:[row("a")]},
 {name:"no-entry",canonical:[row("a")],index:index("other"),vector:[1,2,3]},
 {name:"foreign",canonical:[row("a",{agentId:"foreign"})],index:index(),vector:[1,2,3]},
 {name:"legacy-origin",legacy:[row("a")],index:index(),vector:[9,9,9],legacyIndex:index(),legacyVector:[1,2,3]},
 {name:"canonical-tie",canonical:[row("a")],legacy:[row("a")],index:index(),vector:[2,3,4],legacyIndex:index(),legacyVector:[1,2,3]},
 {name:"legacy-newest",canonical:[row("a")],legacy:[row("a",{updatedAt:1700000000001})],index:index(),vector:[2,3,4],legacyIndex:index(),legacyVector:[1,2,3]},
 {name:"missing-file",canonical:[row("a")],index:index()},
 {name:"truncated",canonical:[row("a")],index:index(),vector:[1]},
 {name:"non-finite",canonical:[row("a")],index:index(),vector:[NaN,Infinity,1]},
 {name:"invalid-index",canonical:[row("a")],index:{...index(),entries:{a:{offset:-1,length:12,dims:3}}},vector:[1,2,3]},
];
async function run(){const cases=[];for(const def of defs){const scratch=mkdtempSync(path.join(tmpdir(),"neo-vectors-"));try{
 const store=createNeoStore(scratch,"workspace",{readOnly:true});const files=[];
 for(const [source,rows,manifest,vector] of [["canonical",def.canonical,def.index,def.vector],["legacy",def.legacy,def.legacyIndex,def.legacyVector]]){
  const dir=source==="canonical"?store.paths.workspaceDir:path.dirname(store.legacyPaths.candidates);mkdirSync(dir,{recursive:true});
  if(rows){const text=rows.map(r=>JSON.stringify(r)).join("\n")+"\n";writeFileSync(path.join(dir,"memory-candidates.jsonl"),text);files.push({source,name:"memory-candidates.jsonl",text});}
  if(manifest){const text=JSON.stringify(manifest);writeFileSync(path.join(dir,"vector-index.json"),text);files.push({source,name:"vector-index.json",text});}
  if(vector){const raw=bytes(vector);writeFileSync(path.join(dir,"vectors.7.f32"),Buffer.from(raw));files.push({source,name:"vectors.7.f32",bytes:raw});}
 }
 const output=store.readCandidates(10,requester).map(r=>({metadata:JSON.parse(JSON.stringify(r)),embedding:r.embedding??null}));
 cases.push({name:def.name,files,output});
 }finally{rmSync(scratch,{recursive:true,force:true});}}return cases;}
const cases=await run();assert.deepEqual(await run(),cases);const here=path.dirname(fileURLToPath(import.meta.url));writeFileSync(path.join(here,"golden/neo-vectors.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},cases},null,2)+"\n");console.log(`Recorded ${cases.length} real Node metadata/sidecar scenarios twice`);
