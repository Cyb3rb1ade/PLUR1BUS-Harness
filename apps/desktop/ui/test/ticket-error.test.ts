import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('ticket failure is accessible, responsive, and has 44px Retry and Copy log controls',async()=>{
  const routes:Record<string,{kind:string,bytes:Buffer}>={};
  for(const [url,name,kind] of [['/','ticket-error.html','text/html'],['/__shell/error.css','ticket-error.css','text/css'],['/__shell/error.js','ticket-error.js','text/javascript']] as const)routes[url]={kind,bytes:readFileSync(new URL('../src/views/'+name,import.meta.url))};
  const server=createServer((req,res)=>{const url=new URL(req.url??'/', 'http://test');const asset=routes[url.pathname];if(!asset){res.writeHead(404).end();return}res.setHeader('content-type',asset.kind);res.end(url.pathname==='/'?asset.bytes.toString().replace('data-theme="system"',`data-theme="${url.searchParams.get('theme')??'system'}"`).replace('data-locale="system"',`data-locale="${url.searchParams.get('locale')??'system'}"`):asset.bytes);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');
  const browser=await chromium.launch({headless:true});
  try {for(const [theme,locale,savedTheme,savedLocale] of [['light','en','system','system'],['light','de','system','system'],['dark','en','system','system'],['dark','de','system','system'],['dark','de','light','en'],['light','en','dark','de']] as const){
    const page=await browser.newPage({colorScheme:theme,locale});await page.goto(`http://127.0.0.1:${address.port}/?theme=${savedTheme}&locale=${savedLocale}`);assert.equal(await page.locator('html').getAttribute('lang'),savedLocale==='system'?locale:savedLocale);assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).colorScheme),savedTheme==='system'?theme:savedTheme);await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
    const axe=await page.evaluate(async()=>(window as any).axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));assert.deepEqual(axe.violations,[]);
    for(const width of [400,720,960,1440,2560]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));for(const locator of [page.locator('#copy'),page.locator('#retry')]){const box=await locator.boundingBox();assert(box&&box.width>=44&&box.height>=44);}}
    await page.keyboard.press('Tab');assert.equal(await page.locator('#copy').evaluate(el=>el===document.activeElement),true);await page.keyboard.press('Tab');assert.equal(await page.locator('#retry').evaluate(el=>el===document.activeElement),true);await page.close();
  }}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
