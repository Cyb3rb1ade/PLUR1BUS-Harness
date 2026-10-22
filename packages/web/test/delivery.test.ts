import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, browserSkip, withApp, openRoute } from './harness.ts';
import { expectAxeClean } from './axe.ts';
before(setup);after(teardown);
for(const locale of ['en','de'] as const)test(`delivery destinations and validated selector (${locale})`,{skip:browserSkip},async()=>{
 await withApp({locale:locale==='de'?'de-DE':'en-US'},async app=>{
  const identity={channel:'telegram',accountId:'bot',userId:'sender'};
  app.server.rpc.handle('delivery.target.list',()=>({identities:[identity],targets:[{id:'good',person:'alice',identity,chatId:'dm',validated:true,createdAt:0},{id:'pending',person:'alice',identity:{...identity,userId:'pending'},chatId:'dm2',validated:false,createdAt:0}]}),{write:false});
  app.server.rpc.handle('jobs.list',()=>({jobs:[],manageableAgents:['main']}),{write:false});
  await openRoute(app.page,'#/recurring',locale);
  await app.page.getByRole('heading',{name:locale==='de'?'Zustellziele':'Delivery destinations',exact:true}).waitFor();
  await app.page.getByRole('button',{name:locale==='de'?'Wiederkehrende Aufgabe anlegen':'Create recurring task',exact:true}).click();
  const select=app.page.locator('#job-delivery');await select.locator('option[value=good]').waitFor({state:'attached'});assert.equal(await select.locator('option[value=pending]').count(),0);
  await expectAxeClean(app.page, "delivery");
 });
});
