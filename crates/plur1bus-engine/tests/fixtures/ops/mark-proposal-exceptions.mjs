// D130/RX ruling 4: a corrupt proposal has no provable caller ACL; do not reveal its existence.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const bytes=readFileSync(new URL('./golden/proposals.json',import.meta.url));
const golden=JSON.parse(bytes);const name='corrupt-unrelated-counter';const found=golden.cases.find(c=>c.name===name);
for(const list of Object.values(found.lists))assert.equal(list.unreadable,1);
writeFileSync(new URL('./golden/proposal-exceptions.json',import.meta.url),JSON.stringify({goldenSha256:createHash('sha256').update(bytes).digest('hex'),case:name,ruling:'D130/RX ruling 4: only provably authorized records may affect visible counters',rustUnreadable:0},null,2)+'\n');
