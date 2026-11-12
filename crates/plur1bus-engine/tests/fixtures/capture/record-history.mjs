// RE-05/T4 history recordings from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file> [--write-data]
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") throw new Error("pinned source, read-only git and Node 24.21.0 required");
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned history source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/memory-history.js");
const {getMemoryHistory,getMemoryCurrentVersion}=await import(pathToFileURL(path.join(root,"lib/memory-history.js")));
const assert=(await import("node:assert/strict")).default;
const here=path.dirname(fileURLToPath(import.meta.url));
const source=readFileSync(path.join(here,"golden/safe-update.json"));
const base=JSON.parse(source).cases[0].original;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const definitions=[{name:"foreign-ancestor",count:3,start:3,foreign:2},{name:"foreign-successor",count:3,start:1,foreign:2},{name:"three",count:3,start:2},{name:"newest",count:3,start:3},{name:"oldest",count:3,start:1},{name:"missing",count:3,start:9},{name:"missing-ancestor",count:3,start:3,missing:2},{name:"cycle",count:3,start:2,cycle:true},{name:"zero",count:3,start:2,maxDepth:0},{name:"one",count:3,start:2,maxDepth:1},{name:"default-limit",count:55,start:55},{name:"explicit-limit",count:55,start:55,maxDepth:53}];
async function run(){const output=[];for(const def of definitions){
 const rows=Array.from({length:def.count},(_,i)=>({...base,id:id(i+1),agentId:i+1===def.foreign?"foreign":"agent",storedBy:i+1===def.foreign?"foreign":"agent",versionNumber:i+1,text:`Claim version ${i+1}`,previousVersion:i?id(i):def.cycle?id(def.count):"",supersededBy:i+1<def.count?id(i+2):def.cycle?id(1):"",status:i+1<def.count?"superseded":"active",versionCreatedAt:1710000000000+i})).filter(row=>row.id!==id(def.missing??0));
 const calls=[];const db={async getById(key){calls.push(key);return rows.find(row=>row.id===key)??null;}};
 const history=await getMemoryHistory(db,id(def.start),{maxDepth:def.maxDepth});const historyCalls=[...calls];calls.length=0;
 const current=await getMemoryCurrentVersion(db,id(def.start),{maxDepth:def.maxDepth});output.push({...def,startId:id(def.start),rows,history,current,historyCalls,currentCalls:calls});
}return output;}
const first=await run();assert.deepEqual(await run(),first);writeFileSync(path.join(here,"golden/history.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified),rowFixtureSha256:digest(source)},cases:first},null,2)+"\n");console.log(`Recorded ${first.length} actual Node history/forward traversals twice`);
