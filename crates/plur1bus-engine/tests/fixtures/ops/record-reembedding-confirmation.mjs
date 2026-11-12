// Actual C2 confirmation protocol. Fixtures store only proof digests/non-secret
// persisted metadata, never literal operator proofs; seeds are synthetic test inputs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,"v24.21.0");
const source=JSON.parse(readFileSync(new URL("./reembedding-sources.json",import.meta.url),"utf8"));const paths=[];
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith(".js"))paths.push(p);}}
walk(path.join(root,"engine"));walk(path.join(root,"lib"));const tree=createHash("sha256");for(const p of paths.sort()){tree.update(`${path.relative(root,p)}\0`);tree.update(readFileSync(p));tree.update("\0");}assert.equal(tree.digest("hex"),source.treeSha256);
const {createMigrationConfirmation,verifyMigrationConfirmationBinding,verifyMigrationConfirmation}=await import(pathToFileURL(path.join(root,"lib/reembedding/confirmation.js")));
const sha=s=>createHash("sha256").update(s).digest("hex");
const creation=[0,1,9,127,128,255].map(seed=>({name:`seed-${seed}`,seed,digest:`sha256:${"a".repeat(64)}`,expiry:1000}));
creation.push(...[
 {name:"maximum-expiry",expiry:Number.MAX_SAFE_INTEGER}, {name:"zero-expiry",expiry:0},
 {name:"unsafe-expiry",expiry:Number.MAX_SAFE_INTEGER+1}, {name:"invalid-digest",digest:"not-a-digest"},
 {name:"uppercase-digest",digest:`sha256:${"A".repeat(64)}`}, {name:"short-digest",digest:`sha256:${"a".repeat(63)}`},
].map(c=>({seed:13,digest:`sha256:${"b".repeat(64)}`,expiry:1000,...c})));
const checks=[
 {name:"valid",clock:0},{name:"last-valid-millisecond",clock:999},{name:"expired",clock:1000},
 {name:"after-expiry",clock:1001},{name:"negative-clock",clock:-1},{name:"fractional-clock",clock:0.5},
 {name:"unsafe-clock",clock:Number.MAX_SAFE_INTEGER+1},{name:"nan-clock",clock:"NaN"},{name:"infinite-clock",clock:"Infinity"},
 ...["extra","missing-hash","schema","schema-string","expiry-zero","expiry-negative","expiry-fraction","expiry-string","expiry-unsafe","digest-other","digest-upper","digest-invalid","hash-other","hash-upper","hash-empty","null","array"].map(change=>({name:`metadata-${change}`,change,clock:1})),
 ...["different-seed","prefix","short","long","invalid-char"].map(proof=>({name:`proof-${proof}`,proof,clock:1})),
];
function record(){
 const made=creation.map(c=>{try{const result=createMigrationConfirmation({planDigest:c.digest,expiresAt:c.expiry,randomBytes:()=>Buffer.alloc(32,c.seed)});return {...c,result:{proofSha256:sha(result.token),persisted:result.persisted}};}catch(e){return {...c,error:e.message};}});
 const verified=checks.map(c=>{
  const original=createMigrationConfirmation({planDigest:`sha256:${"a".repeat(64)}`,expiresAt:1000,randomBytes:()=>Buffer.alloc(32,9)});
  let persisted=structuredClone(original.persisted);let proof=original.token;
  switch(c.change){case"extra":persisted.extra=true;break;case"missing-hash":delete persisted.tokenHash;break;case"schema":persisted.schemaVersion=2;break;case"schema-string":persisted.schemaVersion="1";break;case"expiry-zero":persisted.expiresAt=0;break;case"expiry-negative":persisted.expiresAt=-1;break;case"expiry-fraction":persisted.expiresAt=1.5;break;case"expiry-string":persisted.expiresAt="1000";break;case"expiry-unsafe":persisted.expiresAt=Number.MAX_SAFE_INTEGER+1;break;case"digest-other":persisted.planDigest=`sha256:${"b".repeat(64)}`;break;case"digest-upper":persisted.planDigest=persisted.planDigest.toUpperCase();break;case"digest-invalid":persisted.planDigest="invalid";break;case"hash-other":persisted.tokenHash="b".repeat(64);break;case"hash-upper":persisted.tokenHash=persisted.tokenHash.toUpperCase();break;case"hash-empty":persisted.tokenHash="";break;case"null":persisted=null;break;case"array":persisted=[];break;}
  switch(c.proof){case"different-seed":proof=createMigrationConfirmation({planDigest:original.persisted.planDigest,expiresAt:1000,randomBytes:()=>Buffer.alloc(32,8)}).token;break;case"prefix":proof="invalid"+proof.slice(8);break;case"short":proof=proof.slice(0,-1);break;case"long":proof+="a";break;case"invalid-char":proof=proof.slice(0,-1)+"!";break;}
  return {...c,persisted,binding:verifyMigrationConfirmationBinding(proof,persisted),valid:verifyMigrationConfirmation(proof,persisted,Number(c.clock))};
 });return {creation:made,verification:verified};
}
const result=record();assert.deepEqual(record(),result);
writeFileSync(new URL("./golden/reembedding-confirmation.json",import.meta.url),JSON.stringify({recordedFrom:{engine:"node",source,node:process.version},...result},null,2)+"\n");
console.log(`Recorded ${result.creation.length} creation and ${result.verification.length} binding/expiry cases twice without storing operator proofs`);
