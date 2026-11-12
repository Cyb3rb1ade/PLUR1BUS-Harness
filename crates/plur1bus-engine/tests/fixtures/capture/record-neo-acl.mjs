// RE-05/T4 neo-acl recordings from verified pinned Node sources.
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
  if (!source.equals(expected)) throw new Error(`pinned neo-acl source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/neo-arch.js");
const api=await import(pathToFileURL(path.join(root,"lib/neo-arch.js")));
const assert=(await import("node:assert/strict")).default;
const user=label=>"user:v1:"+digest(label);
const ownerA=user("fixture-owner-a"),ownerB=user("fixture-owner-b");
const requesters=[{}, {agentId:"alpha",workspaceIdentity:"workspace:v1:one",ownerUserId:ownerA}, {agentId:"beta",workspaceIdentity:"workspace:v1:one",ownerUserId:ownerA}, {agentId:"alpha",workspaceIdentity:"workspace:v1:two",ownerUserId:ownerB}, {agentId:"beta",workspaceIdentity:"workspace:v1:two",ownerUserId:ownerA}];
const records=[
 {name:"no-bindings",record:{}},
 {name:"legacy-agent",record:{agentId:"alpha"}},
 {name:"private",record:{agentId:"alpha",visibility:{scope:"agent_private",agentId:"alpha"}}},
 {name:"private-conflict",record:{agentId:"beta",visibility:{scope:"agent_private",agentId:"alpha"}}},
 {name:"workspace",record:{workspaceKey:"workspace:v1:one",visibility:{scope:"workspace_shared",workspaceIdentity:"workspace:v1:one"}}},
 {name:"workspace-conflict",record:{workspaceKey:"workspace:v1:two",visibility:{scope:"workspace_shared",workspaceIdentity:"workspace:v1:one"}}},
 {name:"user-canonical-stamp",record:{visibility:{scope:"global_user",ownerUserId:ownerA}}},
 {name:"user-canonical-root",record:{ownerUserId:ownerA,visibility:{scope:"global_user"}}},
 {name:"user-legacy-only",record:{ownerId:ownerA,visibility:{scope:"global_user"}}},
 {name:"user-legacy-same",record:{ownerId:ownerA,ownerUserId:ownerA,visibility:{scope:"global_user",ownerUserId:ownerA}}},
 {name:"user-legacy-conflict",record:{ownerId:ownerB,ownerUserId:ownerA,visibility:{scope:"global_user",ownerUserId:ownerA}}},
 {name:"user-canonical-conflict",record:{ownerUserId:ownerB,visibility:{scope:"global_user",ownerUserId:ownerA}}},
 {name:"scope-conflict",record:{agentId:"alpha",workspaceKey:"workspace:v1:one",origin:{scope:"agent_private"},visibility:{scope:"workspace_shared",agentId:"alpha",workspaceIdentity:"workspace:v1:one"}}},
 {name:"unknown-scope",record:{agentId:"alpha",visibility:{scope:"invented",agentId:"alpha"}}},
 {name:"private-missing-agent",record:{visibility:{scope:"agent_private"}}},
 {name:"user-missing-owner",record:{visibility:{scope:"global_user"}}},
 {name:"origin-private",record:{agentId:"alpha",origin:{scope:"agent_private"}}},
];
const stamps=[{record:{id:"derived-a"},binding:{agentId:"alpha"}}, {record:{id:"derived-a"},binding:{agentId:"alpha",workspaceIdentity:"workspace:v1:one"}}, {record:{id:"derived-a"},binding:{agentId:"alpha",workspaceIdentity:"workspace:v1:one",ownerUserId:ownerA,scope:"user"}}, {record:{id:"derived-a",visibility:{scope:"global_user",ownerId:ownerB}},binding:{agentId:"alpha",scope:"agent-private"}}, {record:{id:"derived-a"},binding:{}}];
function run(){return {reads:records.flatMap(({name,record})=>requesters.map((requester,index)=>({name,index,record,requester,neo:api.isNeoRecordAccessible(record,{requesterAgentId:requester.agentId,requesterWorkspaceKey:requester.workspaceIdentity,requesterOwnerId:requester.ownerUserId}),derived:api.isDerivedRecordAccessible(record,requester)}))),stamps:stamps.map(input=>({...input,result:api.stampDerivedVisibility(input.record,input.binding)}))};}
const first=run();assert.deepEqual(run(),first);
const here=path.dirname(fileURLToPath(import.meta.url));writeFileSync(path.join(here,"golden/neo-acl.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},ownerA,ownerB,...first},null,2)+"\n");console.log(`Recorded ${first.reads.length} actual Neo ACL and ${first.stamps.length} visibility-stamp observations twice`);
