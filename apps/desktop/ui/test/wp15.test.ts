import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withShell} from './browser-harness.ts';
import en from '../src/i18n/en.json' with {type:'json'};
import de from '../src/i18n/de.json' with {type:'json'};

test('crash, ticket failure and updater messages belong to the shared catalogues',()=>{
 for(const key of ['crash.title','ticket.title','update.title','update.view','update.intermediate']) {
  assert.ok((en as Record<string,string>)[key],key);
  assert.ok((de as Record<string,string>)[key],key);
 }
});

test('later Desktop views pass axe and reflow in both themes/locales, with keyboard-accessible dialogs',async()=>{
 await withShell(async page=>{
  await page.addScriptTag({url:'/axe.js'});
  for(const theme of ['light','dark'])for(const locale of ['en','de']) {
   await page.evaluate(async prefs=>{await(window as any).testShell.setPreferences(prefs);}, {theme,locale});
   for(const view of ['updates','store','version','recovery','approvals','crash','quit']) {
    await page.evaluate(({view,locale})=>{
     const s=(window as any).testShell;
     if(view==='updates'||view==='store')s.showUpdates(view==='store');
     if(view==='version')s.showVersion();
     if(view==='recovery')s.showRecovery();
     if(view==='approvals')s.showApprovals([{id:'fixture',capability:'fs.read',effect:'read',targets:['/synthetic'],risk:'low',reversible:true,grantOptions:['once'],actionHash:'sha256:synthetic',reason:'synthetic'}],locale);
     if(view==='crash')s.openCrash();
     if(view==='quit')s.openQuit();
    },{view,locale});
    if(view==='updates'||view==='store')await page.getByRole('button',{name:locale==='de'?'0.1.1 ansehen':'View 0.1.1',exact:true}).waitFor();
    if(view==='version'||view==='recovery')await page.getByText('0.1.1',{exact:true}).first().waitFor();
    for(const width of [400,960,1440,2560]) {
     await page.setViewportSize({width,height:900});
     assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${view} ${width} ${theme}/${locale}`);
    }
    const violations=await page.evaluate(async()=>{const r=await(window as any).axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}});return r.violations.map((v:any)=>({id:v.id,targets:v.nodes.map((n:any)=>n.target)}));});
    assert.deepEqual(violations,[],`${view} ${theme}/${locale}`);
    if(view==='crash'||view==='quit') {
     await page.keyboard.press('Tab');
     assert.equal(await page.locator('dialog :focus-visible').count(),1,view);
     if(view==='crash')await page.getByRole('button',{name:locale==='de'?'Schließen':'Dismiss',exact:true}).click();
     else await page.keyboard.press('Escape');
     await page.locator('dialog').waitFor({state:'detached'});
    }
    if(view==='updates'||view==='store') {
     await page.getByRole('button',{name:locale==='de'?'0.1.1 ansehen':'View 0.1.1',exact:true}).click();
     await page.keyboard.press('Tab');
     assert.equal(await page.locator('dialog :focus-visible').count(),1);
     const r=await page.evaluate(async()=>(await(window as any).axe.run(document.querySelector('dialog'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map((v:any)=>v.id));
     assert.deepEqual(r,[],`update offer ${theme}/${locale}`);
     await page.keyboard.press('Escape');
    }
   }
  }
 });
});

test('remote pairing, every wizard step and runtime controls pass WCAG in both themes/locales',async()=>{
 await withShell(async page=>{
  await page.addInitScript(()=>{(window as any).__fixtureBoot={bundled:true};});
  for(const theme of ['light','dark'])for(const locale of ['en','de']) {
   await page.reload();await page.getByRole('navigation').waitFor();await page.addScriptTag({url:'/axe.js'});
   await page.evaluate(async prefs=>{await(window as any).testShell.setPreferences(prefs);(window as any).testShell.navigate('connections');},{theme,locale});
   await page.getByRole('button',{name:locale==='de'?'Remote hinzufügen':'Add remote',exact:true}).click();
   const check=async(context:string)=>{
    const r=await page.evaluate(async()=>(await(window as any).axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}})).violations.map((v:any)=>({id:v.id,targets:v.nodes.map((n:any)=>n.target)})));
    assert.deepEqual(r,[],`${context} ${theme}/${locale}`);
    for(const width of [400,960,1440,2560]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),context);}
   };
   await check('pairing');await page.keyboard.press('Escape');
   await page.evaluate(()=>(window as any).testShell.navigate('settings','runtime'));await check('runtime');
   await page.evaluate(()=>(window as any).testShell.navigate('home'));
   await page.getByRole('button',{name:locale==='de'?'Lokalen Harness einrichten':'Set up a local harness',exact:true}).click();
   await check('wizard welcome');
   const next=()=>page.getByRole('button',{name:locale==='de'?'Weiter':'Continue',exact:true});
   await next().click();await check('wizard licences');
   await page.getByRole('checkbox').check();await next().click();await page.getByRole('radio').waitFor();await check('wizard runtime');
   await next().click();await page.getByRole('button',{name:locale==='de'?'PLUR1BUS öffnen':'Open PLUR1BUS',exact:true}).waitFor();await check('wizard ready');
  }
 });
});

test('200% display reflow, upgrade outcomes and rollback modal retain accessible keyboard controls',async()=>{
 await withShell(async page=>{
  assert.deepEqual(await page.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio})),{width:720,dpr:2});
  await page.addScriptTag({url:'/axe.js'});
  for(const theme of ['light','dark'])for(const locale of ['en','de']) {
   await page.evaluate(async prefs=>{await(window as any).testShell.setPreferences(prefs);},{theme,locale});
   for(const sample of [
    {step:'gating',outcome:null},
    {step:'done',outcome:{state:'upgraded',to:'0.1.1'}},
    {step:'rolledBack',outcome:{state:'rolledBack',from:'0.1.0',to:'0.1.1',failed_step:'gating'}},
    {step:'recoveryFailed',outcome:{state:'recoveryFailed',diagnostic:'synthetic diagnostic'}},
   ]) {
    await page.evaluate(({step,outcome})=>(window as any).testShell.showProgress(step,outcome),sample);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const r=await page.evaluate(async()=>(await(window as any).axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map((v:any)=>v.id));
    assert.deepEqual(r,[],`${sample.step} ${theme}/${locale}`);
   }
   await page.evaluate(()=>(window as any).testShell.showVersion());
   await page.getByRole('button',{name:locale==='de'?'Zurück zu 0.1.0':'Go back to 0.1.0'}).click();
   await page.keyboard.press('Shift+Tab');
   assert.equal(await page.locator('dialog :focus-visible').count(),1);
   await page.keyboard.press('Tab');
   assert.equal(await page.locator('dialog :focus-visible').count(),1);
   const r=await page.evaluate(async()=>(await(window as any).axe.run(document.querySelector('dialog'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map((v:any)=>v.id));
   assert.deepEqual(r,[],`rollback ${theme}/${locale}`);
   await page.keyboard.press('Escape');
   assert.equal(await page.getByRole('button',{name:locale==='de'?'Zurück zu 0.1.0':'Go back to 0.1.0'}).evaluate(el=>document.activeElement===el),true);
  }
 },{physicalWidth:1440,physicalHeight:900,scale:2});
});
