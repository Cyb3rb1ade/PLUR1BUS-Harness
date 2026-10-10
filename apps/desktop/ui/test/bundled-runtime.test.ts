import {test} from "node:test";
import assert from "node:assert/strict";
import {withShell} from "./browser-harness.ts";
test("bundled wizard completes four actions with a runtime and retains 400px layout",async()=>{
 await withShell(async page=>{
  await page.addInitScript(()=>{(window as any).__fixtureBoot={bundled:true};});await page.reload();
  await page.getByRole("button",{name:"Set up a local harness",exact:true}).click();
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  assert.equal(await page.getByRole("button",{name:"Continue",exact:true}).isEnabled(),false);
  await page.getByRole("checkbox",{name:"I agree to the licences"}).check();
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await page.getByRole("radio").waitFor();await page.getByRole("button",{name:"Continue",exact:true}).click();
  await page.getByRole("button",{name:"Open PLUR1BUS",exact:true}).waitFor();
  for(const width of [400,960,1024,1601,2560]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),`overflow at ${width}`);}
  await page.getByRole("button",{name:"Open PLUR1BUS",exact:true}).click();
 });
});
test("runtime settings and wizard have no serious axe violations in platform themes",async()=>{
 await withShell(async page=>{
  await page.addScriptTag({url:"/axe.js"});
  for(const platform of ["mac","win","gnome","kde"]){
   for(const theme of ["light","dark"] as const){
    await page.emulateMedia({colorScheme:theme});
    await page.addInitScript(({platform})=>{(window as any).__fixtureBoot={bundled:true,platform};},{platform});await page.reload();await page.addScriptTag({url:"/axe.js"});
    await page.evaluate(()=>(window as any).testShell.navigate("settings","runtime"));
    const violations=await page.evaluate(async()=>{const report=await (window as any).axe.run();return report.violations.filter((v:any)=>["serious","critical"].includes(v.impact)).map((v:any)=>v.id);});assert.deepEqual(violations,[],`${platform}/${theme}`);
    await page.evaluate(()=>(window as any).testShell.navigate("home"));await page.getByRole("button",{name:"Set up a local harness",exact:true}).click();
    const wizard=await page.evaluate(async()=>{const report=await (window as any).axe.run();return report.violations.filter((v:any)=>["serious","critical"].includes(v.impact)).map((v:any)=>v.id);});assert.deepEqual(wizard,[],`wizard ${platform}/${theme}`);
   }
  }
 });
});
