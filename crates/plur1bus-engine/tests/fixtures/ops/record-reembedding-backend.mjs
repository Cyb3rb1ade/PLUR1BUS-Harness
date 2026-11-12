// Actual C2 metadata hashes and live Lance backend replay observations.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,readdirSync,mkdirSync,mkdtempSync,rmSync,existsSync,cpSync} from "node:fs";
import {tmpdir} from "node:os";import path from "node:path";import {pathToFileURL} from "node:url";
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,"v24.21.0");
const source=JSON.parse(readFileSync(new URL("./reembedding-sources.json",import.meta.url),"utf8"));const paths=[];
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith(".js"))paths.push(p);}}
walk(path.join(root,"engine"));walk(path.join(root,"lib"));const hash=createHash("sha256");for(const p of paths.sort()){hash.update(`${path.relative(root,p)}\0`);hash.update(readFileSync(p));hash.update("\0");}assert.equal(hash.digest("hex"),source.treeSha256);
const {createLanceGenerationBackend,stableNonVectorRowHash}=await import(pathToFileURL(path.join(root,"lib/reembedding/lance-backend.js")));
const {connect}=await import(pathToFileURL(path.join(root,"node_modules/@lancedb/lancedb/dist/index.js")));
const base={id:"11111111-1111-4111-8111-111111111111",text:"synthetic preserved passage",status:"archived",vector:[.125,.25,.5],createdAt:100,validFrom:50,validUntil:80,opaque:{label:"unknown column",flags:[true,false]}};
const hashes=[];function h(name,row){hashes.push({name,row,hash:stableNonVectorRowHash(row)});}
h("base",base);h("vector-and-query-excluded",{...base,vector:[9,8],embeddingFingerprint:"synthetic-derived",_distance:.4,_queryOnly:true});h("metadata-differs",{...base,status:"active"});h("nested-order",{...base,opaque:{flags:[true,false],label:"unknown column"}});h("numeric-keys",{...base,opaque:{"10":"ten","2":"two",a:1}});h("utf16",{...base,text:String.fromCharCode(0xd800),opaque:{"𐀀":1,"\ue000":2}});h("numbers",{...base,createdAt:1e21,validFrom:-0,validUntil:1e-7});h("null",{...base,opaque:null});h("array-order",{...base,opaque:[{b:2,a:1},null,3]});h("nested-underscore-preserved",{...base,opaque:{_internal:"kept"}});
async function backendCase(name,vector,interruptManifest=false,persist=false){const work=mkdtempSync(path.join(tmpdir(),"rx5-backend-"));const active=path.join(work,"active"),state=path.join(work,"state");let db,source,backend;try{
 db=await connect(path.join(active,"agent-a"));const sourceInput=name==="nested-arrow-metadata"?base:{...base,opaque:"opaque column"};source=await db.createTable("memories",[sourceInput]);
 if(persist){const out=new URL(`./reembedding-stores/${name}/`,import.meta.url);rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});cpSync(path.join(active,"agent-a"),out,{recursive:true});}
 backend=createLanceGenerationBackend({stateRoot:state,activeRoot:active,activeGeneration:"active",activeFingerprint:{provider:"openai",model:"synthetic-source",dimensions:3}});
 const inventory=await backend.inventoryActiveGeneration();const version=await source.version();const rows=await backend.readSourceBatch("agent-a/memories",{offset:0,limit:8});
 const manifest=await backend.createQuarantinedGeneration({generation:"target",fingerprintId:"synthetic-fingerprint",dimensions:2,tables:inventory[0].tables});
 const migrated=rows.map(r=>({...r,vector}));let first;try{first=await backend.writeTargetBatch("target","agent-a/memories",migrated);}catch(e){if(name!=="nested-arrow-metadata")throw e;assert.equal(await source.version(),version);return{name,sourceInput,vector,firstError:e.message,rustException:"nested-arrow-metadata"};}
 if(interruptManifest){const file=path.join(state,"generations/target/generation.json");const value=JSON.parse(readFileSync(file,"utf8"));value.tables["agent-a/memories"].writtenRows=0;writeFileSync(file,JSON.stringify(value));}
 let replay;try{replay={value:await backend.writeTargetBatch("target","agent-a/memories",migrated)};}catch(e){replay={error:e.message};}
 const readback=await backend.readBackTargetRows("target","agent-a/memories",rows.map(r=>r.id));const validation=await backend.validateGeneration("target");const after=await backend.describeGeneration("target");
 assert.equal(await source.version(),version);
 return{name,vector,interruptManifest,first,replay,sourceRows:rows,readback,validation,writtenRows:after.tables["agent-a/memories"].writtenRows,metadataPreserved:readback.every((r,i)=>stableNonVectorRowHash(r)===stableNonVectorRowHash(rows[i])),...(name==="float32-replay"?{rustException:"float32-replay"}:{}),...(interruptManifest?{rustException:"manifest-repair"}:{})};
 }finally{await backend?.close();await source?.close();await db?.close();rmSync(work,{recursive:true,force:true});}}
async function run(persist=false){return{hashes,backend:[await backendCase("exact-replay",[.25,.5],false,persist),await backendCase("float32-replay",[.1,.2],false,persist),await backendCase("interrupted-manifest",[.25,.5],true,persist),await backendCase("nested-arrow-metadata",[.25,.5],false,persist)]};}
const recorded=await run(true);assert.deepEqual(await run(),recorded);
writeFileSync(new URL("./golden/reembedding-backend.json",import.meta.url),JSON.stringify({recordedFrom:{engine:"node",source,node:process.version},...recorded},null,2)+"\n");console.log(`Recorded ${recorded.hashes.length} hashes and ${recorded.backend.length} actual Lance backend cases twice`);
