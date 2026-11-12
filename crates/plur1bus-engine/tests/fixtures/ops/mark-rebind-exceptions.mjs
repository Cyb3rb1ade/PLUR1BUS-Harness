// RE-D34 / RX ruling 4: do not transfer forgotten/moved rows or override a conflicting claim.
import assert from 'node:assert/strict';import{createHash}from'node:crypto';import{readFileSync,writeFileSync}from'node:fs';
const bytes=readFileSync(new URL('./golden/rebind.json',import.meta.url));const g=JSON.parse(bytes);const cases={};
for(const name of ['unbind-deleted','unbind-scope-moved','unbind-restored-forgotten']){
const c=g.cases.find(c=>c.name===name);assert.equal(c.unbindResults[0].value.unbound,1);assert.equal(c.rows[0].ownerUserId,g.from);
const rows=structuredClone(c.rows);rows[0].ownerUserId=g.to;
cases[name]={reason:'D130/tombstone-first: changed scope or lifecycle is not an ownership-reversal candidate',rows,unbindResults:[{value:{...c.unbindResults[0].value,unbound:0,skipped:1,skippedModified:1}}]};}
{
const c=g.cases.find(c=>c.name==='rebind-restored-forgotten');assert.equal(c.results[0].value.rebound,1);const files=structuredClone(c.files);const path=Object.keys(files).find(k=>k.endsWith('.jsonl'));files[path]=files[path].split('\n').filter(line=>line&&JSON.parse(line).kind!=='card').join('\n')+'\n';
cases[c.name]={reason:'Committed tombstone excludes restored rows before matching, journaling or owner patch',results:[{value:{...c.results[0].value,matched:0,rebound:0}}],rows:c.initialRows,beforeUnbindRows:c.initialRows,files};}
{
const c=g.cases.find(c=>c.name==='header-claim-disagree');assert.equal(c.results[0].value.rebound,1);assert.equal(c.writes,1);
cases[c.name]={reason:'Conflicting persisted claim and applied header fail closed before acquiring a writable store',results:[{error:'identity-already-bound'}],rows:c.initialRows,beforeUnbindRows:c.initialRows,files:c.initialFiles,writes:0};}
writeFileSync(new URL('./rebind-exceptions.json',import.meta.url),JSON.stringify({nodeGoldenSha256:createHash('sha256').update(bytes).digest('hex'),ruling:'RX ruling 4 / D130 / tombstone-first / RE-D34',cases},null,2)+'\n');
