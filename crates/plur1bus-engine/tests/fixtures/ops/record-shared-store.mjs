// RX3: actual shared Lance schema, provenance and idempotent copy persistence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root); assert.equal(process.version, "v24.21.0");
const source = JSON.parse(readFileSync(new URL("./write-sources.json", import.meta.url), "utf8"));
const files = [];
function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith(".js")) files.push(file); } }
walk(path.join(root, "engine")); walk(path.join(root, "lib"));
const hash = createHash("sha256");
for (const file of files.sort()) { hash.update(`${path.relative(root, file)}\0`); hash.update(readFileSync(file)); hash.update("\0"); }
assert.equal(hash.digest("hex"), source.treeSha256);
const load = file => import(pathToFileURL(path.join(root, file)));
const { MemoryDB } = await load("engine/store/memory-db.js");
const { storeSharedMemory } = await load("lib/shared-memory.js");
const now=1_800_000_000_000;
const NativeDate=Date;
globalThis.Date=class extends NativeDate { constructor(...args){super(...(args.length?args:[now]));}static now(){return now;} };
const input={id:"00000000-0000-4000-8000-000000000001",text:"Synthetic original shared evidence",summary:"Synthetic shared summary",vector:[1,0,0,0],createdAt:now-1000,agentId:"agent",storedBy:"agent",scope:"agent-private",status:"active",epistemicStatus:"observed",origin:"note",category:"fact",importance:0.5};
const context={workspaceIdentity:"workspace:v1:fixture",userPrincipal:"user:v1:"+createHash("sha256").update('fixture-user').digest('hex')};
async function record(keep=false){
 const work=mkdtempSync(path.join(tmpdir(),"rx3-shared-store-"));
 const base=keep?new URL('./shared-store-node/',import.meta.url).pathname:path.join(work,'shared');
 if(keep)rmSync(base,{recursive:true,force:true});
 const privateDb=new MemoryDB(path.join(work,'private'),4);
 const shared=new MemoryDB(base,4);
 try{
  await privateDb.init();await privateDb.store(input);
  const original=JSON.parse(JSON.stringify((await privateDb.table.query().toArray())[0]));
  await shared.init();
  const result=await storeSharedMemory(shared,original,context,{targetScope:'workspace',vector:input.vector,sourceAgentId:'agent'});
  const repeated=await storeSharedMemory(shared,original,context,{targetScope:'workspace',vector:input.vector,sourceAgentId:'agent'});
  assert.equal(result.id,repeated.id);
  const schema=(await shared.table.schema()).fields.map(field=>({name:field.name,type:field.type.toString(),nullable:field.nullable}));
  const rows=JSON.parse(JSON.stringify(await shared.table.query().toArray()));
  assert.equal(rows.length,1);
  const row={...rows[0],id:'<shared-id>'};
  return {original,schema,row,result:{...result,id:'<shared-id>'},repeated:{...repeated,id:'<shared-id>'}};
 }finally{await privateDb.shutdown();await shared.shutdown();rmSync(work,{recursive:true,force:true});}
}
const expected=await record();assert.deepEqual(await record(true),expected);
writeFileSync(new URL('./golden/shared-store.json',import.meta.url),JSON.stringify({recordedFrom:{source,node:process.version},now,context,expected},null,2)+'\n');
console.log('Recorded shared store columns, idempotency and copy twice; retained one actual Node Lance fixture');
