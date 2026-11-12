// RX ruling 4 / D130 / tombstone-first: Rust expectations, never altered Node observations.
import assert from 'node:assert/strict';
import {createHash}from'node:crypto';import{readFileSync,writeFileSync}from'node:fs';
const bytes=readFileSync(new URL('./golden/import.json',import.meta.url));const golden=JSON.parse(bytes);
const cases=[];
for(const[name,reason]of[['foreign-user-existing','principal-unresolved'],['forgotten-live-restored','previously-imported-deleted']]){
 const observed=golden.cases.find(c=>c.name===name);assert.ok(observed);
 assert.equal(observed.results[0].value.cards[0].outcome,'matched-existing');assert.equal(observed.results[0].value.matchedExisting,1);
 assert.equal(JSON.parse(observed.linesJson).length,1);
 cases.push({name,results:[{value:{agentId:'agent',dryRun:false,created:0,matchedExisting:0,rejected:1,cards:[{idempotencyKey:'key',outcome:'rejected',reason}]}}],linesJson:'[]'});
}
writeFileSync(new URL('./import-exceptions.json',import.meta.url),JSON.stringify({ruling:'RX ruling 4 / D130 / RE-D33: do not claim or backfill a foreign or forgotten existing card',nodeGoldenSha256:createHash('sha256').update(bytes).digest('hex'),cases},null,2)+'\n');
