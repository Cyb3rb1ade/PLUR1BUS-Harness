import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root); assert.equal(process.version, 'v24.21.0');
const source = JSON.parse(readFileSync(new URL('./write-sources.json', import.meta.url), 'utf8'));
const files = [];
function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.js')) files.push(file); } }
walk(path.join(root, 'engine')); walk(path.join(root, 'lib'));
const hash = createHash('sha256');
for (const file of files.sort()) { hash.update(`${path.relative(root, file)}\0`); hash.update(readFileSync(file)); hash.update('\0'); }
assert.equal(hash.digest('hex'), source.treeSha256);
const load = file => import(pathToFileURL(path.join(root, file)));
const { isBoundGraphEdge, filterGraphEdgesForRequest } = await load('lib/memory-graph.js');
const { harnessUserPrincipal } = await load('lib/memory-request-context.js');
const context = { agentId:'agent', workspaceIdentity:'workspace:v1:fixture', userPrincipal:harnessUserPrincipal('fixture'), workspaceAliases:{paths:[],aliases:[]} };
const tuple = { schemaVersion:1, scope:'agent-private', agentId:context.agentId, workspaceIdentity:context.workspaceIdentity, ownerUserId:context.userPrincipal };
const edge = { source:'first', target:'second', strength:0.8, type:'related', directed:false, ownershipStatus:'bound', sourceOwnership:tuple, targetOwnership:tuple, ownership:{source:tuple,target:tuple} };
function record() {
 return ['valid','foreign','nested-mismatch','unbound','needs-rebuild','partial'].map(name => {
  const input = JSON.parse(JSON.stringify(edge));
  if(name==='foreign') { input.sourceOwnership.ownerUserId=harnessUserPrincipal('foreign-tuple'); input.ownership.source.ownerUserId=input.sourceOwnership.ownerUserId; }
  if(name==='nested-mismatch') input.ownership.source.agentId='other-agent';
  if(name==='unbound') input.ownershipStatus='unbound';
  if(name==='needs-rebuild') input.needsRebuild=true;
  if(name==='partial') delete input.targetOwnership;
  return { name, input, bound:isBoundGraphEdge(input), filtered:filterGraphEdgesForRequest([input],context) };
 });
}
const cases=record();assert.deepEqual(record(),cases);
writeFileSync(new URL('./golden/graph-ownership.json',import.meta.url),JSON.stringify({recordedFrom:{source,node:process.version},context,cases},null,2)+'\n');
console.log('Recorded actual Node bound-edge and request-filter checks twice');
