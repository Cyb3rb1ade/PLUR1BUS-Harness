import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pinnedBrowser,installArguments} from '../ui-browser.mjs';
test('browser installer and revision come from the exact desktop UI dependency',()=>{
 const plan=pinnedBrowser();assert.equal(plan.version,'1.63.0');assert.match(plan.revision,/^[0-9]+$/);assert.match(plan.browserVersion,/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/);
 assert.deepEqual(installArguments(plan.cli,false),[plan.cli,'install','chromium','--only-shell']);assert.deepEqual(installArguments(plan.cli,true),[plan.cli,'install','--with-deps','chromium','--only-shell']);
});
test('a mismatched package never selects a cached browser or arbitrary system executable',()=>{
 assert.throws(()=>pinnedBrowser({resolve:()=>new URL('../prepare-bundle.mjs',import.meta.url).pathname}));
});
